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
                    // Context window comes from lastContextWindow cache (set by USS or globalState restore).
                    // Do NOT re-fetch here — getActiveContext() global sort can pick wrong conversation.
                    this.quotaManager.pushCachedData();
                    break;
                case 'refresh':
                    this.quotaManager.refresh();
                    break;
                case 'refreshTokenOnly':
                    this.quotaManager.refreshTokenOnly();
                    break;
                case 'openFile': {
                    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
                    if (wsRoot && msg.path) {
                        // Skills are indexed as directories — open their SKILL.md
                        const isSkillDir = /^\.agent\/skills\/[^/]+$/.test(msg.path);
                        const filePath = isSkillDir ? msg.path + '/SKILL.md' : msg.path;
                        const fileUri = vscode.Uri.joinPath(wsRoot, filePath);
                        vscode.workspace.openTextDocument(fileUri).then(doc =>
                            vscode.window.showTextDocument(doc, { preview: true })
                        ).then(undefined, () => {
                            // Fallback: try without SKILL.md (e.g. index.md)
                            const fallback = vscode.Uri.joinPath(wsRoot, msg.path);
                            vscode.workspace.openTextDocument(fallback).then(doc =>
                                vscode.window.showTextDocument(doc, { preview: true })
                            );
                        });
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
