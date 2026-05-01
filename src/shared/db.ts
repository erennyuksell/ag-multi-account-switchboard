/**
 * Database Access Layer — SSOT for all state.vscdb interactions.
 * ═══════════════════════════════════════════════════════════════
 * ZERO vscode dependency — safe for both extension host AND
 * detached worker processes (ELECTRON_RUN_AS_NODE=1).
 *
 * Strategy: @vscode/sqlite3 native module (primary) → sqlite3 CLI (fallback)
 * The native module is bundled with AG IDE on ALL platforms (macOS, Linux, Windows).
 * CLI fallback exists for edge cases where the native binary isn't found.
 *
 * Consumers:
 * - titleResolver.ts    (read: trajectory summaries)
 * - emailResolver.ts    (read: auth status)
 * - conversationGuard.ts (read: trajectory index)
 * - conversationFix.ts  (read+write: index rebuild)
 * - accountSwitch.ts    (write: account switch)
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// ─── Lazy Imports (avoid circular deps) ──────────────────────────────

let _stateDbPath: string | undefined;
function getStateDbPath(): string {
    if (_stateDbPath !== undefined) return _stateDbPath;
    const { STATE_DB_PATH } = require('./agPaths');
    const resolved: string = STATE_DB_PATH || '';
    _stateDbPath = resolved;
    return resolved;
}

let _sqlite3Module: any = undefined; // undefined = not tried
function getNativeModule(): any {
    if (_sqlite3Module !== undefined) return _sqlite3Module;
    const { getSqlite3Module } = require('./agPaths');
    _sqlite3Module = getSqlite3Module();
    return _sqlite3Module;
}

// ─── Read: Single Row ────────────────────────────────────────────────

/**
 * Read a single value from state.vscdb by key.
 * Returns the raw string value or null if not found.
 */
export async function dbGet(key: string): Promise<string | null> {
    const dbPath = getStateDbPath();
    if (!dbPath) return null;

    // Primary: native module
    const result = await nativeGet(dbPath, key);
    if (result !== undefined) return result;

    // Fallback: CLI
    return cliGet(dbPath, key);
}

/**
 * Read raw buffer/string from a specific SQL query.
 * For advanced queries beyond simple key lookup.
 */
export async function dbQuery(sql: string): Promise<string | null> {
    const dbPath = getStateDbPath();
    if (!dbPath) return null;

    const result = await nativeQuery(dbPath, sql);
    if (result !== undefined) return result;

    return cliQuery(dbPath, sql);
}

// ─── Write ───────────────────────────────────────────────────────────

/**
 * Execute a write SQL statement against state.vscdb.
 * Creates a timestamped backup before writing.
 * Fire-and-forget: errors are logged, never thrown.
 */
export async function dbExec(sql: string): Promise<boolean> {
    const dbPath = getStateDbPath();
    if (!dbPath) return false;

    // Backup before write
    createBackup(dbPath);

    // Primary: native module
    const nativeOk = await nativeExec(dbPath, sql);
    if (nativeOk !== undefined) return nativeOk;

    // Fallback: CLI
    return cliExec(dbPath, sql);
}

/**
 * Execute a write SQL with a pre-escaped value (for large base64 blobs).
 * Used by conversationFix which handles its own SQL construction.
 */
export async function dbExecRaw(sql: string): Promise<boolean> {
    const dbPath = getStateDbPath();
    if (!dbPath) return false;
    createBackup(dbPath);

    const nativeOk = await nativeExec(dbPath, sql);
    if (nativeOk !== undefined) return nativeOk;

    return cliExecViaTmpFile(dbPath, sql);
}

// ─── Availability Check ──────────────────────────────────────────────

/**
 * Check if any DB backend (native or CLI) is available.
 * Replaces the old `sqlite3 --version` CLI check.
 */
export function isDbAvailable(): boolean {
    if (getNativeModule()) return true;
    // CLI check
    try {
        const cp = require('child_process');
        cp.execSync('sqlite3 --version', { timeout: 3000, stdio: 'pipe' });
        return true;
    } catch { return false; }
}

// ─── Backup Utilities ────────────────────────────────────────────────

function createBackup(dbPath: string): void {
    try {
        if (fs.existsSync(dbPath)) {
            const backupPath = `${dbPath}.ag-backup-${Date.now()}`;
            fs.copyFileSync(dbPath, backupPath);
        }
    } catch { /* best-effort */ }
}

const BACKUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Remove stale backups older than maxAgeMs (default: 7 days).
 * Call opportunistically — never throws.
 */
