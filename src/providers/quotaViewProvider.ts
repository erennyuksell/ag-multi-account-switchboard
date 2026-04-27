import * as vscode from 'vscode';
import { ViewState } from '../types';
import { QuotaManager } from '../managers/quotaManager';
import { getWebviewContent } from '../templates/webviewTemplate';
import { getPricing } from '../shared/usage-components';
import { createLogger } from '../utils/logger';

const log = createLogger('ViewProvider');

export class QuotaViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly quotaManager: QuotaManager,
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'weblog':
                    log.info(`[WEBVIEW_LOG] ${msg.msg}`);
                    break;
                case 'ready':
                    log.info('MSG: ready received');
                    // Instant: push whatever is in memory RIGHT NOW (0ms, no network)
                    this.quotaManager.pushCachedData();
                    // Then silently fetch fresh quota in background.
                    // Without this, a re-opened panel shows stale data until the
                    // next 60s webview timer tick (retainContextWhenHidden is off).
                    this.quotaManager.refresh();
                    break;
                case 'refresh':
                    this.quotaManager.refresh();
                    break;
                case 'refreshTokenOnly':
                    this.quotaManager.refreshTokenOnly();
                    break;
                case 'openFile': {
                    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
                    if (!wsRoot || !msg.path) break;

                    const isSkillDir = /^\.agent\/skills\/[^/]+$/.test(msg.path);
                    const filePath = isSkillDir ? msg.path + '/SKILL.md' : msg.path;

                    try {
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(wsRoot, filePath));
                        await vscode.window.showTextDocument(doc, { preview: true });
                    } catch {
                        // Fallback: try without SKILL.md suffix
                        const fallbackDoc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(wsRoot, msg.path));
                        await vscode.window.showTextDocument(fallbackDoc, { preview: true });
                    }
                    break;
                }
                case 'toggleModel':
                    await this.quotaManager.toggleStatusBarModel(msg.modelId, msg.isVisible);
                    break;
                case 'setPinnedModel': {
                    // Persist pin state in globalState so it survives panel reload & extension restart
                    const pins = this.quotaManager.getPinnedModels();
                    if (msg.modelId) {
                        pins[msg.accountKey] = msg.modelId;
                    } else {
                        delete pins[msg.accountKey];
                    }
                    await this.quotaManager.setPinnedModels(pins);
                    // Push confirmed pin state back to webview immediately.
                    // Without this, the next auto-refresh could overwrite the
                    // webview's in-memory pinnedModels with stale globalState data
                    // if the refresh started before the save completed.
                    this.quotaManager.pushCachedData();
                    break;
                }
                case 'addAccount':
                    vscode.commands.executeCommand('ag.addAccount');
                    break;
                case 'addAccountByToken':
                    vscode.commands.executeCommand('ag.addAccountByToken');
                    break;
                case 'removeAccount':
                    vscode.commands.executeCommand('ag.removeAccount', msg.accountId);
                    break;
                case 'switchAccount':
                    this.quotaManager.switchAccount(msg.accountId).catch(e =>
                        log.error('switchAccount unhandled:', e?.message || e));
                    break;
                case 'copyToken':
                    this.quotaManager.copyToken(msg.accountId);
                    break;
                case 'openUsagePanel':
                    vscode.commands.executeCommand('ag.openUsageStats');
                    break;
                case 'openContextDetail':
                    vscode.commands.executeCommand('ag.openContextDetail');
                    break;
                case 'setUsageRange':
                    this.handleUsageRange(msg.range);
                    break;
            }
        });

        // Refresh quota when panel becomes visible again after being hidden.
        // The webview timer dies when the panel is collapsed (retainContextWhenHidden
        // is not set for sidebar views), so cached data can go stale.
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                log.info('panel re-shown → refreshing');
                this.quotaManager.pushCachedData();
                this.quotaManager.refresh();
            }
        });

        webviewView.webview.html = getWebviewContent(webviewView.webview, this.extensionUri);
    }

    setLoading() {
        this._view?.webview.postMessage({ type: 'loading' });
    }

    setError(message: string) {
        this._view?.webview.postMessage({ type: 'error', message });
    }

    updateData(state: ViewState) {
        this._view?.webview.postMessage({
            type: 'update',
            accountCards: state.accountCards,
            pinnedModels: state.pinnedModels,
            tokenBase: state.tokenBase,
            workspaceContext: state.workspaceContext,
            usageStats: state.usageStats,
            contextWindow: null,
            pricing: getPricing(),
        });
    }

    /** Push context window data to webview (separate from main update) */
    postContextWindow(data: any) {
        this._view?.webview.postMessage({
            type: 'contextWindowUpdate',
            data,
        });
    }

    /** Generic message passthrough to webview */
    postMessage(msg: Record<string, any>) {
        this._view?.webview.postMessage(msg);
    }

    private handleUsageRange(range: string) {
        this.quotaManager.setUsageRange(range);
        const filtered = this.quotaManager.getFilteredUsageStats(range);
        if (filtered) {
            this._view?.webview.postMessage({
                type: 'usageStatsUpdate',
                usageStats: filtered,
                pricing: getPricing(),
            });
        }
    }
}
