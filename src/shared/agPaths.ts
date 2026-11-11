/**
 * AG Platform Paths — SSOT for Antigravity filesystem locations.
 * ═══════════════════════════════════════════════════════════════
 * ZERO vscode dependency — safe for both extension host AND
 * detached worker processes (ELECTRON_RUN_AS_NODE=1).
 *
 * All other modules should import paths from here, not re-define them.
 *
 * ─── Rebrand awareness ───
 * Antigravity 2.5.x renamed every install location:
 *
 *   app bundle    Antigravity.app          → Antigravity IDE.app
 *   support dir   .../Antigravity          → .../Antigravity IDE
 *   data dir      ~/.gemini/antigravity    → ~/.gemini/antigravity-ide
 *
 * (the data dir name is also visible as the LS's --app_data_dir argument).
 * Builds up to 2.0.x keep the unsuffixed names, and a machine can carry both
 * installs side by side. Layout is therefore resolved at runtime rather than
 * hardcoded, so old and new versions are both supported.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// ─── Platform Flags ──────────────────────────────────────────────────
export const isMac = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';
export const isWindows = process.platform === 'win32';

// ─── Install Layout Profiles ─────────────────────────────────────────

/** One Antigravity install layout (naming scheme for app, support dir and data dir). */
export interface AgProfile {
    /** Application bundle / support directory name, e.g. "Antigravity IDE" */
    appName: string;
    /** ~/.gemini subdirectory name, e.g. "antigravity-ide" */
    dataDirName: string;
}

/** Known layouts, newest first. */
const AG_PROFILES: readonly AgProfile[] = [
    { appName: 'Antigravity IDE', dataDirName: 'antigravity-ide' },  // 2.5.x and later
    { appName: 'Antigravity', dataDirName: 'antigravity' },          // 2.0.x and earlier
];

function dataDirOf(p: AgProfile): string {
    return path.join(os.homedir(), '.gemini', p.dataDirName);
}

function supportDirOf(p: AgProfile): string {
    if (isMac) return path.join(os.homedir(), 'Library', 'Application Support', p.appName);
    if (isLinux) return path.join(os.homedir(), '.config', p.appName);
    if (isWindows) {
        const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, p.appName);
    }
    return '';
}

/** Candidate application roots for a profile (where resources/app lives). */
function appRootsOf(p: AgProfile): string[] {
    if (isMac) return [`/Applications/${p.appName}.app/Contents/Resources/app`];
    if (isLinux) {
        return [
            `/opt/${p.dataDirName}/resources/app`,
            path.join(os.homedir(), '.local', 'share', p.dataDirName, 'resources', 'app'),
        ];
    }
    if (isWindows) {
        const localApp = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
        return [path.join(localApp, 'Programs', p.appName, 'resources', 'app')];
    }
    return [];
}

function mtimeOf(p: string): number {
    try { return fs.statSync(p).mtimeMs; } catch { return -1; }
}

/**
 * Newest real entry inside a marker directory, or -1 if there is none.
 *
 * Deliberately not the directory's own mtime: this extension writes its stats
 * cache and lock file into brain/, so once detection lands on the wrong layout
 * its own writes push that directory's timestamp above the live one and pin the
 * mistake in place. Dot-entries are skipped for the same reason — they are ours,
 * not Antigravity's, and say nothing about which install is in use.
 */
function newestEntryMtime(dir: string): number {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return -1; }

    let newest = -1;
    for (const name of names) {
        if (name.startsWith('.')) continue;
        const m = mtimeOf(path.join(dir, name));
        if (m > newest) newest = m;
    }
    return newest;
}

function exists(p: string): boolean {
    return !!p && fs.existsSync(p);
}

