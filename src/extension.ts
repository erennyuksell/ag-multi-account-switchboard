import * as vscode from 'vscode';
import { AccountManager } from './managers/accountManager';
import { QuotaManager } from './managers/quotaManager';
import { QuotaViewProvider } from './providers/quotaViewProvider';
import { initLogger, createLogger } from './utils/logger';

const log = createLogger('Extension');

export async function activate(context: vscode.ExtensionContext) {
    // Initialize OutputChannel logger FIRST — all modules use this
    initLogger(context);

    // --- Boot managers ---
    const accountManager = new AccountManager(context);
    accountManager.initialize();

    const quotaManager = new QuotaManager(context, accountManager);

    // Test if the proposed API is accessible (non-blocking)
    quotaManager.getSwitchService().testApiAccess().then(ok => {
        log.info(`USS API: ${ok ? '✅ available' : '❌ not available'}`);
    });

    log.info('Extension activated');

    // --- Register webview provider ---
    const viewProvider = new QuotaViewProvider(context.extensionUri, quotaManager);
    quotaManager.setViewProvider(viewProvider);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('ag.quotaView', viewProvider)
    );

    // --- Register commands ---
    context.subscriptions.push(
        vscode.commands.registerCommand('ag.refreshQuota', () => quotaManager.refresh()),

        vscode.commands.registerCommand('ag.addAccount', async () => {
            const success = await accountManager.addAccount();
            if (success) {
                vscode.window.showInformationMessage('Account added successfully! Fetching quota...');
                quotaManager.refresh();
            } else {
                vscode.window.showWarningMessage('Account login was cancelled or failed.');
            }
        }),

        vscode.commands.registerCommand('ag.removeAccount', async (accountId: string) => {
            const account = accountManager.getAccounts().find(a => a.id === accountId);
            if (!account) return;

            const confirm = await vscode.window.showWarningMessage(
                `Remove ${account.email} from tracked accounts?`,
                { modal: true },
                'Remove'
            );
            if (confirm === 'Remove') {
                await accountManager.removeAccount(accountId);
                quotaManager.refresh();
            }
        }),

        vscode.commands.registerCommand('ag.addAccountByToken', async () => {
            const success = await accountManager.addAccountByToken();
            if (success) {
                quotaManager.refresh();
            }
        }),
    );

    // --- React to account changes ---
    accountManager.onDidChange(() => quotaManager.refresh());
}