export function pruneOldBackups(maxAgeMs = BACKUP_MAX_AGE_MS): void {
    const dbPath = getStateDbPath();
    if (!dbPath) return;
    const dir = path.dirname(dbPath);
    try {
        const now = Date.now();
        fs.readdirSync(dir)
            .filter(f => f.startsWith(path.basename(dbPath) + '.ag-backup-'))
            .forEach(f => {
                const full = path.join(dir, f);
                const ts = parseInt(f.split('.ag-backup-')[1], 10);
                if (!isNaN(ts) && now - ts > maxAgeMs) {
                    fs.unlinkSync(full);
                }
            });
    } catch { /* best-effort */ }
}

// ═══════════════════════════════════════════════════════════════
// Native Module Implementation (@vscode/sqlite3)
// ═══════════════════════════════════════════════════════════════

function nativeGet(dbPath: string, key: string): Promise<string | null | undefined> {
    return new Promise((resolve) => {
        const sqlite3 = getNativeModule();
        if (!sqlite3) { resolve(undefined); return; }

        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err: any) => {
            if (err) { resolve(undefined); return; }
            db.get(
                'SELECT value FROM ItemTable WHERE key = ?', [key],
                (err: any, row: any) => {
                    db.close();
                    if (err) { resolve(undefined); return; }
                    resolve(row?.value ?? null);
                }
            );
        });
    });
}

function nativeQuery(dbPath: string, sql: string): Promise<string | null | undefined> {
    return new Promise((resolve) => {
        const sqlite3 = getNativeModule();
        if (!sqlite3) { resolve(undefined); return; }

        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err: any) => {
            if (err) { resolve(undefined); return; }
            db.get(sql, (err: any, row: any) => {
                db.close();
                if (err) { resolve(undefined); return; }
                if (!row) { resolve(null); return; }
                // Return first column value
                const keys = Object.keys(row);
                resolve(keys.length > 0 ? row[keys[0]] : null);
            });
        });
    });
}

function nativeExec(dbPath: string, sql: string): Promise<boolean | undefined> {
    return new Promise((resolve) => {
        const sqlite3 = getNativeModule();
        if (!sqlite3) { resolve(undefined); return; }

        const db = new sqlite3.Database(dbPath, (err: any) => {
            if (err) { resolve(undefined); return; }
            db.run(sql, (err: any) => {
                db.close();
                resolve(err ? false : true);
            });
        });
    });
}

// ═══════════════════════════════════════════════════════════════
// CLI Fallback Implementation (sqlite3 binary)
// ═══════════════════════════════════════════════════════════════

const TIMEOUT = 5000;
const MAX_BUFFER = 10 * 1024 * 1024;

function cliGet(dbPath: string, key: string): Promise<string | null> {
    const sql = `SELECT value FROM ItemTable WHERE key='${key.replace(/'/g, "''")}'`;
    return cliQuery(dbPath, sql);
}

function cliQuery(dbPath: string, sql: string): Promise<string | null> {
    return new Promise((resolve) => {
        try {
            const cp = require('child_process');
            cp.exec(
                `sqlite3 "${dbPath}" "${sql.replace(/"/g, '\\"')}"`,
                { timeout: TIMEOUT, maxBuffer: MAX_BUFFER },
                (err: any, stdout: string) => {
                    if (err || !stdout.trim()) { resolve(null); return; }
                    resolve(stdout.trim());
                }
            );
        } catch { resolve(null); }
    });
}

function cliExec(dbPath: string, sql: string): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            const cp = require('child_process');
            const escaped = sql.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            cp.exec(
                `sqlite3 "${dbPath}" "${escaped}"`,
                { timeout: TIMEOUT },
                (err: any) => resolve(!err)
            );
        } catch { resolve(false); }
    });
}

function cliExecViaTmpFile(dbPath: string, sql: string): Promise<boolean> {
    return new Promise((resolve) => {
        const tmpFile = path.join(os.tmpdir(), `ag-db-exec-${Date.now()}.tmp`);
        try {
            const cp = require('child_process');
            const isWindows = process.platform === 'win32';
            fs.writeFileSync(tmpFile, sql, 'utf8');
            cp.exec(
                `sqlite3 "${dbPath}" < "${tmpFile}"`,
                { timeout: 30000, maxBuffer: 50 * 1024 * 1024, shell: isWindows ? 'cmd.exe' : '/bin/sh' },
                (err: any) => {
                    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
                    resolve(!err);
                }
            );
        } catch {
            try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
            resolve(false);
        }
    });
}
