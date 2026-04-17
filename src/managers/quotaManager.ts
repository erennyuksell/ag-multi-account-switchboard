import * as vscode from 'vscode';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { AccountQuota, LocalQuotaData, ClientModelConfig, USSApi } from '../types';
import { AccountManager } from './accountManager';
import { ServerDiscoveryService } from '../services/serverDiscovery';
import { AccountSwitchService } from '../services/accountSwitch';
import { TokenBaseService, TokenBaseData, WorkspaceContextData } from '../services/tokenBase';
import { QuotaViewProvider } from '../providers/quotaViewProvider';
import { STATE_DB_PATH } from '../constants';
import { extractStringField } from '../utils/protobuf';
import { createLogger } from '../utils/logger';

const log = createLogger('QuotaManager');

const execAsync = promisify(exec);

export class QuotaManager {
    private statusBarItem: vscode.StatusBarItem;
    private lastLocalData: LocalQuotaData | null = null;
    private lastTrackedQuotas: AccountQuota[] = [];
    private viewProvider: QuotaViewProvider | null = null;
    private _refreshInFlight = false;
    private readonly serverDiscovery = new ServerDiscoveryService();
    private readonly switchService: AccountSwitchService;
    private readonly tokenBaseService = new TokenBaseService();
    private lastTokenBase: TokenBaseData | null = null;
    private lastWorkspaceContext: WorkspaceContextData | null = null;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly accountManager: AccountManager,
    ) {
        this.switchService = new AccountSwitchService(context, accountManager.getAuthService());
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = 'ag.refreshQuota';
        this.statusBarItem.text = '$(pulse) Antigravity Quota: Loading...';
        this.statusBarItem.show();
        context.subscriptions.push(this.statusBarItem);
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

        // Initial fetch; subsequent refreshes driven by webview interval picker
        this.refresh();
    }

    getSwitchService(): AccountSwitchService {
        return this.switchService;
    }

    setViewProvider(provider: QuotaViewProvider) {
        this.viewProvider = provider;
        if (this.lastLocalData || this.lastTrackedQuotas.length > 0) {
            this.viewProvider.updateData(this.lastLocalData, this.getSelectedModels(), this.lastTrackedQuotas, '', null, null, this.getPinnedModels());
        }
    }

    getSelectedModels(): string[] {
        return this.context.globalState.get<string[]>('ag.selectedStatusBarModels', []);
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
        log.info(`pushCachedData: hasLocal=${hasLocal}, trackedCount=${this.lastTrackedQuotas.length}`);
        if (hasLocal || hasTracked) {
            this.viewProvider.updateData(
                this.lastLocalData,
                this.getSelectedModels(),
                this.lastTrackedQuotas,
                '',
                this.lastTokenBase,
                this.lastWorkspaceContext,
                this.getPinnedModels(),
            );
        }
    }

    /** Background refresh — no spinner, just silently update */
    async refreshSilent() {
        await this.refresh();
    }

    async refresh(activeEmailHint?: string) {
        if (this._refreshInFlight) { log.info('refresh: SKIPPED (_refreshInFlight=true)'); return; }
        this._refreshInFlight = true;
        log.info('refresh: STARTED');
        try {
            // Only show loading spinner when there is truly no data to display.
            // If stale data exists, keep it visible while refreshing in the background.
            const hasData = !!(this.lastLocalData || this.lastTrackedQuotas.length > 0);
            if (this.viewProvider && !hasData) this.viewProvider.setLoading();

            // Discover workspace LS once — share with both quota fetch and token budget
            const workspaceId = this.getWorkspaceId();
            const serverInfo = await this.serverDiscovery.discover(workspaceId).catch(() => null);

            // Parallel: local server + all tracked accounts + active email + workspace context
            const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? '';
            const workspaceFsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            const [localResult, trackedResult, tokenBase, workspaceContext] = await Promise.all([
                serverInfo ? this.serverDiscovery.fetchLocalQuota(serverInfo).catch(() => null) : Promise.resolve(null),
                this.accountManager.refreshAllQuotas().catch(() => []),
                this.tokenBaseService.fetchTokenBase(serverInfo, workspaceId).catch(() => null),
                serverInfo ? this.tokenBaseService.fetchWorkspaceContext(serverInfo, workspaceName, workspaceFsPath).catch(() => null) : Promise.resolve(null),
            ]);
            const activeEmail = activeEmailHint ?? await this.getActiveEmail();

            // Local (active IDE account)
            if (localResult) {
                this.lastLocalData = localResult;
                this.updateStatusBar(localResult);
            } else {
                this.lastLocalData = null;
                this.statusBarItem.text = '$(error) Antigravity: Server Not Found';
                this.statusBarItem.tooltip = 'Could not connect to local Antigravity server';
            }

            // Tracked accounts
            this.lastTrackedQuotas = trackedResult;
            this.lastTokenBase = tokenBase;
            this.lastWorkspaceContext = workspaceContext;

            // Push to webview
            log.info(`refresh: localResult=${!!localResult}, trackedCount=${trackedResult.length}, hasProvider=${!!this.viewProvider}`);
            if (this.viewProvider) {
                if (this.lastLocalData || this.lastTrackedQuotas.length > 0) {
                    this.viewProvider.updateData(this.lastLocalData, this.getSelectedModels(), this.lastTrackedQuotas, activeEmail, this.lastTokenBase, this.lastWorkspaceContext, this.getPinnedModels());
                    log.info('refresh: updateData sent');
                } else {
                    this.viewProvider.setError('Antigravity IDE server not found and no tracked accounts.');
                    log.info('refresh: setError sent (no data)');
                }
            }
        } catch (error: any) {
            const msg = error.message || 'Unknown error';
            log.info(`refresh: CAUGHT ERROR: ${msg}`);
            if (this.viewProvider) this.viewProvider.setError(msg);
            this.statusBarItem.text = '$(error) Antigravity: Error';
            this.statusBarItem.tooltip = msg;
        } finally {
            this._refreshInFlight = false;
            log.info('refresh: FINISHED');
        }
    }

    /** Refresh ONLY token budget + workspace context — no account quota fetching */
    async refreshTokenOnly() {
        if (this._refreshInFlight) return;
        this._refreshInFlight = true;
        try {
            if (this.viewProvider) this.viewProvider.setLoading();

            const workspaceId = this.getWorkspaceId();
            const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? '';
            const workspaceFsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            const serverInfo = await this.serverDiscovery.discover(workspaceId).catch(() => null);

            const [tokenBase, workspaceContext] = await Promise.all([
                this.tokenBaseService.fetchTokenBase(serverInfo, workspaceId).catch(() => null),
                serverInfo ? this.tokenBaseService.fetchWorkspaceContext(serverInfo, workspaceName, workspaceFsPath).catch(() => null) : Promise.resolve(null),
            ]);

            this.lastTokenBase = tokenBase;
            this.lastWorkspaceContext = workspaceContext;

            if (this.viewProvider) {
                const activeEmail = await this.getActiveEmail();
                this.viewProvider.updateData(
                    this.lastLocalData,
                    this.getSelectedModels(),
                    this.lastTrackedQuotas,
                    activeEmail,
                    this.lastTokenBase,
                    this.lastWorkspaceContext,
                    this.getPinnedModels(),
                );
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
            // Pass email directly — skip USS/sqlite3 which may still be stale.
            // Switch is confirmed (success === true), so this is not optimistic.
            await this.refresh(account.email);

            // Delayed refresh (3s): USS should now be in sync — read from it normally.
            setTimeout(() => this.refresh(), 3000);
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

    /** Read active IDE email from USS API or antigravityAuthStatus */
    private async getActiveEmail(): Promise<string> {
        try {
            // Try USS API first (in-memory, most accurate)
            const uss: USSApi | undefined = (vscode as any).antigravityUnifiedStateSync;
            if (uss?.UserStatus?.getUserStatus) {
                const statusBinary = await uss.UserStatus.getUserStatus();
                if (statusBinary) {
                    const bytes = typeof statusBinary === 'string'
                        ? Buffer.from(statusBinary, 'base64')
                        : Buffer.from(statusBinary);
                    const email = extractStringField(bytes, 7);
                    if (email) return email;
                }
            }
        } catch (e: any) {
            log.warn('USS email read failed:', e?.message);
        }

        try {
            // Fallback: read from antigravityAuthStatus in state.vscdb
            const sql = "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus';";
            const { stdout } = await execAsync(`sqlite3 "${STATE_DB_PATH}" "${sql}"`, {
                timeout: 5000,
            });
            const result = stdout.trim();
            if (result) {
                try {
                    const parsed = JSON.parse(result);
                    return parsed.email || '';
                } catch {
                    log.warn('Invalid JSON in antigravityAuthStatus');
                }
            }
        } catch (e: any) {
            log.warn('DB email read failed:', e?.message);
        }

        return '';
    }

    private updateStatusBar(data: LocalQuotaData): void {
        const rawModels = data.userStatus?.cascadeModelConfigData?.clientModelConfigs;
        if (!rawModels || rawModels.length === 0) return;

        // Sort by label for consistent ordering
        const sortedModels = [...rawModels].sort((a, b) => (a.label || '').localeCompare(b.label || ''));

        const selectedIds = this.getSelectedModels();
        const selectedModels = sortedModels.filter(m => selectedIds.includes(m.modelOrAlias?.model || ''));

        if (selectedModels.length === 0) {
            this.statusBarItem.text = '$(pulse) Quota: No Model Selected';
        } else {
            const parts = selectedModels.map(m => {
                const pct = getQuotaPercent(m);
                if (pct === null) return `⚪ ${m.label}: N/A`;
                const icon = pct >= 100 ? '🟢' : pct <= 0 ? '🔴' : '🟡';
                return `${icon} ${m.label}: ${pct.toFixed(0)}%`;
            });
            this.statusBarItem.text = parts.join('  |  ');
        }

        // Rich tooltip
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.appendMarkdown('**Antigravity Quota Models**\n\n---\n\n');

        for (const m of sortedModels) {
            if (!m.quotaInfo) continue;
            const pct = getQuotaPercent(m);
            const icon = pct === null ? '⚪' : pct >= 100 ? '🟢' : pct <= 0 ? '🔴' : '🟡';
            const pctStr = pct === null ? 'N/A' : `${pct.toFixed(0)}%`;

            const resetTime = m.quotaInfo.resetTime ? new Date(m.quotaInfo.resetTime) : null;
            const isValid = resetTime && !isNaN(resetTime.getTime());
            const diffMs = isValid ? resetTime.getTime() - Date.now() : 0;

            let timeDiff = '';
            if (isValid && diffMs > 0) {
                const h = Math.floor(diffMs / 3_600_000);
                const min = Math.floor((diffMs % 3_600_000) / 60_000);
                if (h >= 24) {
                    const d = Math.floor(h / 24);
                    const rh = h % 24;
                    timeDiff = rh > 0 ? `(${d}d ${rh}h left)` : `(${d}d left)`;
                } else {
                    timeDiff = h > 0 ? `(${h}h ${min}m left)` : `(${min}m left)`;
                }
            } else {
                timeDiff = '(Reset)';
            }

            const timeStr = isValid
                ? resetTime.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                : 'Unknown';
            const sel = selectedIds.includes(m.modelOrAlias?.model || '') ? ' *(Selected)*' : '';

            md.appendMarkdown(`${icon} **${m.label}** (${pctStr})${sel}\n\n`);
            md.appendMarkdown(`*Resets:* ${timeStr} ${timeDiff}\n\n---\n\n`);
        }

        this.statusBarItem.tooltip = md;
    }
}

// ==================== Standalone Helpers ====================

/**
 * Extract quota percentage from a model config.
 * Returns null if data is unavailable (vs. 0 which means "quota exhausted").
 */
function getQuotaPercent(m: ClientModelConfig): number | null {
    if (m.quotaInfo?.remainingFraction === undefined) return null;
    return Math.max(0, Math.min(100, m.quotaInfo.remainingFraction * 100));
}