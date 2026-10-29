import * as vscode from 'vscode';
import { callLsJson } from '../utils/lsClient';
import { PollLock } from '../utils/pollLock';
import { AccountQuota, AccountCard, LocalQuotaData, ServerInfo, ViewState, DeepUsageStats } from '../types';
import { AccountManager } from './accountManager';
import { buildAccountCards } from './accountCardBuilder';
import { isAgyMode, readAgyIdentity } from '../services/agyAuth';
import { ServerDiscoveryService } from '../services/serverDiscovery';
import { AccountSwitchService } from '../services/accountSwitch';
import { TokenBaseService, TokenBaseData, WorkspaceContextData } from '../services/tokenBase';
import { UsageStatsService } from '../services/usage';
import { ContextWindowService, ContextWindowData } from '../services/contextWindow';
import { LiveStream } from '../services/liveStream';
import { StatusBarService } from '../services/statusBar';
import { ContextDetailPanel } from '../providers/contextDetailPanel';
import { UsageStatsPanel } from '../providers/usageStatsPanel';
import { EmailResolver } from '../services/emailResolver';

import { QuotaViewProvider } from '../providers/quotaViewProvider';
import { createLogger } from '../utils/logger';

const log = createLogger('QuotaManager');

export class QuotaManager {
    private readonly statusBar: StatusBarService;
    private readonly emailResolver = new EmailResolver();
    private lastLocalData: LocalQuotaData | null = null;
    /** When lastLocalData was read from the LS — drives the freshness badge. */
    private lastLocalDataAt = 0;
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
    /** Last known active email — resolved from USS, the IDE's own source of truth */
    private lastActiveEmail = '';
    /**
     * Account a running switch is heading for. Separate from lastActiveEmail so
     * a request is never rendered as the account actually in use; cleared when
     * the switch settles.
     */
    private pendingSwitchEmail = '';
    /**
     * What the panel was last told to show, newest last. Read by the dev
     * control channel to measure how long a window's panel lags behind a
     * switch; costs nothing when nobody asks.
     */
    private readonly renderHistory: Array<{ t: number; active: string; pending: string; local: string; reason: string }> = [];
    private static readonly RENDER_HISTORY_MAX = 40;
    /** Set once this window has run a refresh of its own. */
    private hasRefreshed = false;
    /** Generation for the identity-change follow-up so only the newest runs. */
    private identityRun = 0;

    private static readonly CTX_CACHE_KEY = 'ag.lastContextWindow';
    private static readonly CASCADE_ID_LOG_LEN = 12;
    private static readonly POST_SWITCH_REFRESH_DELAY = 2000;
    /** Retry budget for re-acquiring local LS data while the LS restarts post-switch */
    private static readonly POST_SWITCH_LOCAL_ATTEMPTS = 6;
    private static readonly POST_SWITCH_LOCAL_DELAY_MS = 1500;
    private static readonly DEBOUNCE_MS = 1500;
    /** Identity-change follow-up: how often and how long to re-read the local LS. */
    private static readonly IDENTITY_FOLLOW_INTERVAL_MS = 1_500;
    private static readonly IDENTITY_FOLLOW_MAX_MS = 30_000;
    /** Host-side polling interval — runs regardless of panel visibility */
    private static readonly HOST_POLL_INTERVAL_MS = 60_000;
    private currentUsageRange = '24h';

    private cachedServer: { info: ServerInfo | null; ts: number } | null = null;
    private static readonly SERVER_CACHE_TTL = 60_000;
    /** TTL for a failed discovery — short, so a starting LS is picked up quickly. */
    private static readonly SERVER_CACHE_TTL_MISS = 3_000;
    /** Bounded fast retries while the LS is still coming up. */
    private static readonly SERVER_RETRY_MAX = 6;
    private static readonly SERVER_RETRY_DELAY_MS = 3_000;

