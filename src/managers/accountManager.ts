import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { TrackedAccount, StoredTokens, AccountQuota } from '../types';
import { SECRETS_PREFIX, ACCOUNTS_LIST_KEY, TOKEN_REFRESH_BUFFER_SECS } from '../constants';
import { GoogleAuthService } from '../services/googleAuth';
import { QuotaApiService } from '../services/quotaApi';
import { createLogger } from '../utils/logger';

const log = createLogger('AccountManager');

export class AccountManager {
    private accounts: TrackedAccount[] = [];
    private quotaCache = new Map<string, AccountQuota>();

    private _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;

    private readonly authService = new GoogleAuthService();
    private readonly quotaApi = new QuotaApiService();

    constructor(private readonly context: vscode.ExtensionContext) {}

    getAuthService(): GoogleAuthService { return this.authService; }

    // --- Lifecycle ---

    async initialize(): Promise<void> {
        this.accounts = this.context.globalState.get<TrackedAccount[]>(ACCOUNTS_LIST_KEY, []);
    }

    // --- Account CRUD ---

    getAccounts(): TrackedAccount[] {
        return [...this.accounts];
    }

    getQuotaCache(): Map<string, AccountQuota> {
        return this.quotaCache;
    }

    async addAccount(): Promise<boolean> {
        const result = await this.authService.startOAuthFlow();
        if (!result) return false;

        const { tokens, userInfo } = result;
        await this.upsertAccount(userInfo.email, userInfo.name, tokens);
        return true;
    }

    async removeAccount(accountId: string): Promise<void> {
        const account = this.accounts.find(a => a.id === accountId);
        if (!account) return;

        await this.context.secrets.delete(SECRETS_PREFIX + account.email);
        this.accounts = this.accounts.filter(a => a.id !== accountId);
        await this.context.globalState.update(ACCOUNTS_LIST_KEY, this.accounts);
        this.quotaCache.delete(accountId);
        this._onDidChange.fire();
    }

    // --- Quota Fetching ---

    /** Refresh quota for ALL tracked accounts in parallel */
    async refreshAllQuotas(): Promise<AccountQuota[]> {
        const results = await Promise.allSettled(
            this.accounts.map(account => this.refreshSingleQuota(account))
        );

        const quotas: AccountQuota[] = [];
        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            if (result.status === 'fulfilled') {
                quotas.push(result.value);
            } else {
                quotas.push({
                    account: this.accounts[i],
                    models: [],
                    tier: null,
                    tierName: null,
                    isForbidden: false,
                    isError: true,
                    errorMessage: result.reason?.message || 'Unknown error',
                    lastUpdated: Date.now(),
                });
            }
        }

