import * as vscode from 'vscode';
import { AccountManager } from './managers/accountManager';
import { QuotaManager } from './managers/quotaManager';
import { QuotaViewProvider } from './providers/quotaViewProvider';
import { UsageStatsPanel } from './providers/usageStatsPanel';
import { updatePricing, setExternalPricingResolver } from './shared/usage-components';
import { initPricingCatalog, resolveLiteLlmPricing } from './services/litellmPricing';
import { initLogger, createLogger } from './utils/logger';

const log = createLogger('Extension');

// File-based diagnostic for USS/CW debugging (temp)
const diagPath = '/tmp/ag-ctx-diag.log';
function diag(msg: string) {
    try {
        const fs = require('fs');
        fs.appendFileSync(diagPath, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {}
}

export async function activate(context: vscode.ExtensionContext) {
    // Initialize OutputChannel logger FIRST — all modules use this
    initLogger(context);

    // --- Boot managers ---
    const accountManager = new AccountManager(context);
    accountManager.initialize();

    const quotaManager = new QuotaManager(context, accountManager);

    // Non-blocking USS API check
    quotaManager.getSwitchService().testApiAccess().then(ok => {
        log.info(`USS API: ${ok ? '✅ available' : '❌ not available'}`);
    });

    // Start reactive conversation tracker (USS trajectorySummaries)
    startConversationTracker(quotaManager);

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

/**
 * Reactive conversation tracker via USS `uss-activeCascadeIds` topic.
 *
 * This topic stores the active cascade (conversation) ID per workspace.
 * When the user switches conversations in the chat panel, the topic fires
 * onDidChange — no typing required. This is the definitive signal for
 * conversation switching.
 *
 * Fallback: trajectorySummaries eTag tracking (less reliable but functional).
 */
function startConversationTracker(quotaManager: QuotaManager): void {
    const uss: any = (vscode as any).antigravityUnifiedStateSync;
    if (!uss?.subscribe) {
        log.info('USS API: not available — conversation tracking disabled');
        return;
    }

    // Flag: set to true once activeCascade tracker is running.
    // When true, trajectory summaries should NEVER switch conversations —
    // only refresh data for the already-active cascade.
    let activeCascadeTrackerRunning = false;

    log.info('USS API: ✅ available');

    const timeout = (ms: number) => new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms));

    let lastActiveCascadeId: string | undefined;

    // ── Primary: uss-activeCascadeIds ────────────────────────────
    // This topic maps workspaceId → active cascadeId (protobuf encoded)
    const startActiveCascadeTracking = async () => {
        try {
            const topic: any = await Promise.race([
                uss.subscribe('uss-activeCascadeIds'),
                timeout(5000),
            ]);
            if (!topic) return false;

            // USS state format (reverse-engineered):
            // { [workspaceIndex]: { $typeName: "exa.unified_state_sync_pb.Row", value: base64_string, eTag: bigint } }
            // base64 decodes to protobuf: [0x1a, length, ...cascadeUUID_utf8]
            const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
            
            const extractActiveCascade = (state: any): string | undefined => {
                if (!state || typeof state !== 'object') return undefined;
                for (const row of Object.values(state)) {
                    if (!row || typeof row !== 'object') continue;
                    const val = (row as any).value;
                    if (typeof val !== 'string' || val.length < 10) continue;
                    // Decode base64 protobuf → extract UUID
                    try {
                        const decoded = Buffer.from(val, 'base64').toString('utf8');
                        const match = decoded.match(UUID_RE);
                        if (match) return match[0];
                    } catch { /* not base64, try raw */ }
                    // Fallback: value IS the cascade ID
                    const rawMatch = val.match(UUID_RE);
                    if (rawMatch) return rawMatch[0];
                }
                return undefined;
            };

            const handleChange = () => {
                const state = topic.getState?.();
                const cascadeId = extractActiveCascade(state);
                if (cascadeId && cascadeId !== lastActiveCascadeId) {
                    log.info(`USS activeCascade: switch → ${cascadeId.substring(0, 12)}`);
                    lastActiveCascadeId = cascadeId;
                    quotaManager.fetchContextWindowIndependent(cascadeId);
                }
            };

            // Initial read (may be empty — USS syncs asynchronously)
            handleChange();
            // Listen for changes (fires on every conversation switch)
            topic.onDidChange?.(() => handleChange());
            log.info('USS activeCascade: ✅ listening');
            activeCascadeTrackerRunning = true;

            return true;
        } catch (e: any) {
            log.info(`USS activeCascade: failed: ${e?.message}`);
            return false;
        }
    };

    // ── trajectorySummaries listener ───────────────────────
    // USS eTag field is always 0 (unusable), but onDidChange fires reliably
    // when any conversation data changes. We use value-hash comparison to
    // detect which cascade changed, then refresh its context window.
    const startTrajectorySummariesListener = async () => {
        try {
            const topic: any = await Promise.race([
                uss.subscribe('trajectorySummaries'),
                timeout(5000),
            ]);
            if (!topic) return;

            // Track previous value snapshots to detect per-cascade changes
            const previousValues = new Map<string, string>();

            const handleChange = () => {
                const state = topic.getState?.();
                if (!state) { diag('TRAJ onChange: state is null'); return; }

                const totalKeys = Object.keys(state).length;
                const changedIds: string[] = [];
                for (const [cascadeId, row] of Object.entries(state)) {
                    if (!row || typeof row !== 'object') continue;
                    const val = (row as any).value || '';
                    const prev = previousValues.get(cascadeId);
                    if (prev !== undefined && prev !== val) {
                        changedIds.push(cascadeId);
                    }
                    previousValues.set(cascadeId, val);
                }
                diag(`TRAJ onChange: ${totalKeys} keys, ${changedIds.length} changed, active=${lastActiveCascadeId?.substring(0,12)||'none'}`);
                if (changedIds.length === 0) return;

                // Case 1: Active conversation's data changed → refresh its context window
                if (lastActiveCascadeId && changedIds.includes(lastActiveCascadeId)) {
                    diag(`TRAJ UPDATE: active ${lastActiveCascadeId.substring(0,12)} changed`);
                    log.info(`USS trajectories: active cascade updated → refreshing context`);
                    quotaManager.fetchContextWindowIndependent(lastActiveCascadeId);
                    return;
                }

                // Case 2: activeCascade tracker is running → do NOT switch conversations here.
                // The activeCascade tracker is the authority on which conversation is active.
                if (activeCascadeTrackerRunning) {
                    diag(`TRAJ IGNORED: changed=[${changedIds.map(c=>c.substring(0,12)).join(',')}] activeCascade tracker is authority`);
                    return;
                }

                // Case 3: Fallback mode (no activeCascade tracker) — use most recently changed cascade
                // Only switch if we have no active cascade at all (first conversation)
                if (!lastActiveCascadeId && changedIds.length > 0) {
                    const target = changedIds[0];
                    diag(`TRAJ FALLBACK: no active cascade, using ${target.substring(0,12)}`);
                    log.info(`USS trajectories (fallback): initial cascade → ${target.substring(0, 12)}`);
                    lastActiveCascadeId = target;
                    quotaManager.fetchContextWindowIndependent(target);
                } else {
                    diag(`TRAJ IGNORED: changed=[${changedIds.map(c=>c.substring(0,12)).join(',')}] none match active, no switch in fallback`);
                }
            };

            // Seed initial values (no action on first read)
            const initialState = topic.getState?.();
            if (initialState) {
                for (const [id, row] of Object.entries(initialState)) {
                    if (row && typeof row === 'object') {
                        previousValues.set(id, (row as any).value || '');
                    }
                }
            }
            topic.onDidChange?.(() => handleChange());
            log.info('USS trajectorySummaries: ✅ listening (value-hash mode)');
        } catch (e: any) {
            log.info(`USS trajectorySummaries: failed: ${e?.message}`);
        }
    };

    // ── uss-modelCredits listener ────────────────────────────
    // Model credits update AFTER the AI response completes and tokens are consumed.
    // This is a more reliable "response done" signal than trajectorySummaries.
    const startModelCreditsListener = async () => {
        try {
            const topic: any = await Promise.race([
                uss.subscribe('uss-modelCredits'),
                timeout(5000),
            ]);
            if (!topic) return;

            // Track previous state to detect changes
            let previousState: string | null = null;
            const handleCreditsChange = () => {
                const state = topic.getState?.();
                const stateStr = JSON.stringify(state);
                if (previousState === stateStr) return; // No actual change
                previousState = stateStr;

                diag(`CREDITS onChange: active=${lastActiveCascadeId?.substring(0,12)||'none'}`);
                if (lastActiveCascadeId) {
                    log.info('USS modelCredits: credits changed → triggering context refresh');
                    quotaManager.fetchContextWindowIndependent(lastActiveCascadeId);
                }
            };

            previousState = JSON.stringify(topic.getState?.());
            topic.onDidChange?.(() => handleCreditsChange());
            log.info('USS uss-modelCredits: ✅ listening');
        } catch (e: any) {
            log.info(`USS uss-modelCredits: failed: ${e?.message}`);
        }
    };

    // Start ALL listeners:
    // - activeCascade: real-time conversation switches
    // - trajectorySummaries: real-time data updates (value changes on new messages)
    // - modelCredits: response completion signal (credits consumed = response done)
    startActiveCascadeTracking().then(ok => {
        if (!ok) {
            log.info('USS activeCascade: not available, trajectorySummaries will handle both switches and updates');
        }
        // Always start — they handle in-conversation data updates
        startTrajectorySummariesListener();
        startModelCreditsListener();
    });
}