/**
 * Pick the layout this machine is actually running.
 *
 * The app/support-dir name and the data-dir name are resolved separately,
 * because 2.6 mixed them: it kept the "Antigravity IDE" app and support dir
 * but moved data back to ~/.gemini/antigravity (its hubs run with
 * --app_data_dir=antigravity, and it migrated the 2.5 data dir there).
 *
 * Data dir, in order of evidence:
 *   1. AG_PANEL_PROFILE env var — escape hatch ("antigravity-ide" | "antigravity")
 *   2. Freshest `conversations/` directory. Antigravity owns that directory and
 *      we never write to it, so its mtime is an uncontaminated liveness signal
 *      (unlike `brain/`, where our own stats cache lands).
 *   3. Freshest `brain/` directory, for installs with no conversations yet.
 *   4. Newest layout.
 *
 * App name: the support dir whose state.vscdb was written last (every running
 * IDE writes it continuously), then whichever app bundle is installed.
 */
function resolveDataDirName(): string {
    const override = process.env.AG_PANEL_PROFILE?.trim();
    if (override) {
        const hit = AG_PROFILES.find(p => p.dataDirName === override || p.appName === override);
        if (hit) return hit.dataDirName;
    }
    for (const marker of ['conversations', 'brain']) {
        let best: { name: string; mtime: number } | null = null;
        for (const p of AG_PROFILES) {
            const m = newestEntryMtime(path.join(dataDirOf(p), marker));
            if (m < 0) continue;
            if (!best || m > best.mtime) best = { name: p.dataDirName, mtime: m };
        }
        if (best) return best.name;
    }
    return AG_PROFILES[0].dataDirName;
}

function resolveAppName(): string {
    const override = process.env.AG_PANEL_PROFILE?.trim();
    if (override) {
        const hit = AG_PROFILES.find(p => p.dataDirName === override || p.appName === override);
        if (hit) return hit.appName;
    }
    let best: { name: string; mtime: number } | null = null;
    for (const p of AG_PROFILES) {
        const m = mtimeOf(path.join(supportDirOf(p), 'User', 'globalStorage', 'state.vscdb'));
        if (m < 0) continue;
        if (!best || m > best.mtime) best = { name: p.appName, mtime: m };
    }
    if (best) return best.name;
    const installed = AG_PROFILES.find(p => appRootsOf(p).some(exists) || exists(supportDirOf(p)));
    return (installed ?? AG_PROFILES[0]).appName;
}

function resolveProfile(): AgProfile {
    return { appName: resolveAppName(), dataDirName: resolveDataDirName() };
}

/** The install layout in use. Resolved once at load — installs don't move mid-session. */
export const AG_PROFILE: AgProfile = resolveProfile();

/** Application/support directory name of the active install, e.g. "Antigravity IDE" */
export const AG_APP_NAME = AG_PROFILE.appName;

// ─── Antigravity Application Paths ───────────────────────────────────

/** Root of Antigravity's per-user data (conversations, brain, annotations) */
export const AG_DATA_DIR = dataDirOf(AG_PROFILE);

/** Path to Antigravity's local state SQLite DB (conversation index, active account, etc.) */
export const STATE_DB_PATH = supportDirOf(AG_PROFILE)
    ? path.join(supportDirOf(AG_PROFILE), 'User', 'globalStorage', 'state.vscdb')
    : '';

/** Directory containing conversation .pb protobuf files */
export const CONVERSATIONS_DIR = path.join(AG_DATA_DIR, 'conversations');

/** Directory containing conversation brain data (transcripts, artifacts) */
export const BRAIN_DIR = path.join(AG_DATA_DIR, 'brain');

/**
 * Candidate application roots, active layout first then the others.
 * Kept as a list so a mis-resolved profile still degrades to a working path.
 */
const AG_APP_ROOT_CANDIDATES: string[] = [
    ...appRootsOf(AG_PROFILE),
    ...AG_PROFILES.filter(p => p !== AG_PROFILE).flatMap(appRootsOf),
];

/** Ordered list of candidate cert paths for the local language server */
export const LS_CERT_PATHS: string[] = AG_APP_ROOT_CANDIDATES.map(
    root => path.join(root, 'extensions', 'antigravity', 'dist', 'languageServer', 'cert.pem'),
);

