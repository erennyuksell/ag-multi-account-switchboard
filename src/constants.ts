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
    'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
    'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
];

export const LOAD_CODE_ASSIST_ENDPOINTS = [
    'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
];

// Optional display name overrides for known model slugs.
// Models NOT in this map are still shown — their ID is auto-humanized.
export const MODEL_DISPLAY_NAMES: Record<string, string> = {
    'claude-opus-4-6-thinking': 'Claude Opus 4.6 (Thinking)',
    'claude-sonnet-4-6': 'Claude Sonnet 4.6',
    'gemini-3-flash': 'Gemini 3 Flash',
    'gemini-3.1-pro-high': 'Gemini 3.1 Pro (High)',
    'gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
    'gpt-oss-120b-medium': 'GPT-OSS 120B (Medium)',
};

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
/** Token renewal retry delay on transient failure */
export const RENEWAL_RETRY_DELAY_MS = 2 * 60_000;

// ─── Thresholds ───

/** Bytes to read from file header for binary detection */
export const FILE_HEADER_READ_BYTES = 256;
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



import * as vscode from 'vscode';

// Platform-aware paths — re-exported from shared SSOT (vscode-free)
export { isMac, isLinux, isWindows, STATE_DB_PATH, LS_CERT_PATHS, LS_PROCESS_GREP } from './shared/agPaths';

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
