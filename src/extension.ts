import * as vscode from 'vscode';
import { AccountManager } from './managers/accountManager';
import { QuotaManager } from './managers/quotaManager';
import { QuotaViewProvider } from './providers/quotaViewProvider';
import { UsageStatsPanel } from './providers/usageStatsPanel';
import { ContextDetailPanel } from './providers/contextDetailPanel';
import { updatePricing, setExternalPricingResolver } from './shared/usage-components';
import { initPricingCatalog, resolveLiteLlmPricing } from './services/litellmPricing';
import { ConversationTracker } from './services/conversationTracker';
import { initLogger, createLogger, setFileSink, setDiagSink } from './utils/logger';

const log = createLogger('Extension');



export async function activate(context: vscode.ExtensionContext) {
    // Initialize OutputChannel logger FIRST — all modules use this
    initLogger(context);
    setFileSink('/tmp/ag-panel.log');
    setDiagSink('/tmp/ag-ctx-diag.log');

    // --- Boot managers ---
    const accountManager = new AccountManager(context);
    accountManager.initialize();

    const quotaManager = new QuotaManager(context, accountManager);

    // Non-blocking USS API check
    quotaManager.getSwitchService().testApiAccess().then(ok => {
        log.info(`USS API: ${ok ? '✅ available' : '❌ not available'}`);
    });

    // Start reactive conversation tracker (USS topics)
    const tracker = new ConversationTracker(quotaManager);
    tracker.start();
    context.subscriptions.push(tracker);

    log.info('Extension activated');

    // --- Load model pricing from settings ---
    applyPricingFromSettings();
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('ag-switchboard.modelPricing')) {
                applyPricingFromSettings();
                log.info('Model pricing updated from settings');
            }
        })
    );

    // --- LiteLLM dynamic pricing (non-blocking, fire-and-forget) ---
    initPricingCatalog().then(() => {
        setExternalPricingResolver((displayName) => {
            const resolved = resolveLiteLlmPricing(displayName);
            if (!resolved) return null;
            // Convert per-token to per-1M-token for compatibility with hardcoded pricing table
            return {
                input: resolved.inputCostPerToken * 1e6,
                output: resolved.outputCostPerToken * 1e6,
                cache: (resolved.cacheReadCostPerToken ?? resolved.inputCostPerToken * 0.1) * 1e6,
                reasoning: (resolved.reasoningCostPerToken ?? resolved.outputCostPerToken) * 1e6,
            };
        });
        log.info('LiteLLM dynamic pricing resolver registered');
    }).catch(() => { /* silent — hardcoded fallback active */ });

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

        vscode.commands.registerCommand('ag.openUsageStats', () => {
            UsageStatsPanel.createOrShow(context.extensionUri, quotaManager.getLastUsageStats());
            if (UsageStatsPanel.currentPanel) {
                UsageStatsPanel.currentPanel.onRangeFilter = (range) =>
                    quotaManager.getFilteredUsageStats(range);
            }
        }),

        vscode.commands.registerCommand('ag.openContextDetail', async () => {
            const serverInfo = await quotaManager.getServerInfo();
            // Show panel immediately with cached data (instant open)
            const cachedCw = quotaManager.getLastContextWindow();
            ContextDetailPanel.createOrShow(context.extensionUri, cachedCw, serverInfo);

            // Then trigger a fresh fetch to get the latest context window
            const cascadeId = quotaManager.getActiveConversationId();
            if (cascadeId) {
                quotaManager.fetchContextWindowOnce(cascadeId);
            }
        }),
    );

    // --- React to account changes ---
    accountManager.onDidChange(() => quotaManager.refresh());
}

function applyPricingFromSettings(): void {
    const cfg = vscode.workspace.getConfiguration('ag-switchboard');
    const overrides = cfg.get<Record<string, { input: number; output: number; cache: number }>>('modelPricing');
    if (overrides && typeof overrides === 'object') {
        updatePricing(overrides);
    }
}