/** Candidate launch targets for relaunching the IDE, active layout first */
export const AG_APP_LAUNCH_CANDIDATES: string[] = isMac
    ? [AG_PROFILE, ...AG_PROFILES.filter(p => p !== AG_PROFILE)].map(p => `/Applications/${p.appName}.app`)
    : isWindows
        ? [AG_PROFILE, ...AG_PROFILES.filter(p => p !== AG_PROFILE)].flatMap(p => {
            const localApp = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
            return [
                path.join(localApp, 'Programs', p.appName, `${p.appName}.exe`),
                path.join(localApp, p.appName, `${p.appName}.exe`),
                path.join(os.homedir(), `.${p.dataDirName}`, `${p.appName}.exe`),
            ];
        })
        : [AG_PROFILE, ...AG_PROFILES.filter(p => p !== AG_PROFILE)].flatMap(p => [
            path.join(os.homedir(), `.${p.dataDirName}`, p.dataDirName, 'bin', p.dataDirName),
            `/opt/${p.dataDirName}/bin/${p.dataDirName}`,
        ]);

/** grep pattern to find the LS binary in `ps` output */
export const LS_PROCESS_GREP = isMac
    ? 'language_server_macos'
    : isLinux
        ? 'language_server_linux'
        : isWindows
            ? 'language_server_win'
            : 'language_server';

/**
 * Antigravity 2.6+ runs one agent hub per window (`~/.gemini/bin/agy --hub`)
 * instead of the language server binary. It serves the same
 * LanguageServerService RPCs, so discovery treats both as servers.
 */
export const HUB_PROCESS_MARK = 'agy --hub';
/**
 * Windows command lines name the binary agy.exe, so 'agy --hub' does not
 * match there; every hub carries this flag.
 */
export const WIN_HUB_MARK = '--hub-port';
/** Extended-regex alternative for `grep -E` covering both generations. */
export const SERVER_PROCESS_GREP_E = `${LS_PROCESS_GREP}|${HUB_PROCESS_MARK}`;

/**
 * Drop hubs whose window is gone from `ps -o pid,ppid,args` lines.
 *
 * A hub can outlive its window: launchd adopts it and it keeps answering
 * (measured 2026-11-01: 7 hubs for 3 windows). Only a window's extension
 * restarts a hub, so an adopted one stays on its old account forever. Counted
 * as a server, it held every switch until the timeout, and it can also pass
 * for the live hub of the same folder.
 */
export function withoutOrphanHubs(lines: string[]): string[] {
    return lines.filter(line => {
        const isHub = line.includes(HUB_PROCESS_MARK) || line.includes(WIN_HUB_MARK);
        if (!isHub) return true;
        // On macOS/Linux ps -A -ww -o pid,ppid,args puts ppid in column 2.
        // A ppid of 1 indicates an orphaned process adopted by init/launchd.
        const ppid = line.trim().match(/^\d+\s+(\d+)\s/)?.[1];
        return ppid !== '1';
    });
}

/**
 * Workspace id of a server process, in the IDE's `file_Users_x_repo` form.
 * Language servers carry it as --workspace_id; hubs only name the folder
 * (--add-dir=/Users/x/repo), so derive the same form from the path.
 */
export function workspaceIdFromArgs(line: string): string | undefined {
    const ws = line.match(/--workspace_id[\s=]+(\S+)/)?.[1];
    if (ws) return ws;
    const dir = line.match(/--add-dir[\s=]+(\S+)/)?.[1];
    if (!dir) return undefined;
    // Windows: R:\scraper → file_r_3A_scraper, the form the IDE uses there
    // (seen in a 2.5.5 report on #10: the drive letter lowercased, ':' as _3A_).
    const drive = dir.match(/^([A-Za-z]):[\\/](.*)$/);
    if (drive) return `file_${drive[1].toLowerCase()}_3A_` + drive[2].replace(/[\\/]/g, '_').replace(/-/g, '_');
    return 'file_' + dir.replace(/\\/g, '/').replace(/\//g, '_').replace(/^_/, '').replace(/-/g, '_');
}

// ─── @vscode/sqlite3 Native Module Resolution ───────────────────────

let _sqlite3Cache: any = undefined; // undefined = not tried, null = failed, object = module

/**
 * Resolve and cache the @vscode/sqlite3 native module bundled with AG IDE.
 * Tries vscode.env.appRoot first (when called from extension host), then the
 * candidate roots for every known layout.
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