        return quotas;
    }

    /** Get valid (auto-refreshed if needed) tokens for a tracked account */
    async getValidTokensForAccount(email: string, forceRefresh = false): Promise<StoredTokens | null> {
        try {
            return await this.getValidTokens(email, forceRefresh);
        } catch { // EXPECTED: token refresh failed — caller handles null return
            return null;
        }
    }

    // --- Private ---

    private async refreshSingleQuota(account: TrackedAccount): Promise<AccountQuota> {
        const tokens = await this.getValidTokens(account.email);
        const result = await this.quotaApi.fetchRemoteQuota(tokens.access_token);

        const quota: AccountQuota = {
            account,
            models: result.models,
            tier: result.tier,
            tierName: result.tierName,
            isForbidden: result.isForbidden,
            isError: result.isError,
            errorMessage: result.errorMessage,
            lastUpdated: Date.now(),
        };

        this.quotaCache.set(account.id, quota);
        return quota;
    }

    private async getValidTokens(email: string, forceRefresh = false): Promise<StoredTokens> {
        const json = await this.context.secrets.get(SECRETS_PREFIX + email);
        if (!json) throw new Error(`No tokens found for ${email}`);

        let tokens: StoredTokens;
        try {
            tokens = JSON.parse(json);
        } catch { /* expected: token refresh can fail for revoked accounts */
            throw new Error(`Corrupted token data for ${email}`);
        }

        // Auto-refresh if expired (with buffer) or if force-refresh requested (e.g. switch)
        if (forceRefresh || Date.now() / 1000 > tokens.expiry_timestamp - TOKEN_REFRESH_BUFFER_SECS) {
            const refreshed = await this.authService.refreshAccessToken(tokens.refresh_token);
            const updated: StoredTokens = {
                access_token: refreshed.access_token,
                // Google may rotate refresh_token — always prefer new one if returned
                refresh_token: refreshed.refresh_token || tokens.refresh_token,
                expiry_timestamp: Math.floor(Date.now() / 1000) + (refreshed.expires_in || 3600),
            };
            await this.context.secrets.store(SECRETS_PREFIX + email, JSON.stringify(updated));
            return updated;
        }

        return tokens;
    }

    private async storeTokens(email: string, tokens: { access_token: string; refresh_token: string; expires_in: number }): Promise<void> {
        const stored: StoredTokens = {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expiry_timestamp: Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600),
        };
        await this.context.secrets.store(SECRETS_PREFIX + email, JSON.stringify(stored));
    }

    // --- Token Login & Export ---

    /** Add account by pasting a refresh token (no browser OAuth flow needed) */
    async addAccountByToken(): Promise<boolean> {
        const refreshToken = await vscode.window.showInputBox({
            title: '🔑 Add Account via Token',
            prompt: 'Paste the refresh token to add an account',
            placeHolder: '1//0e...',
            password: true,
            ignoreFocusOut: true,
        });

        if (!refreshToken?.trim()) return false;

        const token = refreshToken.trim();

        try {
            // 1. Exchange refresh_token → access_token
            const refreshResult = await this.authService.refreshAccessToken(token);

            // 2. Fetch user identity
            const userInfo = await this.authService.fetchUserInfo(refreshResult.access_token);

            // 3. Upsert account (DRY — shared with addAccount)
            const tokens = {
                access_token: refreshResult.access_token,
                refresh_token: token,
                expires_in: refreshResult.expires_in || 3600,
            };
            await this.upsertAccount(userInfo.email, userInfo.name, tokens);
            return true;
        } catch (err: any) {
            vscode.window.showErrorMessage(`❌ Token login failed: ${err.message || err}`);
            return false;
        }
    }

    /** Get refresh token for an account (for clipboard copy / sharing) */
    async getRefreshToken(accountId: string): Promise<string | null> {
        const account = this.accounts.find(a => a.id === accountId);
        if (!account) return null;

        const json = await this.context.secrets.get(SECRETS_PREFIX + account.email);
        if (!json) return null;

        try {
            const tokens: StoredTokens = JSON.parse(json);
            return tokens.refresh_token;
        } catch { /* expected: token retrieval may fail for expired accounts */
            log.warn(`Corrupted token data for ${account.email}`);
            return null;
        }
    }

    // --- DRY Helpers ---

    /**
     * Create or update an account with fresh tokens.
     * Shared by addAccount (OAuth flow) and addAccountByToken (paste flow).
     */
    private async upsertAccount(
        email: string,
        name: string | undefined,
        tokens: { access_token: string; refresh_token: string; expires_in: number },
    ): Promise<void> {
        const existing = this.accounts.find(a => a.email === email);

        if (existing) {
            await this.storeTokens(email, tokens);
            vscode.window.showInformationMessage(`✅ Token refreshed for ${email}`);
        } else {
            const account: TrackedAccount = {
                id: crypto.randomBytes(8).toString('hex'),
                email,
                name: name || email,
                addedAt: Date.now(),
            };
            this.accounts.push(account);
            await this.context.globalState.update(ACCOUNTS_LIST_KEY, this.accounts);
            await this.storeTokens(account.email, tokens);
            vscode.window.showInformationMessage(`✅ Account added: ${email}`);
        }

        this._onDidChange.fire();
    }
}
