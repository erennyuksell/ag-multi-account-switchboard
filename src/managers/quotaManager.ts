import * as vscode from 'vscode';
import { PollLock } from '../utils/pollLock';
import { AccountQuota, AccountCard, ModelCard, LocalQuotaData, ServerInfo, ViewState, DeepUsageStats } from '../types';
import { AccountManager } from './accountManager';
import { ServerDiscoveryService } from '../services/serverDiscovery';
import { AccountSwitchService } from '../services/accountSwitch';
import { TokenBaseService, TokenBaseData, WorkspaceContextData } from '../services/tokenBase';
import { UsageStatsService } from '../services/usage';
import { ContextWindowService, ContextWindowData } from '../services/contextWindow';
import { LiveStream } from '../services/liveStream';
import { StatusBarService } from '../services/statusBar';
import { ContextDetailPanel } from '../providers/contextDetailPanel';
import { EmailResolver } from '../services/emailResolver';
import { shortModelName } from '../shared/helpers';
import { QuotaViewProvider } from '../providers/quotaViewProvider';
import { createLogger } from '../utils/logger';

const log = createLogger('QuotaManager');

const diagPath = '/tmp/ag-ctx-diag.log';
function diag(msg: string) {
    try { require('fs').appendFileSync(diagPath, `[${new Date().toISOString()}] QM: ${msg}\n`); } catch { }
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
    /** Last known active email — used by pushCachedData to maintain consistent UI */
    private lastActiveEmail = '';

    private static readonly CTX_CACHE_KEY = 'ag.lastContextWindow';
    private currentUsageRange: string = '24h';

    // Server discovery cache — avoids redundant ps+lsof shell spawns
    private cachedServer: { info: ServerInfo | null; ts: number } | null = null;
    private static readonly SERVER_CACHE_TTL = 60_000; // 60s

    // Cascade (Global) LS cache — separate from workspace LS.
    // Context window + LiveStream must use the Global LS for live data.
    // Global LS port is stable across IDE reloads; 10 min TTL avoids redundant ps+lsof.
    private cachedCascadeServer: { info: ServerInfo | null; ts: number } | null = null;
    private static readonly CASCADE_SERVER_TTL = 600_000; // 10 min

    /** Suppress all refreshes during programmatic switch to prevent stale intermediate renders */
    private _switchMuteUntil = 0;


    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly accountManager: AccountManager,
    ) {
        this.switchService = new AccountSwitchService(context, accountManager.getAuthService());
        this.statusBar = new StatusBarService(context);
        // Ensure token renewal timer is cleaned up on extension deactivation
        context.subscriptions.push({ dispose: () => this.switchService.dispose() });
        context.subscriptions.push({ dispose: () => this.liveStream.destroy() });

        // Live stream → real-time context offset during AI response
        this._initLiveStreamListener();

        // Register manual refresh callback for the detail panel's Refresh button
        ContextDetailPanel.setRefreshCallback(async () => {
            if (this.lastContextConversationId) {
                this.contextWindowService.invalidateCache(this.lastContextConversationId);
                await this._executeFetch(this.lastContextConversationId);
            }
        });

        // External account switch detection handled by USS userStatus topic listener
        // in extension.ts (startUserStatusListener). No fs.watch needed.

        // Context window: start fresh — USS determines when to fetch.
        this.lastContextWindow = null;
        this.lastContextConversationId = null;
        this.context.globalState.update(QuotaManager.CTX_CACHE_KEY, null);

        // Initial fetch; subsequent refreshes driven by webview interval picker
        this.refresh();

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
            accountCards: this.buildAccountCards(),
            pinnedModels: this.getPinnedModels(),
            tokenBase: this.lastTokenBase,
            workspaceContext: this.lastWorkspaceContext,
            usageStats: this.getRangeFilteredStats(),
        };
    }

    /**
     * SSOT: Build pre-processed, sorted, deduped account cards.
     * All data logic lives HERE — renderer does zero processing.
     */
    private buildAccountCards(): AccountCard[] {
        const ae = (this.lastActiveEmail || '').toLowerCase();
        const cards: AccountCard[] = [];
        const selectedModels = this.getSelectedModels();

        // 1. Local LS card
        const status = this.lastLocalData?.userStatus;
        const localEmail = (status?.email || '').toLowerCase();

        if (status) {
            const rawModels = (status.cascadeModelConfigData?.clientModelConfigs || [])
                .filter((m: any) => m.quotaInfo)
                .sort((a: any, b: any) => (a.label || '').localeCompare(b.label || ''));

            const models: ModelCard[] = rawModels.map((m: any) => ({
                id: m.modelOrAlias?.model || m.label,
                label: m.label || shortModelName(m.modelOrAlias?.model),
                pct: m.quotaInfo.remainingFraction !== undefined
                    ? Math.max(0, Math.min(100, Math.round(m.quotaInfo.remainingFraction * 100)))
                    : 0,
                resetTime: m.quotaInfo.resetTime || '',
                isLocal: true,
            }));

            const bn = models.length > 0 ? models.reduce((a, b) => a.pct < b.pct ? a : b) : null;
            const ut = status.userTier || {} as any;
            const ps = status.planStatus || {} as any;
            const pi = ps.planInfo || {} as any;
            const aiCreds = (ut.availableCredits || []).find((c: any) => c.creditType === 'GOOGLE_ONE_AI');

            cards.push({
                email: status.email || 'active-local',
                isActive: !ae || ae === localEmail,
                models,
                bottleneck: bn,
                tierName: ut.name || null,
                tierId: ut.id || null,
                aiCredits: aiCreds ? parseInt(aiCreds.creditAmount, 10) : null,
                promptCredits: ps.availablePromptCredits ?? null,
                promptCreditsMax: pi.monthlyPromptCredits || null,
                flowCredits: ps.availableFlowCredits ?? null,
                flowCreditsMax: pi.monthlyFlowCredits || null,
                resetTime: bn?.resetTime || models[0]?.resetTime || '',
                isError: false,
                selectedModels,
                isLocal: true,
            });
        }

        // 2. Tracked accounts
        // Dedup: ALWAYS skip tracked if its email matches the local card.
        // Local card has richer data (labels, credits, checkboxes) regardless of active state.
        // During switch A→B: local=A(stale), tracked A must still be deduped to avoid duplicate.
        const dedupEmail = localEmail || '';

        for (const tq of this.lastTrackedQuotas) {
            const taEmail = (tq.account.email || '').toLowerCase();
            if (dedupEmail && taEmail === dedupEmail) continue;

            const models: ModelCard[] = (tq.models || []).map(m => ({
                id: m.name,
                label: shortModelName(m.name),
                pct: m.percentage || 0,
                resetTime: m.resetTimeRaw || m.resetTime || '',
                isLocal: false,
            }));

            const bn = models.length > 0 ? models.reduce((a, b) => a.pct < b.pct ? a : b) : null;

            cards.push({
                email: tq.account.email || 'Unknown',
                name: tq.account.name,
                isActive: !!(ae && ae === taEmail),
                trackingId: tq.account.id,
                models,
                bottleneck: bn,
                tierName: tq.tierName || tq.tier || null,
                resetTime: bn?.resetTime || '',
                isError: tq.isError || tq.isForbidden,
                errorMessage: tq.isForbidden ? 'Access forbidden' : (tq.errorMessage || ''),
                selectedModels: [],
                isLocal: false,
                aiCredits: null,
                promptCredits: null,
                promptCreditsMax: null,
                flowCredits: null,
                flowCreditsMax: null,
            });
        }

        // 3. Sort: active first (stable)
        cards.sort((a, b) => (a.isActive ? 0 : 1) - (b.isActive ? 0 : 1));

        return cards;
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
        const wsServer = await this.resolveServer();
        const info = await this.serverDiscovery.discoverCascadeServer(cascadeId, wsServer).catch(() => null);
        // Only cache successful discoveries — null means the cascade doesn't exist
        // yet (brand new conversation). Next attempt should re-discover.
        if (info) {
            this.cachedCascadeServer = { info, ts: Date.now() };
        }
        diag(`resolveCascadeServer: port=${info?.port ?? 'null'} (wsPort=${wsServer?.port ?? 'null'})`);
        return info;
    }

    // ── Debounced Context Fetch (USS-driven) ──

    private _ctxDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Debounced context window fetch — called by USS trajectorySummaries.
     * Coalesces rapid-fire events (USS often fires 2x) into a single fetch.
     */
    debouncedContextFetch(cascadeId: string): void {
        if (this._ctxDebounceTimer) clearTimeout(this._ctxDebounceTimer);
        this._ctxDebounceTimer = setTimeout(() => {
            this._ctxDebounceTimer = null;
            this._executeFetch(cascadeId);
        }, 1500);
    }

    /**
     * Set the active conversation for context tracking.
     * Called on conversation switch (USS activeCascade).
     * Also starts live stream for real-time offset hints.
     */
    setActiveConversation(cascadeId: string): void {
        this.lastContextConversationId = cascadeId;
        // Invalidate cascade server cache on conversation switch
        // so we re-discover the correct Global LS for the new cascade.
        this.cachedCascadeServer = null;
        diag(`setActiveConversation: ${cascadeId.substring(0, 12)}`);
        // Start live stream on Global LS — it has live cascade data.
        this.resolveCascadeServer(cascadeId).then(cascadeServer => {
            const server = cascadeServer;
            if (server) {
                diag(`setActiveConversation: connecting liveStream port=${server.port}`);
                this.liveStream.connect(server, cascadeId);
            } else {
                // Fallback to workspace LS
                this.resolveServer().then(ws => {
                    if (ws) {
                        diag(`setActiveConversation: liveStream fallback to wsLS port=${ws.port}`);
                        this.liveStream.connect(ws, cascadeId);
                    } else {
                        diag('setActiveConversation: no server for liveStream');
                    }
                }).catch(() => {});
            }
        }).catch(err => diag(`setActiveConversation: resolveCascadeServer failed: ${(err as Error)?.message}`));
    }

    // ── Live Stream (real-time totalLength for context offset) ──

    private readonly liveStream = new LiveStream();
    private _lastLiveTotalLength = 0;

    private _initLiveStreamListener(): void {
        this.liveStream.on('totalLength', async (event: { totalLength: number; conversationId: string }) => {
            const server = this.cachedServer?.info;
            if (!server || !event.conversationId) return;
            if (event.conversationId !== this.lastContextConversationId) return;
            // Race guard: only fetch if totalLength is increasing
            if (event.totalLength <= this._lastLiveTotalLength) return;
            this._lastLiveTotalLength = event.totalLength;

            try {
                const data = await this.contextWindowService.fetchLastEntry(
                    server,
                    event.conversationId,
                    event.totalLength,
                    this.lastContextWindow?.title || 'Conversation',
                );
                // Stale check: skip if newer delta arrived while fetching
                if (event.totalLength < this._lastLiveTotalLength) return;
                if (data) {
                    this._pushContextUpdate(data, event.conversationId, server);
                }
            } catch { /* live fetch failed, USS will handle it */ }
        });
    }

    /**
     * One-shot context window fetch — used on conversation switch and stream triggers.
     * No debounce, no retry, no polling. STREAM→IDLE handles subsequent updates.
     */
    async fetchContextWindowOnce(cascadeId: string) {
        return this._executeFetch(cascadeId, true);
    }

    /**
     * Internal: single fetch path for all context window requests (DRY).
     * @param setActive - if true, sets this cascade as the active conversation
     */
    private async _executeFetch(cascadeId: string, setActive = false) {
        if (setActive) {
            this.lastContextConversationId = cascadeId;
        }
        const shortId = cascadeId.substring(0, 12);
        diag(`fetchCW: ${shortId}`);
        try {
            this.contextWindowService.invalidateCache(cascadeId);
            // Use Global LS for context window — it has live cascade data.
            // Falls back to workspace LS if cascade server not found.
            const cascadeServer = await this.resolveCascadeServer(cascadeId);
            const serverInfo = cascadeServer ?? await this.resolveServer();
            if (!serverInfo) { diag('fetchCW: no server'); return; }

            await this.refreshContextWindow(serverInfo, cascadeId);
            diag(`fetchCW: done — tokens=${this.lastContextWindow?.usedTokens ?? 0} (port=${serverInfo.port})`);
        } catch (err) {
            // Invalidate cascade cache on failure — server may have restarted
            this.cachedCascadeServer = null;
            diag(`fetchCW FAILED: ${(err as Error)?.message}`);
            log.info(`fetchCW: FAILED ${(err as Error)?.message}`);
        }
    }

    /** DRY: push context window data to sidebar + detail panel + globalState */
    private _pushContextUpdate(data: ContextWindowData, cascadeId: string, server: ServerInfo | null): void {
        if (cascadeId !== this.lastContextConversationId) {
            log.info(`Context window: conversation → ${cascadeId.substring(0, 12)}`);
            this.lastContextConversationId = cascadeId;
        }
        this.lastContextWindow = data;
        this.context.globalState.update(QuotaManager.CTX_CACHE_KEY, data);
        if (this.viewProvider) {
            this.viewProvider.postContextWindow(data);
        }
        ContextDetailPanel.pushUpdate(data, server);
        // Live context status bar update
        if (data.usedTokens > 0 && data.maxTokens > 0) {
            this.statusBar.updateContext(data.usedTokens, data.maxTokens, data.model);
        }
        diag(`pushCW: tokens=${data.usedTokens} (${data.model})`);
    }

    async refresh(activeEmailHint?: string) {
        // During programmatic switch, suppress ALL refresh triggers (timer, DB watcher)
        // to prevent premature renders from USS early-push. The definitive render
        // comes from the explicit pushCachedData() after switchAccount confirms.
        if (Date.now() < this._switchMuteUntil) {
            log.info('refresh: SUPPRESSED (switch in progress)');
            return;
        }

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
            const t0 = Date.now();
            const serverInfo = await this.resolveServer();
            const tDiscover = Date.now() - t0;

            // Parallel: local server + all tracked accounts + active email + workspace context
            const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? '';
            const workspaceFsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            const t1 = Date.now();
            const [localResult, trackedResult, tokenBase, workspaceContext] = await Promise.all([
                serverInfo ? this.serverDiscovery.fetchLocalQuota(serverInfo).catch(() => null) : Promise.resolve(null),
                this.accountManager.refreshAllQuotas().catch(() => []),
                this.tokenBaseService.fetchTokenBase(serverInfo, this.getWorkspaceId()).catch(() => null),
                serverInfo ? this.tokenBaseService.fetchWorkspaceContext(serverInfo, workspaceName, workspaceFsPath).catch(() => null) : Promise.resolve(null),
            ]);
            const tFetch = Date.now() - t1;

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

            const t2 = Date.now();
            const activeEmail = activeEmailHint ?? await this.getActiveEmail();
            this.lastActiveEmail = activeEmail;
            const tEmail = Date.now() - t2;

            log.info(`refresh: TIMING discover=${tDiscover}ms fetch=${tFetch}ms email=${tEmail}ms total=${Date.now() - t0}ms`);

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
                    this.viewProvider.updateData(this.buildViewState());
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
                }, (done, total) => {
                    // Push scan progress to webview
                    this.viewProvider?.postMessage({ type: 'scanProgress', done, total });
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
        diag(`refreshCW: fetching for ${cascadeId.substring(0, 12)}`);
        try {
            const ctx = await this.contextWindowService.getContextForCascade(serverInfo, cascadeId);

            if (!ctx) {
                diag(`refreshCW: ctx is null for ${cascadeId.substring(0, 12)}`);
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

            diag(`refreshCW: got data — title="${ctx.title?.substring(0, 30)}" tokens=${ctx.usedTokens}/${ctx.maxTokens} convId=${ctx.conversationId?.substring(0, 12)}`);

            this._pushContextUpdate(ctx, ctx.conversationId, serverInfo);
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
                this.lastActiveEmail = activeEmail;
                this.viewProvider.updateData(this.buildViewState());
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

        // Mute DB watcher during switch — prevents stale renders from writeAuthStatusToDb.
        // Definitive refresh comes from this.refresh() after switchAccount returns.
        this._switchMuteUntil = Date.now() + 5000;

        const result = await this.switchService.switchAccount({
            email: account.email, name: account.name, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiryTimestamp: tokens.expiry_timestamp,
        });
        if (result.confirmed) {
            // LS confirmed new email. Fetch local data via CACHED server (0ms discovery + ~200ms HTTP).
            this.lastActiveEmail = account.email;
            log.info(`switchAccount: confirmed ${account.email}, fetching local data`);

            try {
                // Invalidate server cache — LS may have changed ports after switch,
                // and cached server might point to an LS instance still serving old data.
                this.cachedServer = null;
                const serverInfo = await this.resolveServer();
                if (serverInfo) {
                    const localData = await this.serverDiscovery.fetchLocalQuota(serverInfo).catch(() => null);
                    // ── FORENSIC: log what fetchLocalQuota actually returned ──
                    const lqEmail = localData?.userStatus?.email || '(none)';
                    const lqModels = localData?.userStatus?.cascadeModelConfigData?.clientModelConfigs?.length ?? 0;
                    const lqTier = localData?.userStatus?.userTier?.name || '(none)';
                    log.info(`FORENSIC postSwitch: email=${lqEmail} models=${lqModels} tier=${lqTier} expected=${account.email}`);
                    if (localData) {
                        this.lastLocalData = localData;
                        this.updateStatusBar(localData);
                    }
                }
            } catch (e: any) {
                log.warn('Post-switch local fetch failed:', e?.message);
            }

            // Instant render — local card with correct active email + tracked cards from cache
            this.pushCachedData();

            // Background full refresh for tracked quotas, token base, workspace context
            setTimeout(() => this.refresh(), 2000);
        } else {
            // Recovery: LS wasn't available during switch, but USS state was set
            // (token + email pushed at steps 1-4). When LS comes back, it will
            // pick up the new token from USS. Clear the mute guard so the
            // USS userStatus listener can naturally trigger a refresh.
            log.warn(`switchAccount: unconfirmed for ${account.email} — recovery: clearing mute guard`);
            this.lastActiveEmail = account.email;
            this._switchMuteUntil = 0;
            this.cachedServer = null;
            // USS listener already detected email change → refresh will fire when unmuted
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