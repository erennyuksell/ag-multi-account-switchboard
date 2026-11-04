/**
 * AG Platform Paths — SSOT for Antigravity filesystem locations.
 * ═══════════════════════════════════════════════════════════════
 * ZERO vscode dependency — safe for both extension host AND
 * detached worker processes (ELECTRON_RUN_AS_NODE=1).
 *
 * Supports both the legacy Antigravity profile and the newer
 * "Antigravity IDE" (2.6+) profile layout. All other modules should
 * import paths from here, not re-define them.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Platform Flags ──────────────────────────────────────────────────
export const isMac = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';
export const isWindows = process.platform === 'win32';

// ─── Path Helpers ────────────────────────────────────────────────────

/** Return the first existing path, or undefined when none exist. */
function firstExisting(candidates: string[]): string | undefined {
    for (const candidate of candidates) {
        try { if (fs.existsSync(candidate)) return candidate; } catch { /* try next */ }
    }
    return undefined;
}

/** Max mtime across a set of paths — used to pick the active data profile. */
function freshness(paths: string[]): number {
    let newest = 0;
    for (const p of paths) {
        try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch { /* missing */ }
    }
    return newest;
}

// ─── Antigravity Application Paths ───────────────────────────────────

const APP_DATA_NAMES = ['Antigravity', 'Antigravity IDE'];

function userDataDirCandidates(): string[] {
    if (isMac) {
        return APP_DATA_NAMES.map(name => path.join(os.homedir(), 'Library', 'Application Support', name));
    }
    if (isLinux) {
        return APP_DATA_NAMES.map(name => path.join(os.homedir(), '.config', name));
    }
    if (isWindows) {
        const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
        return APP_DATA_NAMES.map(name => path.join(appData, name));
    }
    return [];
}

function pickUserDataDir(): string | undefined {
    const dirs = userDataDirCandidates();
    let best: string | undefined;
    let bestMtime = -1;
    for (const dir of dirs) {
        try {
            const stat = fs.statSync(path.join(dir, 'User', 'globalStorage', 'state.vscdb'));
            if (stat.mtimeMs > bestMtime) {
                best = dir;
                bestMtime = stat.mtimeMs;
            }
        } catch { /* not installed/used */ }
    }
    return best ?? firstExisting(dirs);
}

const USER_DATA_DIR = pickUserDataDir();

/**
 * Path to Antigravity's local state SQLite DB (conversation index, active account, etc.)
 * Newer builds live under "Antigravity IDE"; older builds under "Antigravity".
 */
export const STATE_DB_PATH = USER_DATA_DIR
    ? path.join(USER_DATA_DIR, 'User', 'globalStorage', 'state.vscdb')
    : '';

// ─── Gemini Data Profiles ────────────────────────────────────────────
//
// New Antigravity (2.6+) uses ~/.gemini/antigravity (hub --app_data_dir=antigravity).
// Legacy/previous installs used ~/.gemini/antigravity-ide. Pick the profile that
// was written to most recently, while still exposing both daemon dirs for discovery.

const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const DATA_DIR_NAMES = ['antigravity', 'antigravity-ide'];
const DATA_DIR_CANDIDATES = DATA_DIR_NAMES.map(name => path.join(GEMINI_DIR, name));

function pickActiveDataDir(): string {
    let best = DATA_DIR_CANDIDATES[0];
    let bestScore = -1;
    for (const dir of DATA_DIR_CANDIDATES) {
        const daemonDir = path.join(dir, 'daemon');
        const hubFiles: string[] = [];
        try {
            for (const entry of fs.readdirSync(daemonDir)) {
                if (entry.startsWith('hub_') && entry.endsWith('.json')) {
                    hubFiles.push(path.join(daemonDir, entry));
                }
            }
        } catch { /* no daemon dir */ }

        const score = freshness([
            path.join(dir, 'conversation_summaries.db'),
            path.join(dir, 'conversations'),
            path.join(dir, 'brain'),
            ...hubFiles,
        ]);
        if (score > bestScore) {
            best = dir;
            bestScore = score;
        }
    }
    return best;
}

/** Active Gemini data profile (new `antigravity` or legacy `antigravity-ide`). */
export const AG_DATA_DIR = pickActiveDataDir();

/** Directory containing conversation artifacts (.pb protobuf and .db SQLite files). */
export const CONVERSATIONS_DIR = path.join(AG_DATA_DIR, 'conversations');

/** Directory containing conversation brain data (transcripts, artifacts). */
export const BRAIN_DIR = path.join(AG_DATA_DIR, 'brain');

