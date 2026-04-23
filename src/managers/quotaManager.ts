import * as vscode from 'vscode';
import * as fs from 'fs';
import { PollLock } from '../utils/pollLock';
import { AccountQuota, LocalQuotaData, ServerInfo, ViewState } from '../types';
import { AccountManager } from './accountManager';
import { ServerDiscoveryService } from '../services/serverDiscovery';
import { AccountSwitchService } from '../services/accountSwitch';
import { TokenBaseService, TokenBaseData, WorkspaceContextData } from '../services/tokenBase';
import { UsageStatsService } from '../services/usage';
import { ContextWindowService, ContextWindowData } from '../services/contextWindow';
import { StatusBarService } from '../services/statusBar';
import { EmailResolver } from '../services/emailResolver';
import { DeepUsageStats } from '../types';
import { QuotaViewProvider } from '../providers/quotaViewProvider';
import { STATE_DB_PATH } from '../constants';
import { createLogger } from '../utils/logger';

const log = createLogger('QuotaManager');

const diagPath = '/tmp/ag-ctx-diag.log';
function diag(msg: string) {
    try { require('fs').appendFileSync(diagPath, `[${new Date().toISOString()}] QM: ${msg}\n`); } catch {}
}

export class QuotaManager {
    private readonly statusBar: StatusBarService;
    private readonly emailResolver = new EmailResolver();
    private lastLocalData: LocalQuotaData | null = null;
    private lastTrackedQuotas: AccountQuota[] = [];
    private viewProvider: QuotaViewProvider | null = null;
    private _refreshInFlight = false;
    /** Email hint from a switch that arrived during an in-flight refresh */
    private _pendingHint: string | undefined;
    private _pendingManualRefresh = false;
    private readonly serverDiscovery = new ServerDiscoveryService();
    private readonly switchService: AccountSwitchService;
    private readonly tokenBaseService = new TokenBaseService();
    private readonly usageStatsService = new UsageStatsService();
    private readonly contextWindowService = new ContextWindowService();
    private lastTokenBase: TokenBaseData | null = null;
    private lastWorkspaceContext: WorkspaceContextData | null = null;
    private lastUsageStats: DeepUsageStats | null = null;
    private lastContextWindow: ContextWindowData | null = null;
    private lastContextConversationId: string | null = null;

    private static readonly CTX_CACHE_KEY = 'ag.lastContextWindow';
    private currentUsageRange: string = '24h';

