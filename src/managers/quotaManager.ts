import * as vscode from 'vscode';
import { PollLock } from '../utils/pollLock';
import { AccountQuota, AccountCard, LocalQuotaData, ServerInfo, ViewState, DeepUsageStats } from '../types';
import { AccountManager } from './accountManager';
import { buildAccountCards } from './accountCardBuilder';
import { ServerDiscoveryService } from '../services/serverDiscovery';
import { AccountSwitchService } from '../services/accountSwitch';
import { TokenBaseService, TokenBaseData, WorkspaceContextData } from '../services/tokenBase';
import { UsageStatsService } from '../services/usage';
import { ContextWindowService, ContextWindowData } from '../services/contextWindow';
import { LiveStream } from '../services/liveStream';
import { StatusBarService } from '../services/statusBar';
import { ContextDetailPanel } from '../providers/contextDetailPanel';
import { EmailResolver } from '../services/emailResolver';

import { QuotaViewProvider } from '../providers/quotaViewProvider';
import { createLogger } from '../utils/logger';

const log = createLogger('QuotaManager');

export class QuotaManager {
    private readonly statusBar: StatusBarService;
    private readonly emailResolver = new EmailResolver();
    private lastLocalData: LocalQuotaData | null = null;
    private lastTrackedQuotas: AccountQuota[] = [];
    private viewProvider: QuotaViewProvider | null = null;
    private refreshInFlight = false;
    /** Email hint from a switch that arrived during an in-flight refresh */
    private pendingHint: string | undefined;
    private pendingManualRefresh = false;
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
    /** Last known active email — used by pushCachedData to maintain consistent UI */
    private lastActiveEmail = '';

    private static readonly CTX_CACHE_KEY = 'ag.lastContextWindow';
    private static readonly CASCADE_ID_LOG_LEN = 12;
    private static readonly POST_SWITCH_REFRESH_DELAY = 2000;
    private static readonly DEBOUNCE_MS = 1500;
    /** Host-side polling interval — runs regardless of panel visibility */
    private static readonly HOST_POLL_INTERVAL_MS = 60_000;
    private currentUsageRange = '24h';

    private cachedServer: { info: ServerInfo | null; ts: number } | null = null;
    private static readonly SERVER_CACHE_TTL = 60_000;