/** New-architecture sidebar index (SQLite). Missing on legacy installs. */
export const CONVERSATION_SUMMARIES_DB_PATH = path.join(AG_DATA_DIR, 'conversation_summaries.db');

/** All daemon directories that may contain hub_<port>.json discovery files. */
export const HUB_DISCOVERY_DIRS = DATA_DIR_CANDIDATES.map(dir => path.join(dir, 'daemon'));

/** .db is the 2.6+ format; .pb is legacy. */
const CONVERSATION_FILE_EXTENSIONS = ['.db', '.pb'] as const;
const CONVERSATION_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(pb|db)$/i;

/** Existing conversation file, preferring .db over .pb. */
export function getConversationFilePath(conversationId: string): string | null {
    for (const ext of CONVERSATION_FILE_EXTENSIONS) {
        const candidate = path.join(CONVERSATIONS_DIR, `${conversationId}${ext}`);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

/** Unique conversation IDs with a .pb or .db file on disk. */
export function listConversationIds(): string[] {
    try {
        const ids = fs.readdirSync(CONVERSATIONS_DIR)
            .map(file => file.match(CONVERSATION_FILE_RE)?.[1])
            .filter((id): id is string => !!id);
        return [...new Set(ids)];
    } catch { return []; }
}

/**
 * Newest mtime for a conversation across its data file and brain directory.
 * Returns 0 when no trace of the conversation exists.
 */
export function getConversationMtimeMs(conversationId: string): number {
    let newest = 0;
    for (const candidate of [getConversationFilePath(conversationId), path.join(BRAIN_DIR, conversationId)]) {
        if (!candidate) continue;
        try { newest = Math.max(newest, fs.statSync(candidate).mtimeMs); } catch { /* missing */ }
    }
    return newest;
}

/** Ordered list of candidate cert paths for the local language server */
export const LS_CERT_PATHS: string[] = isMac
    ? [
        '/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/dist/languageServer/cert.pem',
    ]
    : isLinux
        ? [
            '/opt/antigravity/resources/app/extensions/antigravity/dist/languageServer/cert.pem',
            path.join(os.homedir(), '.local', 'share', 'antigravity', 'resources', 'app', 'extensions', 'antigravity', 'dist', 'languageServer', 'cert.pem'),
        ]
        : isWindows
            ? [
                path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Antigravity', 'resources', 'app', 'extensions', 'antigravity', 'dist', 'languageServer', 'cert.pem'),
            ]
            : [];

/** grep pattern to find the LS binary in `ps` output (legacy discovery fallback) */
export const LS_PROCESS_GREP = isMac
    ? 'language_server_macos'
    : isLinux
        ? 'language_server_linux'
        : isWindows
            ? 'language_server_win'
            : 'language_server';

// ─── @vscode/sqlite3 Native Module Resolution ───────────────────────

/**
 * Candidate app root paths for locating @vscode/sqlite3.
 * Tried in order: vscode.env.appRoot (injected at runtime), then platform defaults.
 */
const AG_APP_ROOT_CANDIDATES: string[] = isMac
    ? [
        '/Applications/Antigravity IDE.app/Contents/Resources/app',
        '/Applications/Antigravity.app/Contents/Resources/app',
    ]
    : isLinux
        ? [
            '/opt/antigravity-ide/resources/app',
            '/opt/antigravity/resources/app',
            path.join(os.homedir(), '.local', 'share', 'antigravity', 'resources', 'app'),
        ]
        : isWindows
            ? [
                path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Antigravity IDE', 'resources', 'app'),
                path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Antigravity', 'resources', 'app'),
            ]
            : [];

let _sqlite3Cache: any = undefined; // undefined = not tried, null = failed, object = module

/**
 * Resolve and cache the @vscode/sqlite3 native module bundled with AG IDE.
 * Tries vscode.env.appRoot first (when called from extension host), then platform defaults.
 * Returns null if the module cannot be found.
 */
export function getSqlite3Module(appRoot?: string): any {
    if (_sqlite3Cache !== undefined) return _sqlite3Cache;

    const candidates = appRoot
        ? [appRoot, ...AG_APP_ROOT_CANDIDATES]
        : AG_APP_ROOT_CANDIDATES;

    for (const root of candidates) {
        try {
            _sqlite3Cache = require(path.join(root, 'node_modules', '@vscode', 'sqlite3'));
            return _sqlite3Cache;
        } catch { /* try next */ }
    }
    _sqlite3Cache = null;
    return null;
}