    // Global LS port is stable across IDE reloads; separate from workspace LS cache.
    private cachedCascadeServer: { info: ServerInfo | null; ts: number } | null = null;
    private static readonly CASCADE_SERVER_TTL = 600_000;
    /** Lifecycle-scoped switch guard. AbortController so double-click aborts previous switch. */
    private switchController: AbortController | null = null;
    private hostPollTimer: ReturnType<typeof setInterval> | null = null;
    private serverRetryTimer: ReturnType<typeof setTimeout> | null = null;
    private serverRetryCount = 0;
    /** Generation counter so only the newest post-switch refresh loop survives. */
    private postSwitchRun = 0;

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
        context.subscriptions.push({ dispose: () => { if (this.serverRetryTimer) clearTimeout(this.serverRetryTimer); } });
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
        const cards = buildAccountCards(
            this.lastLocalData,
            this.lastTrackedQuotas,
            this.lastActiveEmail,
            !!this.switchController,
            this.getSelectedModels(),
            this.lastLocalDataAt,
            this.pendingSwitchEmail,
        );
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
        const ctxId = this.lastContextWindow?.conversationId?.substring(0, 12) || 'none';
        log.info(`pushCachedData: hasLocal=${hasLocal}, trackedCount=${this.lastTrackedQuotas.length}, ctxFor=${ctxId}, active=${this.lastContextConversationId?.substring(0, 12) || 'none'}`);

        if (hasLocal || hasTracked) {
            const state = this.buildViewState();
            this.viewProvider.updateData(state);
            this.recordRender(state.accountCards, 'push');
            // Push cached context window if available — NO re-fetch here
            if (this.lastContextWindow) {
                this.viewProvider.postContextWindow(this.lastContextWindow);
            }
            // Also update status bar from cached local data to prevent stale "Server Not Found"
            if (this.lastLocalData) this.updateStatusBar(this.lastLocalData);
            return;
        }

        // Nothing fetched yet — the cold-start case. Render the accounts we
        // already know about so the panel drops its splash right away instead
        // of sitting on it for the whole first refresh, which waits on the
        // cloud API and on an LS that needs ~60s to answer after an IDE start.
        // Quotas fill in as they land; a card with no models still shows who
        // is signed in and lets the user switch.
        const known = this.accountManager.getAccounts();
        if (known.length === 0) return;

