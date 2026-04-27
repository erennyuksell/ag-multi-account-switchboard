import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { STATE_DB_PATH, SQLITE_EXEC_TIMEOUT_MS, BACKUP_MAX_AGE_MS } from '../constants';
import { createLogger } from './logger';

const execAsync = promisify(exec);
const log = createLogger('DbWriter');

/**
 * Write a SQL statement to Antigravity's state.vscdb.
 *
 * Safety guarantees:
 *  - Creates a timestamped .ag-backup-<ts> copy BEFORE writing
 *  - Uses `sqlite3 <path> "<sql>"` argument form (cross-platform — no shell pipe)
 *  - Fire-and-forget: errors are logged but never thrown (DB write is non-critical)
 *
 * Cross-platform notes:
 *  - macOS/Linux: sqlite3 is available via system or Homebrew
 *  - Windows: requires sqlite3.exe in PATH; if absent, write is skipped gracefully
 */
export async function writeToStateDb(sql: string): Promise<void> {
    if (!STATE_DB_PATH) {
        log.warn('STATE_DB_PATH is empty for this platform — skipping DB write');
        return;
    }

    // ── 1. Backup ──────────────────────────────────────────────────────────────
    const backupPath = `${STATE_DB_PATH}.ag-backup-${Date.now()}`;
    try {
        if (fs.existsSync(STATE_DB_PATH)) {
            fs.copyFileSync(STATE_DB_PATH, backupPath);
            log.info(`DB backed up → ${path.basename(backupPath)}`);
        }
    } catch (err: any) {
        log.warn('DB backup failed (continuing):', err?.message);
    }

    // ── 2. Write ───────────────────────────────────────────────────────────────
    // Pass SQL as CLI argument instead of pipe — works on macOS, Linux, Windows.
    // Double-quotes inside the SQL must be escaped for the shell.
    const escapedSql = sql.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    try {
        await execAsync(`sqlite3 "${STATE_DB_PATH}" "${escapedSql}"`, { timeout: SQLITE_EXEC_TIMEOUT_MS });
        log.info('DB write OK');
    } catch (err: any) {
        log.warn('DB write failed (non-critical):', err?.message);
    }
}

/**
 * Remove stale backups older than `maxAgeMs` (default: 7 days).
 * Call opportunistically — never throws.
 */
export function pruneOldBackups(maxAgeMs = BACKUP_MAX_AGE_MS): void {
    if (!STATE_DB_PATH) return;
    const dir = path.dirname(STATE_DB_PATH);
    try {
        const now = Date.now();
        fs.readdirSync(dir)
            .filter(f => f.startsWith(path.basename(STATE_DB_PATH) + '.ag-backup-'))
            .forEach(f => {
                const full = path.join(dir, f);
                const ts = parseInt(f.split('.ag-backup-')[1], 10);
                if (!isNaN(ts) && now - ts > maxAgeMs) {
                    fs.unlinkSync(full);
                    log.info(`Pruned old backup: ${f}`);
                }
            });
    } catch { /* best-effort */ }
}
