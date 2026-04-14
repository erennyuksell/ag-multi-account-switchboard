import * as vscode from 'vscode';
import { AccountQuota, LocalQuotaData } from '../types';
import { TokenBaseData, WorkspaceContextData } from '../services/tokenBase';
import { QuotaManager } from '../managers/quotaManager';
import { getWebviewContent } from '../webview/template';

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

        webviewView.webview.html = getWebviewContent(webviewView.webview, this.extensionUri);

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'ready':
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
                    this.quotaManager.switchAccount(msg.accountId);
                    break;
                case 'copyToken':
                    this.quotaManager.copyToken(msg.accountId);
                    break;
            }
        });
    }

    setLoading() {
        this._view?.webview.postMessage({ type: 'loading' });
    }

    setError(message: string) {
        this._view?.webview.postMessage({ type: 'error', message });
    }

    updateData(
        localData: LocalQuotaData | null,
        selectedModels: string[],
        trackedQuotas: AccountQuota[] = [],
        activeEmail: string = '',
        tokenBase: TokenBaseData | null = null,
        workspaceContext: WorkspaceContextData | null = null,
    ) {
        this._view?.webview.postMessage({
            type: 'update',
            data: localData,
            selectedModels,
            activeEmail,
            tokenBase,
            workspaceContext,
            trackedAccounts: trackedQuotas.map(q => ({
                id: q.account.id,
                email: q.account.email,
                name: q.account.name,
                models: q.models,
                tier: q.tier,
                tierName: q.tierName,
                isForbidden: q.isForbidden,
                isError: q.isError,
                errorMessage: q.errorMessage,
                lastUpdated: q.lastUpdated,
            })),
        });
    }
}