    // Global LS port is stable across IDE reloads; separate from workspace LS cache.
    private cachedCascadeServer: { info: ServerInfo | null; ts: number } | null = null;
    private static readonly CASCADE_SERVER_TTL = 600_000;
    /** Lifecycle-scoped switch guard. AbortController so double-click aborts previous switch. */
    private switchController: AbortController | null = null;
    private hostPollTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly accountManager: AccountManager,
    ) {
        this.switchService = new AccountSwitchService(context, accountManager.getAuthService());
        this.statusBar = new StatusBarService(context);
        context.subscriptions.push({ dispose: () => this.switchService.dispose() });
        context.subscriptions.push({ dispose: () => this.liveStream.destroy() });
        context.subscriptions.push({ dispose: () => this.switchController?.abort() });

        this.initLiveStreamListener();

        ContextDetailPanel.setRefreshCallback(async () => {
            if (this.lastContextConversationId) {
                this.contextWindowService.invalidateCache(this.lastContextConversationId);
                await this.executeFetch(this.lastContextConversationId);
            }
        });

        this.lastContextWindow = null;
        this.lastContextConversationId = null;
        this.context.globalState.update(QuotaManager.CTX_CACHE_KEY, null);
        this.refresh();

        // Host-side periodic poll — keeps status bar and cache fresh even
        // when the sidebar panel is collapsed (webview timer dies without
        // retainContextWhenHidden). This is the authoritative poll;
        // the webview timer provides supplementary UI-driven refreshes.
        this.hostPollTimer = setInterval(() => this.refresh(), QuotaManager.HOST_POLL_INTERVAL_MS);
        context.subscriptions.push({ dispose: () => { if (this.hostPollTimer) clearInterval(this.hostPollTimer); } });
    }

    getSwitchService(): AccountSwitchService {
        return this.switchService;
    }

    setViewProvider(provider: QuotaViewProvider) {
        this.viewProvider = provider;
        if (this.lastLocalData || this.lastTrackedQuotas.length > 0) {
            this.viewProvider.updateData(this.buildViewState());
        }
    }

    // ── ViewState builder (DRY: used by all updateData calls) ──

    private buildViewState(): ViewState {
        return {
            accountCards: this.getAccountCards(),
            pinnedModels: this.getPinnedModels(),
            tokenBase: this.lastTokenBase,
            workspaceContext: this.lastWorkspaceContext,
            usageStats: this.getRangeFilteredStats(),
        };
    }
    private getAccountCards(): AccountCard[] {
        return buildAccountCards(
            this.lastLocalData,
            this.lastTrackedQuotas,
            this.lastActiveEmail,
            !!this.switchController,
            this.getSelectedModels(),
        );
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

    getLastContextWindow(): ContextWindowData | null {
        return this.lastContextWindow;
    }

    getActiveConversationId(): string | null {
        return this.lastContextConversationId;
    }

    async getServerInfo(): Promise<ServerInfo | null> {
        return this.resolveServer();
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
            this.viewProvider.updateData(this.buildViewState());
            // Push cached context window if available — NO re-fetch here
            if (this.lastContextWindow) {
                this.viewProvider.postContextWindow(this.lastContextWindow);
            }
            // Also update status bar from cached local data to prevent stale "Server Not Found"
            if (this.lastLocalData) this.updateStatusBar(this.lastLocalData);
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
     * Resolve the Global (cascade) LS for context window & LiveStream.
     *
     * The IDE runs two LS processes:
     *   - Workspace LS (--workspace_id, --enable_lsp) → code completions, quota, workspace context
     *   - Global LS (no workspace_id) → cascade/chat inference, generator metadata
     *
     * Context window data lives on the Global LS. This method discovers and caches it.
     */
    private async resolveCascadeServer(cascadeId: string): Promise<ServerInfo | null> {
        if (this.cachedCascadeServer && this.cachedCascadeServer.info && Date.now() - this.cachedCascadeServer.ts < QuotaManager.CASCADE_SERVER_TTL) {
            return this.cachedCascadeServer.info;
        }
        // Do NOT pass wsServer as fallback — WS LS has stale cascade snapshots.
        const info = await this.serverDiscovery.discoverCascadeServer(cascadeId, null).catch(() => null);
        if (info) {
            this.cachedCascadeServer = { info, ts: Date.now() };
            return info;
        }
        // Stale-while-revalidate: if fresh discovery failed but we have a
        // previously cached server (expired TTL), use it rather than returning null.
        // Global LS rarely changes port — stale cache is almost always correct.
        if (this.cachedCascadeServer?.info) {
            log.info(`resolveCascadeServer: fresh discovery failed, using stale cache (port=${this.cachedCascadeServer.info.port}, age=${Date.now() - this.cachedCascadeServer.ts}ms)`);
            return this.cachedCascadeServer.info;
        }
        log.diag(`resolveCascadeServer: not found (no cache)`);
        return null;
    }

    // ── Debounced Context Fetch ──────────────────────────────────

    private ctxDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    /** Coalesces rapid-fire USS events into a single fetch. */
    debouncedContextFetch(cascadeId: string): void {
        if (this.ctxDebounceTimer) clearTimeout(this.ctxDebounceTimer);
        this.ctxDebounceTimer = setTimeout(() => {
            this.ctxDebounceTimer = null;
            this.executeFetch(cascadeId);
        }, QuotaManager.DEBOUNCE_MS);
    }

    /** Set active conversation + start live stream. Called on USS activeCascade switch. */
    setActiveConversation(cascadeId: string): void {
        this.lastContextConversationId = cascadeId;
        // Do NOT invalidate cachedCascadeServer — Global LS is a singleton.
        // Forcing re-discovery on every switch caused ps/lsof timing races.
        this.lastLiveTotalLength = 0;
        log.diag(`setActiveConversation: ${cascadeId.substring(0, QuotaManager.CASCADE_ID_LOG_LEN)}`);
        this.resolveCascadeServer(cascadeId).then(server => {
            if (server) {
                this.liveStream.connect(server, cascadeId);
            } else {
                this.resolveServer().then(ws => {
                    if (ws) this.liveStream.connect(ws, cascadeId);
                }).catch((e: unknown) => log.warn('LiveStream fallback failed:', (e as Error)?.message));
            }
        }).catch(err => log.diag(`setActiveConversation: ${(err as Error)?.message}`));
    }

    // ── Live Stream ──────────────────────────────────────────────

    private readonly liveStream = new LiveStream();
    private lastLiveTotalLength = 0;

    private initLiveStreamListener(): void {
        this.liveStream.on('totalLength', async (event: { totalLength: number; conversationId: string }) => {
            const server = this.cachedServer?.info;
            if (!server || !event.conversationId) return;
            if (event.conversationId !== this.lastContextConversationId) return;
            if (event.totalLength <= this.lastLiveTotalLength) return;
            this.lastLiveTotalLength = event.totalLength;

            try {
                const data = await this.contextWindowService.fetchLastEntry(
                    server, event.conversationId, event.totalLength,
                    this.lastContextWindow?.title || 'Conversation',
                );
                if (event.totalLength < this.lastLiveTotalLength) return; // newer delta arrived
                if (data) this.pushContextUpdate(data, event.conversationId, server);
            } catch (e: unknown) { log.diag(`liveStream delta: ${(e as Error)?.message}`); }
        });
    }

    /** One-shot context window fetch — used on conversation switch. */
    async fetchContextWindowOnce(cascadeId: string) {
        return this.executeFetch(cascadeId, true);
    }

    private async executeFetch(cascadeId: string, setActive = false) {
        if (setActive) this.lastContextConversationId = cascadeId;
        const shortId = cascadeId.substring(0, QuotaManager.CASCADE_ID_LOG_LEN);
        try {
            this.contextWindowService.invalidateCache(cascadeId);
            // Global LS only — workspace LS has stale snapshots (hours old)
            const cascadeServer = await this.resolveCascadeServer(cascadeId);
            if (!cascadeServer) {
                log.info(`fetchCW: unavailable for ${shortId}`);
                return;
            }
            await this.refreshContextWindow(cascadeServer, cascadeId);
        } catch (err) {
            this.cachedCascadeServer = null;
            log.info(`fetchCW: FAILED ${(err as Error)?.message}`);
        }
    }

    /** Push context window data to all surfaces. Rejects stale data. */
    private pushContextUpdate(data: ContextWindowData, cascadeId: string, server: ServerInfo | null): void {
        // Never overwrite newer data with older — prevents stale LS snapshot clobbering
        if (this.lastContextWindow && data.lastUpdated && this.lastContextWindow.lastUpdated) {
            if (data.lastUpdated < this.lastContextWindow.lastUpdated && cascadeId === this.lastContextConversationId) {
                return;
            }
        }
        if (cascadeId !== this.lastContextConversationId) {
            this.lastContextConversationId = cascadeId;
        }
        this.lastContextWindow = data;
        this.context.globalState.update(QuotaManager.CTX_CACHE_KEY, data);
        if (this.viewProvider) this.viewProvider.postContextWindow(data);
        ContextDetailPanel.pushUpdate(data, server);
        if (data.usedTokens > 0 && data.maxTokens > 0) {
            this.statusBar.updateContext(data.usedTokens, data.maxTokens, data.model);
        }
    }

    async refresh(activeEmailHint?: string) {
        // Suppress refresh during active switch lifecycle to prevent premature renders
        if (this.switchController && !this.switchController.signal.aborted) {
            log.info('refresh: SUPPRESSED (switch lifecycle active)');
            return;
        }

        if (this.refreshInFlight) {
            if (activeEmailHint) {
                this.pendingHint = activeEmailHint;
            } else {
                this.pendingManualRefresh = true;
            }
            log.diag(`refresh: QUEUED (hint=${activeEmailHint || 'manual'})`);
            return;
        }

        const lock = new PollLock();
        if (!await lock.tryAcquire()) {
            log.diag('refresh: SKIPPED (lock held by another instance)');
            return;
        }

        this.refreshInFlight = true;
        const startTime = Date.now();
        try {
            const hasData = !!(this.lastLocalData || this.lastTrackedQuotas.length > 0);
            if (this.viewProvider && !hasData) this.viewProvider.setLoading();

            const serverInfo = await this.resolveServer();

            const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? '';
            const workspaceFsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            const [localResult, trackedResult, tokenBase, workspaceContext] = await Promise.all([
                serverInfo ? this.serverDiscovery.fetchLocalQuota(serverInfo).catch(() => null) : Promise.resolve(null),
                this.accountManager.refreshAllQuotas().catch(() => []),
                this.tokenBaseService.fetchTokenBase(serverInfo, this.getWorkspaceId()).catch(() => null),
                serverInfo ? this.tokenBaseService.fetchWorkspaceContext(serverInfo, workspaceName, workspaceFsPath).catch(() => null) : Promise.resolve(null),
            ]);

            // Pre-load disk cache synchronously so first render includes usage stats
            if (!this.lastUsageStats) {
                const cachedStats = this.usageStatsService.loadFromDiskCacheSync();
                if (cachedStats) this.lastUsageStats = cachedStats;
            }

            const activeEmail = activeEmailHint ?? await this.getActiveEmail();
            this.lastActiveEmail = activeEmail;

            log.info(`refresh: ${Date.now() - startTime}ms local=${!!localResult} tracked=${trackedResult.length}`);

            if (localResult) {
                this.lastLocalData = localResult;
                this.updateStatusBar(localResult);
                this.logQuotaFractions(localResult);
            } else {
                this.lastLocalData = null;
                this.statusBar.setError('$(error) Antigravity: Server Not Found', 'Could not connect to local Antigravity server');
            }

            this.lastTrackedQuotas = trackedResult;
            this.lastTokenBase = tokenBase;
            this.lastWorkspaceContext = workspaceContext;

            if (this.viewProvider) {
                if (this.lastLocalData || this.lastTrackedQuotas.length > 0) {
                    this.viewProvider.updateData(this.buildViewState());
                } else {
                    this.viewProvider.setError('Antigravity IDE server not found and no tracked accounts.');
                }
            }

            // Deep usage stats — fire-and-forget after initial render
            if (serverInfo) {
                const isSubsequentCall = !!this.lastUsageStats;
                this.usageStatsService.fetchDeepStats(serverInfo, isSubsequentCall, (backfilledStats) => {
                    this.lastUsageStats = backfilledStats;
                    this.pushCachedData();
                }, (done, total) => {
                    this.viewProvider?.postMessage({ type: 'scanProgress', done, total });
                }).then(deep => {
                    if (deep) { this.lastUsageStats = deep; this.pushCachedData(); }
                }).catch(err => {
                    log.diag(`fetchDeepStats: ${err?.message}`);
                });
            }
        } catch (error: any) {
            const msg = error.message || 'Unknown error';
            log.info(`refresh: ERROR: ${msg}`);
            if (this.viewProvider) this.viewProvider.setError(msg);
            this.statusBar.setError('$(error) Antigravity: Error', msg);
        } finally {
            this.refreshInFlight = false;
            await lock.release();
            const hint = this.pendingHint;
            const manualPending = this.pendingManualRefresh;
            this.pendingHint = undefined;
            this.pendingManualRefresh = false;
            if (hint) {
                this.refresh(hint);
            } else if (manualPending) {
                this.refresh();
            }
        }
    }

    /** Fetch context window for a specific conversation and push to webview */
    private async refreshContextWindow(serverInfo: ServerInfo, cascadeId: string): Promise<void> {
        log.diag(`refreshCW: fetching for ${cascadeId.substring(0, QuotaManager.CASCADE_ID_LOG_LEN)}`);
        try {
            const ctx = await this.contextWindowService.getContextForCascade(serverInfo, cascadeId);

            if (!ctx) {
                log.diag(`refreshCW: ctx is null for ${cascadeId.substring(0, QuotaManager.CASCADE_ID_LOG_LEN)}`);
                if (cascadeId !== this.lastContextConversationId) return;
                this.lastContextWindow = null;
                this.context.globalState.update(QuotaManager.CTX_CACHE_KEY, null);
                this.viewProvider?.postContextWindow(null);
                log.diag('refreshCW: cleared stale context (active conversation has no data)');
                return;
            }

            log.diag(`refreshCW: got data — title="${ctx.title?.substring(0, 30)}" tokens=${ctx.usedTokens}/${ctx.maxTokens} convId=${ctx.conversationId?.substring(0, QuotaManager.CASCADE_ID_LOG_LEN)}`);

            this.pushContextUpdate(ctx, ctx.conversationId, serverInfo);
        } catch (err) {
            log.diag(`refreshCW FAILED: ${(err as Error)?.message}`);
            log.info(`refreshContextWindow FAILED: ${(err as Error)?.message}`);
        }
    }

    /** Refresh ONLY token budget + workspace context — no account quota fetching */
    async refreshTokenOnly() {
        if (this.refreshInFlight) return;
        this.refreshInFlight = true;
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
                this.lastActiveEmail = activeEmail;
                this.viewProvider.updateData(this.buildViewState());
            }
        } catch (error: any) {
            if (this.viewProvider) this.viewProvider.setError(error.message || 'Token refresh failed');
        } finally {
            this.refreshInFlight = false;
        }
    }

    /** Switch the active IDE account to a tracked account */
    async switchAccount(accountId: string): Promise<void> {
        const account = this.accountManager.getAccounts().find(a => a.id === accountId);
        if (!account) {
            vscode.window.showErrorMessage('Account not found');
            return;
        }
        // Force-refresh for max TTL token
        const tokens = await this.accountManager.getValidTokensForAccount(account.email, true);
        if (!tokens) {
            vscode.window.showErrorMessage(`No valid tokens for ${account.email}. Please re-add the account.`);
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Switch IDE account to ${account.email}?`, { modal: true }, 'Switch',
        );
        if (confirm !== 'Switch') return;

        // Abort previous switch (double-click protection)
        this.switchController?.abort();
        this.switchController = new AbortController();

        try {
            const result = await this.switchService.switchAccount({
                email: account.email, name: account.name, accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token, expiryTimestamp: tokens.expiry_timestamp,
            });
            if (result.confirmed) {
                this.lastActiveEmail = account.email;
                log.info(`switchAccount: confirmed ${account.email}`);

                try {
                    this.cachedServer = null;
                    const serverInfo = await this.resolveServer();
                    if (!serverInfo) throw new Error('no server');
                    const localData = await this.serverDiscovery.fetchLocalQuota(serverInfo).catch(() => null);
                    if (localData) {
                        this.lastLocalData = localData;
                        this.updateStatusBar(localData);
                    }
                } catch (e: any) {
                    log.warn('Post-switch local fetch failed:', e?.message);
                }

                this.pushCachedData();
                setTimeout(() => this.refresh(), QuotaManager.POST_SWITCH_REFRESH_DELAY);
            } else {
                // USS state was set but LS unavailable — will recover on next LS restart
                log.warn(`switchAccount: unconfirmed for ${account.email}`);
                this.lastActiveEmail = account.email;
                this.cachedServer = null;
            }
        } finally {
            this.switchController = null;
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

    // ── Private Helpers ─────────────────────────────────────────

    /** Workspace ID matching LS --workspace_id format: slashes+hyphens → underscores */
    private getWorkspaceId(): string | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return undefined;
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

    /** Diagnostic probe: log raw LS remainingFraction per model (only in diag mode) */
    private logQuotaFractions(data: LocalQuotaData): void {
        const configs = data.userStatus?.cascadeModelConfigData?.clientModelConfigs;
        if (!configs) return;
        const fracs = configs
            .filter((m: any) => m.quotaInfo?.remainingFraction !== undefined)
            .map((m: any) => `${m.label || '?'}=${m.quotaInfo.remainingFraction}`);
        if (fracs.length > 0) log.diag(`quota fractions: [${fracs.join(', ')}]`);
    }
}