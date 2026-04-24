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
    /** HTTPS server port for cascade trajectory endpoints (differs from extension_server_port) */
    httpsPort?: number;
}

/** Options for programmatic IDE account switching */
export interface SwitchAccountOptions {
    email: string;
    name: string;
    accessToken: string;
    refreshToken: string;
    expiryTimestamp: number;
}

// ==================== Account Card Types (SSOT for sidebar render) ====================

/** Single model's quota — unified from both local LS and remote API */
export interface ModelCard {
    id: string;
    label: string;
    pct: number;
    resetTime: string;
    isLocal: boolean;
}

/**
 * Pre-processed account card — renderer does ZERO logic.
 * Built by quotaManager.buildAccountCards(), consumed by webview renderAll().
 */
export interface AccountCard {
    email: string;
    name?: string;
    isActive: boolean;
    trackingId?: string;        // only for tracked accounts (switch/copy/remove)
    models: ModelCard[];
    bottleneck: ModelCard | null;
    tierName: string | null;
    tierId?: string | null;
    aiCredits: number | null;
    promptCredits: number | null;
    promptCreditsMax: number | null;
    flowCredits: number | null;
    flowCreditsMax: number | null;
    resetTime: string;
    isError: boolean;
    errorMessage?: string;
    selectedModels: string[];   // status bar toggles (only relevant for local)
    isLocal: boolean;
}

/** Unified state object passed to viewProvider.updateData() */
export interface ViewState {
    accountCards: AccountCard[];
    pinnedModels: Record<string, string>;
    tokenBase: any | null;
    workspaceContext: any | null;
    usageStats: DeepUsageStats | null;
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
        email?: string;
        cascadeModelConfigData?: {
            clientModelConfigs?: ClientModelConfig[];
        };
        userTier?: {
            id?: string;
            name?: string;
            availableCredits?: Array<{ creditType: string; creditAmount: string }>;
        };
        planStatus?: {
            availablePromptCredits?: number;
            availableFlowCredits?: number;
            planInfo?: {
                monthlyPromptCredits?: number;
                monthlyFlowCredits?: number;
            };
        };
    };
}

// ==================== Deep Usage Stats Types ====================

/** Time-bucketed token usage */
export interface TokenBucket {
    input: number;
    output: number;
    cache: number;        // cacheRead — kept as 'cache' for backward compat
    cacheWrite: number;   // cache creation tokens
    reasoning: number;    // thinking/reasoning tokens
    calls: number;
}

/** Daily breakdown entry */
export interface DailyBucket extends TokenBucket {
    date: string;  // YYYY-MM-DD
}

/** Hourly breakdown entry (aggregated across all days) */
export interface HourlyBucket extends TokenBucket {
    hour: number;  // 0-23
}

/** Model breakdown entry */
export interface ModelBucket extends TokenBucket {
    displayName: string;
}

/** Cascade/conversation breakdown */
export interface CascadeBucket extends TokenBucket {
    id: string;
    title: string;
}

/** Provider breakdown entry */
export interface ProviderBucket extends TokenBucket {
    provider: string;
    displayName: string;
}

/** Day-of-week aggregation (Mon=0 .. Sun=6) */
export interface WeekdayBucket extends TokenBucket {
    day: number;       // 0=Mon .. 6=Sun
    label: string;     // "Mon", "Tue" ...
}

/** Monthly breakdown per model (for tooltip) */
export interface MonthlyModelEntry {
    displayName: string;
    tokens: number;
    cost: number;
}

/** Calendar month bucket (filter-independent) */
export interface MonthlyBucket extends TokenBucket {
    key: string;       // YYYY-MM
    label: string;     // "Jan", "Feb" etc.
    total: number;
    cost: number;
    topModels: MonthlyModelEntry[];
}

/** Full deep analytics stats */
export interface DeepUsageStats {
    totalTokens: number;
    totalInput: number;
    totalOutput: number;
    totalCache: number;
    totalCacheWrite: number;
    totalReasoning: number;
    totalCalls: number;
    daysActive: number;
    cacheRate: number;
    dateRange: { from: string; to: string };
    daily: DailyBucket[];
    hourly: HourlyBucket[];
    models: ModelBucket[];
    cascades: CascadeBucket[];
    providers: ProviderBucket[];
    weekday: WeekdayBucket[];
    monthly: MonthlyBucket[];  // filter-independent, data-driven
}