        this.lastTrackedQuotas = known.map(account => ({
            account,
            models: [],
            tier: null,
            tierName: null,
            isForbidden: false,
            isError: false,
            lastUpdated: 0,
        }));
        log.info(`pushCachedData: rendering ${known.length} account(s) from storage while the first refresh runs`);
        this.viewProvider.updateData(this.buildViewState());
    }

    // ── Shared server resolution (DRY: used by refresh, refreshTokenOnly, fetchCtxIndependent) ──

    private async resolveServer(forceRefresh = false): Promise<ServerInfo | null> {
        // A miss gets a much shorter TTL than a hit. The language server opens
        // its sockets before it starts serving, so a probe during IDE startup
        // legitimately fails — and caching that null for a full minute pinned
        // the status bar to "Server Not Found" long after the LS was ready.
        const ttl = this.cachedServer?.info
            ? QuotaManager.SERVER_CACHE_TTL
            : QuotaManager.SERVER_CACHE_TTL_MISS;
        if (!forceRefresh && this.cachedServer && Date.now() - this.cachedServer.ts < ttl) {
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
            // Use Global/Cascade LS — workspace LS has stale snapshots (hours old)
            const server = this.cachedCascadeServer?.info ?? this.cachedServer?.info;
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
        // Reject data from a conversation we've already switched away from.
        // This prevents the boot fetch (slow LS response) from overwriting
        // a quicker switch fetch that completed first.
        if (cascadeId !== this.lastContextConversationId) {
            log.info(`pushCW: REJECT stale ${cascadeId.substring(0, 12)} (active=${this.lastContextConversationId?.substring(0, 12)})`);
            return;
        }
        // Never overwrite newer data with older for the SAME conversation
        if (this.lastContextWindow && data.lastUpdated && this.lastContextWindow.lastUpdated) {
            if (data.lastUpdated < this.lastContextWindow.lastUpdated) {
                return;
            }
        }
        log.info(`pushCW: ACCEPT ${cascadeId.substring(0, 12)} title="${data.title?.substring(0, 25)}" tokens=${data.usedTokens}`);
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

        // The lock keeps windows from repeating the same periodic cloud calls.
        // It must not stop a window's first load: every window has its own
        // panel and they all start together, so after an IDE start or an
        // extension host restart only one panel got data and the others stayed
        // empty until a later poll happened to win (measured: 2 of 3 empty).
        const lock = new PollLock();
        if (this.hasRefreshed && !await lock.tryAcquire()) {
            log.diag('refresh: SKIPPED (lock held by another instance)');
            return;
        }

        this.refreshInFlight = true;
        this.hasRefreshed = true;
        const startTime = Date.now();
        try {
            const hasData = !!(this.lastLocalData || this.lastTrackedQuotas.length > 0);
            if (this.viewProvider && !hasData) this.viewProvider.setLoading();

            const serverInfo = await this.resolveServer();


            const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? '';
            const workspaceFsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            // Token Budget feeds a secondary tab, and with no serverInfo its
            // fallback path walks every LS endpoint at the full request timeout
            // — dead weight on a cold start. Let it settle on its own schedule
            // and repaint when it does, instead of holding the account list
            // behind the slowest thing on the panel.
            const sideloads = Promise.all([
                this.tokenBaseService.fetchTokenBase(serverInfo, this.getWorkspaceId()).catch(() => null),
                serverInfo
                    ? this.tokenBaseService.fetchWorkspaceContext(serverInfo, workspaceName, workspaceFsPath).catch(() => null)
                    : Promise.resolve(null),
            ]).then(([tokenBase, workspaceContext]) => {
                this.lastTokenBase = tokenBase;
                this.lastWorkspaceContext = workspaceContext;
                this.pushCachedData();
            }).catch(err => log.warn('token base / workspace context failed:', err?.message));
            void sideloads;

            const [localResult, trackedResult] = await Promise.all([
                serverInfo ? this.serverDiscovery.fetchLocalQuota(serverInfo).catch(() => null) : Promise.resolve(null),
                this.accountManager.refreshAllQuotas().catch(() => []),
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
                this.lastLocalDataAt = Date.now();
                this.updateStatusBar(localResult);
                this.logQuotaFractions(localResult);
                this.serverRetryCount = 0;
            } else {
                this.lastLocalData = null;
                this.lastLocalDataAt = 0;
                // Startup races are the common case here, not a real absence —
                // keep retrying briefly before settling on the error.
                const retrying = this.scheduleServerRetry();
                this.statusBar.setError(
                    retrying ? '$(sync~spin) Antigravity: Connecting...' : '$(error) Antigravity: Server Not Found',
                    retrying ? 'Waiting for the local Antigravity server' : 'Could not connect to local Antigravity server',
                );
            }

            // An empty result while accounts still exist means refreshAllQuotas
            // threw, not that the user has no accounts — don't wipe the cards.
            if (trackedResult.length > 0 || this.accountManager.getAccounts().length === 0) {
                this.lastTrackedQuotas = trackedResult;
            }

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
                    UsageStatsPanel.currentPanel?.updateLatestStats(backfilledStats);

                    this.pushCachedData();
                }, (done, total) => {
                    this.viewProvider?.postMessage({ type: 'scanProgress', done, total });
                }).then(deep => {
                    if (deep) {
                        log.diag(`refresh: fetchDeepStats done — ${deep.totalCalls} calls`);
                        this.lastUsageStats = deep;
                        UsageStatsPanel.currentPanel?.updateLatestStats(deep);
                        this.pushCachedData();
                    } else {

                    }
                }).catch(err => {
                    log.warn(`refresh: fetchDeepStats threw: ${err?.message}`);
                    if (!this.lastUsageStats) {
                        this.viewProvider?.postMessage({ 
                            type: 'usageStatsUpdate', 
                            usageStats: { error: err?.message || 'Failed to scan usage data from Antigravity server.' } 
                        });
                    }
                });
            } else {
                log.warn('refresh: serverInfo is null — skipping fetchDeepStats (no LS server found)');
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
    async switchAccount(accountId: string, opts: { skipConfirm?: boolean } = {}): Promise<{ confirmed: boolean; alreadyActive?: boolean; superseded?: boolean } | null> {
        const account = this.accountManager.getAccounts().find(a => a.id === accountId);
        if (!account) {
            vscode.window.showErrorMessage('Account not found');
            return null;
        }
        // The 2.5 language server could not refresh a token on its own, so it
        // was handed a fresh one with the longest life. 2.6 hubs refresh
        // themselves; the stored token is enough (it is still refreshed when
        // close to expiry) and skipping the round trip saves ~1s per switch.
        const tokens = await this.accountManager.getValidTokensForAccount(account.email, !isAgyMode());
        if (!tokens) {
            vscode.window.showErrorMessage(`No valid tokens for ${account.email}. Please re-add the account.`);
            return null;
        }

        if (!opts.skipConfirm) {
            const confirm = await vscode.window.showWarningMessage(
                `Switch IDE account to ${account.email}?`, { modal: true }, 'Switch',
            );
            if (confirm !== 'Switch') return null;
        }

        // Abort previous switch (double-click protection)
        this.switchController?.abort();
        this.switchController = new AbortController();

        // Say what was requested immediately — the badge announcing a switch
        // has to appear when the switch starts, not when it ends. This is the
        // request, deliberately not lastActiveEmail: that one tracks what the
        // IDE is really on.
        this.pendingSwitchEmail = account.email;
        this.pushCachedData();

        try {
            const result = await this.switchService.switchAccount({
                email: account.email, name: account.name, accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token, expiryTimestamp: tokens.expiry_timestamp,
            });
            if (result.confirmed) {
                this.lastActiveEmail = account.email;
                log.info(result.alreadyActive
                    ? `switchAccount: ${account.email} was already active — no change`
                    : `switchAccount: confirmed ${account.email}`);

                // Draw the new active account NOW. Which account is active is
                // already known at this point, so making the panel wait for LS
                // re-discovery left it showing the old one for ~6s after a
                // switch that itself completed in ~1s.
                this.pushCachedData();

                // Then re-acquire local LS data in the background.
                this.refreshLocalAfterSwitch()
                    .catch(e => log.warn('post-switch local refresh failed:', (e as Error)?.message));

                setTimeout(() => this.refresh(), QuotaManager.POST_SWITCH_REFRESH_DELAY);
            } else {
                // USS state was set but LS unavailable — will recover on next LS restart
                log.warn(`switchAccount: unconfirmed for ${account.email}${result.superseded ? ' (superseded)' : ''}`);
                // Superseded: a newer switch owns the outcome. Otherwise the
                // stored account is the best statement of where the IDE is.
                this.lastActiveEmail = isAgyMode()
                    ? (readAgyIdentity() || this.lastActiveEmail)
                    : (result.superseded ? this.lastActiveEmail : account.email);
                this.cachedServer = null;
            }
            return result;
        } finally {
            this.switchController = null;
            this.pendingSwitchEmail = '';
            // Clear the SWITCHING badge now rather than at the next poll.
            this.pushCachedData();
        }
    }

    /**
     * USS reports a different account — every window hears this, including the
     * ones that did not start the switch.
     *
     * Those windows used to run a full refresh() here, and lost: all windows
     * hear the change in the same millisecond, the cross-window refresh lock
     * lets exactly one through, and the panel of every other window kept the
     * previous account for a minute or more (measured 39s and 60s+). The one
     * that did get through read its LS mid-restart, so it drew the old
     * account's quota anyway.
     *
     * What changed is known up front, so draw it immediately, then re-read the
     * local LS (lock-free, local only — tracked quotas did not change) until it
     * reports the new account.
     */
    onIdentityChanged(email: string): void {
        if (this.switchController) return; // this window's own switch drives its panel
        // On 2.6 USS no longer decides the account — the IDE rewrites it with
        // a stale one on every extension host start — so take the stored hub
        // account and ignore USS when they disagree.
        if (isAgyMode()) email = readAgyIdentity() || email;
        if (email === this.lastActiveEmail && this.lastLocalData?.userStatus?.email === email) return;
        this.lastActiveEmail = email;
        this.pushCachedData();
        const run = ++this.identityRun;
        void this.followLocalIdentity(email, run);
    }

    private async followLocalIdentity(email: string, run: number): Promise<void> {
        const target = email.toLowerCase();
        const start = Date.now();
        while (Date.now() - start < QuotaManager.IDENTITY_FOLLOW_MAX_MS) {
            await new Promise(r => setTimeout(r, QuotaManager.IDENTITY_FOLLOW_INTERVAL_MS));
            if (run !== this.identityRun || this.switchController) return;
            this.cachedServer = null;
            const serverInfo = await this.resolveServer(true).catch(() => null);
            const localData = serverInfo
                ? await this.serverDiscovery.fetchLocalQuota(serverInfo).catch(() => null)
                : null;
            if (!localData || run !== this.identityRun) continue;
            this.lastLocalData = localData;
            this.lastLocalDataAt = Date.now();
            this.updateStatusBar(localData);
            this.pushCachedData();
            if ((localData.userStatus?.email || '').toLowerCase() === target) {
                log.info(`identity follow: local LS on ${email} after ${Date.now() - start}ms`);
                return;
            }
        }
        log.warn(`identity follow: local LS not on ${email} after ${QuotaManager.IDENTITY_FOLLOW_MAX_MS}ms`);
    }

    private recordRender(cards: AccountCard[], reason: string): void {
        const active = cards.find(c => c.isActive)?.email || '';
        const pending = cards.find(c => c.isPendingTarget)?.email || '';
        const local = cards.find(c => c.isLocal)?.email || '';
        const last = this.renderHistory[this.renderHistory.length - 1];
        if (last && last.active === active && last.pending === pending && last.local === local) return;
        this.renderHistory.push({ t: Date.now(), active, pending, local, reason });
        if (this.renderHistory.length > QuotaManager.RENDER_HISTORY_MAX) this.renderHistory.shift();
    }

    /** Read-only view of the panel state, for the dev control channel. */
    getDebugSnapshot() {
        return {
            lastActiveEmail: this.lastActiveEmail,
            pendingSwitchEmail: this.pendingSwitchEmail,
            switching: !!this.switchController,
            localEmail: this.lastLocalData?.userStatus?.email || '',
            localDataAt: this.lastLocalDataAt,
            cards: this.getAccountCards().map(c => ({
                email: c.email, isActive: !!c.isActive, isLocal: !!c.isLocal,
                isPendingTarget: !!c.isPendingTarget, dataTimestamp: c.dataTimestamp || 0,
            })),
            renderHistory: [...this.renderHistory],
        };
    }

    /** Read-only view of the Usage Stats and Token Budget data, for the dev control channel. */
    getTabsSnapshot() {
        const u = this.lastUsageStats;
        const all = u ? this.usageStatsService.getFilteredStats('all') : null;
        const day = u ? this.usageStatsService.getFilteredStats('24h') : null;
        const tb = this.lastTokenBase;
        const wc = this.lastWorkspaceContext;
        const cascades = (all?.cascades || []) as any[];
        return {
            usage: u ? {
                totalCalls: u.totalCalls, totalTokens: u.totalTokens, dateRange: u.dateRange,
                last24h: day ? { calls: day.totalCalls, tokens: day.totalTokens } : null,
                conversations: cascades.length,
                untitled: cascades.filter(c => !c.title || /^untitled$/i.test(c.title)).length,
                lastDay: (u.daily || []).slice(-1)[0]?.date,
                lastDays: (all?.daily || []).slice(-3).map(d => `${d.date}:${d.calls}`),
                top24h: ((day?.cascades || []) as any[]).slice().sort((a, b) => b.calls - a.calls).slice(0, 4).map(c => `${c.title} (${c.calls})`),
                top: cascades.slice().sort((a, b) => b.calls - a.calls).slice(0, 3).map(c => `${c.title} (${c.calls})`),
            } : null,
            tokenBase: tb ? { total: tb.totalTokens, budget: tb.customizationBudget, categories: tb.categories.map(c => `${c.name}:${c.totalTokens}`) } : null,
            workspaceContext: wc ? {
                workspace: wc.workspaceName, rules: wc.rules.length, modelDecision: wc.rulesModelDecision.length,
                manual: wc.rulesManual.length, skills: wc.skills.length, workflows: wc.workflows.length,
            } : null,
        };
    }

    getAuthService() {
        return this.accountManager.getAuthService();
    }

    getTokensForEmail(email: string) {
        return this.accountManager.getValidTokensForAccount(email, true);
    }

    getAccountIdByEmail(email: string): string | undefined {
        return this.accountManager.getAccounts().find(a => a.email.toLowerCase() === email.toLowerCase())?.id;
    }

    /**
     * Re-acquire local LS data after an account switch, redrawing when it lands.
     *
     * The language server is normally mid-restart at this moment — the switch
     * flow re-asserts the token and calls handleAuthRefresh, which can bounce
     * it — so a single probe reliably came back "no server" and the panel sat
     * without local quota until a later poll happened to catch it. Retrying
     * closes that window; running detached keeps it off the render path.
     */
    private async refreshLocalAfterSwitch(
        attempts = QuotaManager.POST_SWITCH_LOCAL_ATTEMPTS,
        delayMs = QuotaManager.POST_SWITCH_LOCAL_DELAY_MS,
    ): Promise<void> {
        // Switching twice in quick succession would otherwise leave two of these
        // loops running, and the older one could push its stale account over the
        // newer one's result seconds later.
        const run = ++this.postSwitchRun;
        this.cachedServer = null;
        for (let i = 1; i <= attempts; i++) {
            if (run !== this.postSwitchRun) {
                log.info('post-switch: superseded by a newer switch, stopping');
                return;
            }
            const serverInfo = await this.resolveServer(true).catch(() => null);
            if (serverInfo) {
                const localData = await this.serverDiscovery.fetchLocalQuota(serverInfo).catch(() => null);
                if (localData) {
                    this.lastLocalData = localData;
                    this.lastLocalDataAt = Date.now();
                    this.updateStatusBar(localData);
                    this.pushCachedData();
                    log.info(`post-switch: local data acquired on attempt ${i}`);
                    return;
                }
            }
            await new Promise(r => setTimeout(r, delayMs));
        }
        log.warn(`post-switch: local LS data still unavailable after ${attempts} attempts`);
    }

    /**
     * Queue another discovery attempt after a miss.
     * Returns true while retries remain, so the caller can say "connecting"
     * instead of declaring the server missing on the first failed probe.
     */
    private scheduleServerRetry(): boolean {
        if (this.serverRetryCount >= QuotaManager.SERVER_RETRY_MAX) return false;
        if (this.serverRetryTimer) return true;

        this.serverRetryCount++;
        this.serverRetryTimer = setTimeout(() => {
            this.serverRetryTimer = null;
            this.refresh();
        }, QuotaManager.SERVER_RETRY_DELAY_MS);
        return true;
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

    // ── Workspace Cascade Ownership ────────────────────────────

    /** Shared helper: resolve server + fetch cascade trajectory summaries */
    private async fetchCascadeSummaries(): Promise<Record<string, any> | null> {
        const server = await this.resolveServer();
        if (!server) return null;
        const resp = await callLsJson(server, 'GetAllCascadeTrajectories', {});
        const sums = resp?.trajectorySummaries;
        return (sums && typeof sums === 'object') ? sums : null;
    }

    /**
     * Fetch all cascade IDs belonging to this workspace.
     * Uses GetAllCascadeTrajectories from the workspace LS — only returns cascades
     * that are associated with this workspace, enabling cross-window isolation.
     */
    async getWorkspaceCascadeIds(): Promise<Set<string> | null> {
        try {
            const sums = await this.fetchCascadeSummaries();
            if (!sums) return null;
            const ids = new Set(Object.keys(sums));
            return ids.size > 0 ? ids : null;
        } catch (e: unknown) {
            log.info(`getWorkspaceCascadeIds: ${(e as Error)?.message}`);
            return null;
        }
    }

    /**
     * Query the LS for all cascade trajectories and return the most recently
     * modified cascade ID. USS-independent — works even when USS topics are cold.
     */
    async getMostRecentCascadeId(): Promise<string | null> {
        try {
            const sums = await this.fetchCascadeSummaries();
            if (!sums) return null;

            let best: { id: string; time: number } | null = null;
            for (const [id, summary] of Object.entries(sums) as [string, any][]) {
                const t = Number(summary?.lastModifiedTime) || 0;
                if (!best || t > best.time) best = { id, time: t };
            }
            return best?.id ?? null;
        } catch (e: unknown) {
            log.diag(`getMostRecentCascadeId: ${(e as Error)?.message}`);
            return null;
        }
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
