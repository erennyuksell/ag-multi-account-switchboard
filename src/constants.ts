// Antigravity's own OAuth credentials (public, open-source)
export const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
export const CLIENT_SECRET = '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';

// Google OAuth endpoints
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

export const OAUTH_SCOPES = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
];

// Antigravity Cloud API endpoints (with fallback order)
export const QUOTA_API_ENDPOINTS = [
    'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
    'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
];

export const LOAD_CODE_ASSIST_ENDPOINTS = [
    'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
];

// Model filter keywords — only show quota for these families
export const IMPORTANT_MODELS = ['gemini', 'claude'];

// Secrets storage key prefix
export const SECRETS_PREFIX = 'ag.account.';
export const ACCOUNTS_LIST_KEY = 'ag.trackedAccounts';

// User-Agent for API requests
export const USER_AGENT = 'Antigravity/4.1.29 Chrome/132.0.6834.160 Electron/39.2.3';

/** Minimum UI refresh polling interval */
export const POLL_INTERVAL_MS = 60 * 1000;
export const TOKEN_REFRESH_BUFFER_SECS = 300; // refresh 5 min before expiry
export const OAUTH_CALLBACK_TIMEOUT_MS = 120_000; // 2 min

// ─── Timeouts ───

/** Language Server endpoint request timeout */
export const LS_REQUEST_TIMEOUT_MS = 10_000;
/** Default timeout for LS JSON/proto calls */
export const DEFAULT_LS_TIMEOUT_MS = 8_000;
/** Timeout for process listing (ps/lsof) exec calls */
export const PROCESS_EXEC_TIMEOUT_MS = 8_000;
/** Timeout for Windows WMIC exec calls */
export const WMIC_EXEC_TIMEOUT_MS = 5_000;
/** Timeout for lsof port discovery */
export const LSOF_EXEC_TIMEOUT_MS = 5_000;
/** Timeout for cascade probe during server discovery */
export const CASCADE_PROBE_TIMEOUT_MS = 3_000;
/** SQLite CLI execution timeout */
export const SQLITE_EXEC_TIMEOUT_MS = 5_000;
/** Token renewal retry delay on transient failure */
export const RENEWAL_RETRY_DELAY_MS = 2 * 60_000;

// ─── Thresholds ───

/** Bytes to read from file header for binary detection */
export const FILE_HEADER_READ_BYTES = 256;
/** Backup file max age before pruning (7 days) */
export const BACKUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// ─── UI Constants (re-exported from shared/uiConstants for backward compat) ───
export {
    CTX_WARNING_PCT, CTX_CRITICAL_PCT,
    QUOTA_HEALTHY_PCT, QUOTA_WARN_PCT,
    USAGE_HIGH_PCT, USAGE_MEDIUM_PCT,
    CASCADE_LIST_LIMIT, CASCADE_TITLE_MAX_LEN,
    CASCADE_ENRICHED_LIMIT, CASCADE_ENRICHED_TITLE_MAX_LEN,
    HOURS_IN_DAY,
} from './shared/uiConstants';

/** gRPC service path for all Language Server endpoints — SSOT */
export const LS_SERVICE_PATH = '/exa.language_server_pb.LanguageServerService';

/** Fallback GCP project ID used when loadCodeAssist does not return one */
export const DEFAULT_PROJECT_ID = 'bamboo-precept-lgxtn';

import * as vscode from 'vscode';

// Platform-aware paths
import * as path from 'path';
import * as os from 'os';

export const isMac = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';
export const isWindows = process.platform === 'win32';

/** Path to Antigravity's local state SQLite DB (used for active-account detection) */
export const STATE_DB_PATH = isMac
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb')
    : isLinux
        ? path.join(os.homedir(), '.config', 'Antigravity', 'User', 'globalStorage', 'state.vscdb')
        : isWindows
            ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Antigravity', 'User', 'globalStorage', 'state.vscdb')
            : '';

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

/** grep pattern to find the LS binary in `ps` output */
export const LS_PROCESS_GREP = isMac
    ? 'language_server_macos'
    : isLinux
        ? 'language_server_linux'
        : isWindows
            ? 'language_server_win'
            : 'language_server';

/** Unified CSRF token extraction regex — SSOT for process discovery */
export const CSRF_TOKEN_RE = /--csrf_token[\s=]+([\w-]+)/;

/**
 * Configuration-gated diagnostic file logging.
 * When false (default), diag() functions are no-ops → zero disk I/O overhead.
 * Enable via: Settings → ag-switchboard.diagnosticMode → true
 *
 * Cached per-check to avoid repeated configuration reads.
 */
const DIAG_CACHE_TTL_MS = 5_000;
let _diagCached: boolean | null = null;
let _diagCacheTs = 0;
export function isDiagEnabled(): boolean {
    const now = Date.now();
    if (_diagCached !== null && now - _diagCacheTs < DIAG_CACHE_TTL_MS) return _diagCached;
    try {
        _diagCached = vscode.workspace.getConfiguration('ag-switchboard')
            .get<boolean>('diagnosticMode', false);
    } catch { /* expected: env parse failure — use fallback */
        _diagCached = false;
    }
    _diagCacheTs = now;
    return _diagCached!;
}
