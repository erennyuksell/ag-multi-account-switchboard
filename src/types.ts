/** Tracked account metadata (stored in globalState) */
export interface TrackedAccount {
    id: string;
    email: string;
    name: string;
    addedAt: number;
}

/** Stored token data (stored in Secrets API) */
export interface StoredTokens {
    access_token: string;
    refresh_token: string;
    expiry_timestamp: number;
}

/** Parsed model quota from remote API */
export interface QuotaModel {
    name: string;
    percentage: number;
    resetTime: string;
    resetTimeRaw: string;
}

/** Full quota result for a tracked account */
export interface AccountQuota {
    account: TrackedAccount;
    models: QuotaModel[];
    tier: string | null;
    tierName: string | null;
    isForbidden: boolean;
    isError: boolean;
    errorMessage?: string;
    lastUpdated: number;
}

/** Local language server connection info */
export interface ServerInfo {
    port: number;
    csrfToken: string;
    protocol: 'http' | 'https';
}

/** Options for programmatic IDE account switching */
export interface SwitchAccountOptions {
    email: string;
    name: string;
    accessToken: string;
    refreshToken: string;
    expiryTimestamp: number;
}

// ==================== IDE Internal Types ====================

/** OAuth token info for USS uss-oauth topic */
export interface OAuthTokenInfo {
    accessToken: string;
    refreshToken: string;
    expiryDateSeconds: number;
    tokenType: string;
    isGcpTos: boolean;
}

/**
 * Typed accessor for the IDE's antigravityUnifiedStateSync API.
 * This API is injected by the IDE and is not part of the official vscode API.
 */
export interface USSApi {
    OAuthPreferences: {
        setOAuthTokenInfo(info: OAuthTokenInfo): Promise<void>;
        getOAuthTokenInfo(): Promise<string | null>;
    };
    UserStatus: {
        getUserStatus(): Promise<string | null>;
    };
    pushSerializedUpdateIPC(data: string): Promise<void>;
}

/** Typed HTTP error with status code (replaces monkey-patched Error) */
export class HttpError extends Error {
    constructor(public readonly statusCode: number, message: string) {
        super(message);
        this.name = 'HttpError';
    }
}

/** Fetched quota result returned by QuotaApiService */
export interface QuotaResult {
    models: QuotaModel[];
    tier: string | null;
    tierName: string | null;
    isForbidden: boolean;
    isError: boolean;
    errorMessage?: string;
}

// ==================== Local Quota Types ====================

/** Model quota info from local LS GetUserStatus response */
export interface ModelQuotaInfo {
    remainingFraction?: number;
    resetTime?: string;
}

/** Individual model config from LS response */
export interface ClientModelConfig {
    label?: string;
    modelOrAlias?: { model?: string };
    quotaInfo?: ModelQuotaInfo;
}

/** Local LS GetUserStatus response shape */
export interface LocalQuotaData {
    userStatus?: {
        cascadeModelConfigData?: {
            clientModelConfigs?: ClientModelConfig[];
        };
    };
}