    // Server discovery cache — avoids redundant ps+lsof shell spawns
    private cachedServer: { info: ServerInfo | null; ts: number } | null = null;
    private static readonly SERVER_CACHE_TTL = 60_000; // 60s

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly accountManager: AccountManager,
    ) {
        this.switchService = new AccountSwitchService(context, accountManager.getAuthService());
        this.statusBar = new StatusBarService(context);
        // Ensure token renewal timer is cleaned up on extension deactivation
        context.subscriptions.push({ dispose: () => this.switchService.dispose() });

        // Watch state.vscdb for external account switches (e.g. IDE profile menu)
        let dbWatchDebounce: ReturnType<typeof setTimeout> | null = null;
        try {
            const watcher = fs.watch(STATE_DB_PATH, () => {
                if (dbWatchDebounce) clearTimeout(dbWatchDebounce);
                dbWatchDebounce = setTimeout(() => this.refresh(), 1000);
            });
            context.subscriptions.push({ dispose: () => watcher.close() });
        } catch (e) {
            log.warn('Could not watch state.vscdb for account changes:', e);
        }

        // Restore cached context window from globalState for instant first paint
        this.lastContextWindow = this.context.globalState.get<ContextWindowData | null>(QuotaManager.CTX_CACHE_KEY, null);
        if (this.lastContextWindow) {
            this.lastContextConversationId = this.lastContextWindow.conversationId;
            log.info(`Restored cached context window: ${this.lastContextConversationId?.substring(0, 12)}`);
        }

        // Initial fetch; subsequent refreshes driven by webview interval picker
        this.refresh();

    }

    getSwitchService(): AccountSwitchService {
        return this.switchService;
    }

    setViewProvider(provider: QuotaViewProvider) {
        this.viewProvider = provider;
        if (this.lastLocalData || this.lastTrackedQuotas.length > 0) {
            this.viewProvider.updateData(this.buildViewState(''));
        }
    }

    // ── ViewState builder (DRY: used by all updateData calls) ──

    private buildViewState(activeEmail: string): ViewState {
        return {
            localData: this.lastLocalData,
            selectedModels: this.getSelectedModels(),
            trackedQuotas: this.lastTrackedQuotas,
            activeEmail,
            tokenBase: this.lastTokenBase,
            workspaceContext: this.lastWorkspaceContext,
            pinnedModels: this.getPinnedModels(),
            usageStats: this.getRangeFilteredStats(),
        };
    }

    getSelectedModels(): string[] {
        return this.context.globalState.get<string[]>('ag.selectedStatusBarModels', []);
    }

    getLastUsageStats(): DeepUsageStats | null {
        return this.lastUsageStats;
    }

    getFilteredUsageStats(range: string): DeepUsageStats | null {
        return this.usageStatsService.getFilteredStats(range);
    }

    setUsageRange(range: string) {
        this.currentUsageRange = range;
    }

    /** Returns stats filtered by the user's currently selected range */
    private getRangeFilteredStats(): DeepUsageStats | null {
        if (!this.lastUsageStats) return null;
        return this.usageStatsService.getFilteredStats(this.currentUsageRange);
    }

    getPinnedModels(): Record<string, string> {
        return { ...this.context.globalState.get<Record<string, string>>('ag.pinnedModels', {}) };
    }

    async setPinnedModels(pins: Record<string, string>): Promise<void> {
        await this.context.globalState.update('ag.pinnedModels', pins);
    }

    async toggleStatusBarModel(modelId: string, isVisible: boolean) {
        let selected = this.getSelectedModels();
        if (isVisible && !selected.includes(modelId)) {
            selected.push(modelId);
        } else if (!isVisible) {
            selected = selected.filter(id => id !== modelId);
        }
        await this.context.globalState.update('ag.selectedStatusBarModels', selected);

        if (this.lastLocalData) this.updateStatusBar(this.lastLocalData);
    }

     /** Push whatever is already in memory to the webview — zero network, instant render */
    pushCachedData() {
        if (!this.viewProvider) { log.info('pushCachedData: no viewProvider'); return; }
        const hasLocal = !!this.lastLocalData;
        const hasTracked = this.lastTrackedQuotas.length > 0;
        log.info(`pushCachedData: hasLocal=${hasLocal}, trackedCount=${this.lastTrackedQuotas.length}, hasCtx=${!!this.lastContextWindow}`);

        if (hasLocal || hasTracked) {
            this.viewProvider.updateData(this.buildViewState(''));
            // Push cached context window if available — NO re-fetch here
            // Context window is fetched ONLY in refreshContextWindow() during the main refresh cycle.
            if (this.lastContextWindow) {
                this.viewProvider.postContextWindow(this.lastContextWindow);
            }
        }
    }

    // ── Shared server resolution (DRY: used by refresh, refreshTokenOnly, fetchCtxIndependent) ──

    private async resolveServer(forceRefresh = false): Promise<ServerInfo | null> {
        if (!forceRefresh && this.cachedServer && Date.now() - this.cachedServer.ts < QuotaManager.SERVER_CACHE_TTL) {
            return this.cachedServer.info;
        }
        const info = await this.serverDiscovery.discover(this.getWorkspaceId()).catch(() => null);
        this.cachedServer = { info, ts: Date.now() };
        return info;
    }

    /**
     * Fetch context window data independently of the main refresh cycle.
     * Called by USS tracker on conversation switch or data update.
     *
     * Strategy: check if LS has written new generator metadata entries
     * (numTotalGeneratorMetadata increased). If not yet, retry with backoff.
     * This is a definitive "new data exists" check — no token-count heuristics.
     */
    private _cwDebounce: ReturnType<typeof setTimeout> | null = null;
    private _cwRetryTimer: ReturnType<typeof setTimeout> | null = null;
    /** Last known generator metadata entry count per cascade — definitive change detector */
    private _lastKnownMetaCount = new Map<string, number>();

    async fetchContextWindowIndependent(cascadeId: string) {
        this.lastContextConversationId = cascadeId;
        this.contextWindowService.invalidateCache(cascadeId);

        // Debounce: collapse rapid USS events into a single fetch
        if (this._cwDebounce) clearTimeout(this._cwDebounce);
        if (this._cwRetryTimer) clearTimeout(this._cwRetryTimer);
        this._cwDebounce = setTimeout(() => this._executeFetch(cascadeId, 0), 500);
    }

    /**
     * Internal: execute fetch with retry logic.
     *
     * Why always-fetch instead of count-gating:
     * LS only writes NEW generator metadata entries on planner responses, not every step.
     * numTotalGeneratorMetadata can stay the same across multiple turns (e.g. short responses).
     * But the LAST entry's estimatedTokensUsed may still update. So we always fetch and
     * compare the resulting token count to decide if a retry is needed.
     */
    private async _executeFetch(cascadeId: string, attempt: number) {
        const RETRY_DELAYS = [3000, 7000]; // retry at 3s, then 7s
        const maxAttempts = 1 + RETRY_DELAYS.length; // initial + 2 retries = 3 total
        const shortId = cascadeId.substring(0, 12);

        diag(`fetchCWI attempt ${attempt}/${maxAttempts - 1}: ${shortId}`);
        try {
            this.contextWindowService.invalidateCache(cascadeId);
            const serverInfo = await this.resolveServer();
            if (!serverInfo) { diag('fetchCWI: no server'); return; }
            diag(`fetchCWI: port=${serverInfo.port}`);

            const prevTokens = this.lastContextWindow?.usedTokens ?? 0;
            await this.refreshContextWindow(serverInfo, cascadeId);
            const newTokens = this.lastContextWindow?.usedTokens ?? 0;

            diag(`fetchCWI: tokens prev=${prevTokens} new=${newTokens}`);

            if (newTokens !== prevTokens || prevTokens === 0) {
                // Data changed or first fetch — done!
                diag(`fetchCWI: SUCCESS — tokens updated ${prevTokens}→${newTokens}`);
            } else if (attempt < maxAttempts - 1) {
                // Tokens unchanged — LS may not have written yet. Retry.
                const delay = RETRY_DELAYS[attempt];
                diag(`fetchCWI: tokens unchanged, retry in ${delay}ms (attempt ${attempt + 1})`);
                this._cwRetryTimer = setTimeout(() => this._executeFetch(cascadeId, attempt + 1), delay);
            } else {
                diag(`fetchCWI: retries exhausted, tokens=${newTokens}`);
            }
        } catch (err) {
            diag(`fetchCWI FAILED: ${(err as Error)?.message}`);
            log.info(`fetchCtxIndependent: FAILED ${(err as Error)?.message}`);
        }
    }





    async refresh(activeEmailHint?: string) {
        if (this._refreshInFlight) {
            if (activeEmailHint) {
                this._pendingHint = activeEmailHint;
                log.info(`refresh: QUEUED (hint=${activeEmailHint})`);
            } else {
                // Queue the manual refresh so it runs after the current one
                this._pendingManualRefresh = true;
                log.info('refresh: QUEUED (manual, will run after current finishes)');
            }
            return;
        }

        // Multi-instance safety: prevent duplicate refresh across VS Code windows
        const lock = new PollLock();
        if (!await lock.tryAcquire()) {
            log.info('refresh: SKIPPED (another instance holds the lock)');
            return;
        }

        this._refreshInFlight = true;
        log.info('refresh: STARTED');
        try {
            // Only show loading spinner when there is truly no data to display.
            // If stale data exists, keep it visible while refreshing in the background.
            const hasData = !!(this.lastLocalData || this.lastTrackedQuotas.length > 0);
            if (this.viewProvider && !hasData) this.viewProvider.setLoading();

            // Discover workspace LS once — share with both quota fetch and token budget
            const serverInfo = await this.resolveServer();

            // Parallel: local server + all tracked accounts + active email + workspace context
            const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? '';
            const workspaceFsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            const [localResult, trackedResult, tokenBase, workspaceContext] = await Promise.all([
                serverInfo ? this.serverDiscovery.fetchLocalQuota(serverInfo).catch(() => null) : Promise.resolve(null),
                this.accountManager.refreshAllQuotas().catch(() => []),
                this.tokenBaseService.fetchTokenBase(serverInfo, this.getWorkspaceId()).catch(() => null),
                serverInfo ? this.tokenBaseService.fetchWorkspaceContext(serverInfo, workspaceName, workspaceFsPath).catch(() => null) : Promise.resolve(null),
            ]);

            // Deep usage stats — pre-load from disk cache SYNCHRONOUSLY (~20ms for 4MB)
            // so it's included in the very first webview render. No shimmer needed.
            if (!this.lastUsageStats) {
                log.info('refresh: lastUsageStats is null, loading disk cache...');
                const cachedStats = this.usageStatsService.loadFromDiskCacheSync();
                log.info(`refresh: loadFromDiskCacheSync returned ${cachedStats ? 'data (totalCalls=' + cachedStats.totalCalls + ')' : 'null'}`);
                if (cachedStats) this.lastUsageStats = cachedStats;
            } else {
                log.info(`refresh: lastUsageStats already present (totalCalls=${this.lastUsageStats.totalCalls})`);
            }

            const activeEmail = activeEmailHint ?? await this.getActiveEmail();

            // Local (active IDE account)
            if (localResult) {
                this.lastLocalData = localResult;
                this.updateStatusBar(localResult);
            } else {
                this.lastLocalData = null;
                this.statusBar.setError('$(error) Antigravity: Server Not Found', 'Could not connect to local Antigravity server');
            }

            // Tracked accounts
            this.lastTrackedQuotas = trackedResult;
            this.lastTokenBase = tokenBase;
            this.lastWorkspaceContext = workspaceContext;

            // Push to webview IMMEDIATELY — loading state ends here
            // Deep stats are fetched in background AFTER render (Tier 1 optimization)
            log.info(`refresh: localResult=${!!localResult}, trackedCount=${trackedResult.length}, hasProvider=${!!this.viewProvider}`);
            if (this.viewProvider) {
                if (this.lastLocalData || this.lastTrackedQuotas.length > 0) {
                    this.viewProvider.updateData(this.buildViewState(activeEmail));
                    log.info('refresh: updateData sent');

                    // Context window is USS-only — no polling fallback needed
                } else {
                    this.viewProvider.setError('Antigravity IDE server not found and no tracked accounts.');
                    log.info('refresh: setError sent (no data)');
                }
            }

            // Deep usage stats — fire-and-forget AFTER render (non-blocking)
            // Cold conversations backfill silently in background via callback.
            if (serverInfo) {
                const isSubsequentCall = !!this.lastUsageStats;
                this.usageStatsService.fetchDeepStats(serverInfo, isSubsequentCall, (backfilledStats) => {
                    this.lastUsageStats = backfilledStats;
                    this.pushCachedData();
                }).then(deep => {
                    if (deep) { this.lastUsageStats = deep; this.pushCachedData(); }
                }).catch(err => {
                    log.info(`fetchDeepStats FAILED: ${err?.message}`);
                });
            }
        } catch (error: any) {
            const msg = error.message || 'Unknown error';
            log.info(`refresh: CAUGHT ERROR: ${msg}`);
            if (this.viewProvider) this.viewProvider.setError(msg);
            this.statusBar.setError('$(error) Antigravity: Error', msg);
        } finally {
            this._refreshInFlight = false;
            await lock.release();
            log.info('refresh: FINISHED');
            const hint = this._pendingHint;
            const manualPending = this._pendingManualRefresh;
            this._pendingHint = undefined;
            this._pendingManualRefresh = false;
            if (hint) {
                log.info(`refresh: DRAINING QUEUED (hint=${hint})`);
                this.refresh(hint);
            } else if (manualPending) {
                log.info('refresh: DRAINING QUEUED (manual)');
                this.refresh();
            }
        }
    }

    /** Fetch context window for a specific conversation and push to webview */
    private async refreshContextWindow(serverInfo: ServerInfo, cascadeId: string): Promise<void> {
        diag(`refreshCW: fetching for ${cascadeId.substring(0,12)}`);
        try {
            const ctx = await this.contextWindowService.getContextForCascade(serverInfo, cascadeId);

            if (!ctx) {
                diag(`refreshCW: ctx is null for ${cascadeId.substring(0,12)}`);
                // If this is the ACTIVE conversation and ctx is null (new/empty conversation),
                // clear stale data so the widget doesn't show the previous conversation's info.
                if (cascadeId === this.lastContextConversationId) {
                    this.lastContextWindow = null;
                    this.context.globalState.update(QuotaManager.CTX_CACHE_KEY, null);
                    if (this.viewProvider) {
                        this.viewProvider.postContextWindow(null);
                        diag('refreshCW: cleared stale context (active conversation has no data)');
                    }
                }
                return;
            }

            diag(`refreshCW: got data — title="${ctx.title?.substring(0,30)}" tokens=${ctx.usedTokens}/${ctx.maxTokens} convId=${ctx.conversationId?.substring(0,12)}`);

            if (ctx.conversationId !== this.lastContextConversationId) {
                log.info(`Context window: conversation → ${ctx.conversationId?.substring(0, 12)}`);
                this.lastContextConversationId = ctx.conversationId;
            }
            this.lastContextWindow = ctx;
            this.context.globalState.update(QuotaManager.CTX_CACHE_KEY, ctx);
            if (this.viewProvider) {
                this.viewProvider.postContextWindow(ctx);
                diag(`refreshCW: pushed to webview — tokens=${ctx.usedTokens}`);
            } else {
                diag('refreshCW: NO viewProvider — data not pushed');
            }
        } catch (err) {
            diag(`refreshCW FAILED: ${(err as Error)?.message}`);
            log.info(`refreshContextWindow FAILED: ${(err as Error)?.message}`);
        }
    }

    /** Refresh ONLY token budget + workspace context — no account quota fetching */
    async refreshTokenOnly() {
        if (this._refreshInFlight) return;
        this._refreshInFlight = true;
        try {
            if (this.viewProvider) this.viewProvider.setLoading();

            const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? '';
            const workspaceFsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            const serverInfo = await this.resolveServer();

            const [tokenBase, workspaceContext] = await Promise.all([
                this.tokenBaseService.fetchTokenBase(serverInfo, this.getWorkspaceId()).catch(() => null),
                serverInfo ? this.tokenBaseService.fetchWorkspaceContext(serverInfo, workspaceName, workspaceFsPath).catch(() => null) : Promise.resolve(null),
            ]);

            this.lastTokenBase = tokenBase;
            this.lastWorkspaceContext = workspaceContext;

            if (this.viewProvider) {
                const activeEmail = await this.getActiveEmail();
                this.viewProvider.updateData(this.buildViewState(activeEmail));
            }
        } catch (error: any) {
            if (this.viewProvider) this.viewProvider.setError(error.message || 'Token refresh failed');
        } finally {
            this._refreshInFlight = false;
        }
    }

    /** Switch the active IDE account to a tracked account */
    async switchAccount(accountId: string): Promise<void> {
        const account = this.accountManager.getAccounts().find(a => a.id === accountId);
        if (!account) {
            vscode.window.showErrorMessage('Account not found');
            return;
        }

        // Force-refresh to get a token with max TTL → IDE's auto-refresh
        // has the full ~60 min window to trigger before expiry
        const tokens = await this.accountManager.getValidTokensForAccount(account.email, true);
        if (!tokens) {
            vscode.window.showErrorMessage(`No valid tokens for ${account.email}. Please re-add the account.`);
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Switch IDE account to ${account.email}?`,
            { modal: true },
            'Switch'
        );
        if (confirm !== 'Switch') return;

        const success = await this.switchService.switchAccount({
            email: account.email, name: account.name, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiryTimestamp: tokens.expiry_timestamp,
        });
        if (success) {
            // Delay first refresh — LS needs ~1-2s to process registerGdmUser
            // and fetch new models from backend. Immediate refresh sees stale data.
            setTimeout(() => this.refresh(account.email), 1500);

            // Second refresh (5s): USS fully propagated, re-read without hint.
            setTimeout(() => this.refresh(), 5000);
        }
    }

    /** Copy refresh_token to clipboard for sharing */
    async copyToken(accountId: string): Promise<void> {
        const token = await this.accountManager.getRefreshToken(accountId);
        if (!token) {
            vscode.window.showErrorMessage('❌ No token found for this account');
            return;
        }
        await vscode.env.clipboard.writeText(token);
        vscode.window.showInformationMessage('🔑 Token copied to clipboard');
    }

    // --- Private ---

    /** Build workspace_id matching the language server's --workspace_id arg format */
    private getWorkspaceId(): string | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return undefined;
        // Format must match LS's --workspace_id: slashes AND hyphens → underscores
        // e.g. /Users/eren/denetmenapp-web → file_Users_eren_denetmenapp_web
        const uri = folders[0].uri;
        if (uri.scheme === 'file') {
            return 'file_' + uri.path.replace(/\//g, '_').replace(/^_/, '').replace(/-/g, '_');
        }
        return uri.toString().replace(/[/:\-]/g, '_');
    }

    /** Delegate to EmailResolver */
    private async getActiveEmail(): Promise<string> {
        return this.emailResolver.getActiveEmail();
    }

    private updateStatusBar(data: LocalQuotaData): void {
        this.statusBar.update(data, this.getSelectedModels());
    }
}