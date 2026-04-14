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

// Polling & timeout
export const POLL_INTERVAL_MS = 60 * 1000;
export const TOKEN_REFRESH_BUFFER_SECS = 300; // refresh 5 min before expiry
export const OAUTH_CALLBACK_TIMEOUT_MS = 120_000; // 2 min

// Platform paths (macOS — extend with process.platform checks if needed)
import * as path from 'path';
import * as os from 'os';

export const STATE_DB_PATH = path.join(
    os.homedir(),
    'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb'
);

export const LS_CERT_PATHS = [
    '/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/dist/languageServer/cert.pem',
];

/** grep pattern to find the LS binary in `ps` output */
export const LS_PROCESS_GREP = 'language_server_macos';
