/**
 * ConversationTracker — Reactive USS topic listeners for conversation switches and data updates.
 * Encapsulates all USS subscription logic (activeCascade, trajectorySummaries, userStatus).
 *
 * Window isolation strategy:
 *  - Boot: workspaceState (per-workspace, per-window) restores the last cascade instantly.
 *  - Runtime: USS onDidChange + vscode.window.state.focused guard ensures only THIS
 *    window's conversation switches are accepted.
 *  - Persist: Every accepted switch is saved to workspaceState for reliable next-boot.
 */

import * as vscode from 'vscode';
import type { USSRow, USSTopic } from '../types';
import { QuotaManager } from '../managers/quotaManager';
import { extractField, extractStringField } from '../utils/protobuf';
import { getUSS } from '../utils/uss';
import { createLogger } from '../utils/logger';

const log = createLogger('ConversationTracker');

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SUBSCRIBE_TIMEOUT = 5000;
const WORKSPACE_CASCADE_KEY = 'ag.lastActiveCascadeId';

/** USS subscribe() signature — not exposed in official API */
interface USSSubscriber {
    subscribe(topicName: string): Promise<USSTopic | null>;
}

export class ConversationTracker implements vscode.Disposable {
    private activeCascadeRunning = false;
    private lastActiveCascadeId: string | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private bootPollTimer: ReturnType<typeof setInterval> | undefined;

    constructor(
        private readonly quotaManager: QuotaManager,
        private readonly context: vscode.ExtensionContext,
    ) {}

    async start(): Promise<void> {
        // Restore last cascade from workspace-specific storage (guaranteed per-window)
        const saved = this.context.workspaceState.get<string>(WORKSPACE_CASCADE_KEY);
        if (saved) {
            log.info(`boot: restored workspace cascade → ${saved.substring(0, 12)}`);
            this.lastActiveCascadeId = saved;
            this.quotaManager.setActiveConversation(saved);
            this.quotaManager.fetchContextWindowOnce(saved);
        }

        const uss = getUSS() as unknown as USSSubscriber | null;
        if (!uss?.subscribe) {
            log.info('USS API not available — conversation tracking disabled');
            return;
        }

        log.info('USS API: ✅ available');

        const cascadeOk = await this.startActiveCascadeTracking(uss);
        if (!cascadeOk) {
            log.info('activeCascade not available, trajectorySummaries will handle both');
        }

        await this.startTrajectorySummariesListener(uss);
        await this.startUserStatusListener(uss);
    }

    dispose(): void {
        if (this.bootPollTimer) {
            clearInterval(this.bootPollTimer);
            this.bootPollTimer = undefined;
        }
        this.disposables.forEach(d => d.dispose());
    }

    // ── Primary: uss-activeCascadeIds ──────────────────────────────

    private async startActiveCascadeTracking(uss: USSSubscriber): Promise<boolean> {
        try {
            const topic = await Promise.race([
                uss.subscribe('uss-activeCascadeIds'),
                this.timeout(SUBSCRIBE_TIMEOUT),
            ]);
            if (!topic) return false;

            let prevSnapshot = new Map<string, string>();

            /** Diff current USS state against previous snapshot; return changed UUID if any. */
            const readCascadeDiff = (): string | undefined => {
                const rawState = topic.getState();
                if (!rawState) return undefined;

                const currSnapshot = new Map<string, string>();
                for (const [k, v] of Object.entries(rawState)) {
                    currSnapshot.set(k, v?.value || '');
                }

                let cascadeId: string | undefined;

                if (prevSnapshot.size === 0) {
                    // First read — take first UUID found
                    cascadeId = this.extractFirstUuid(rawState);
                } else {
                    // Subsequent reads — diff against previous snapshot
                    for (const [k, val] of currSnapshot) {
                        if (prevSnapshot.get(k) !== val && val.length >= 10) {
                            const uuid = this.extractUuidFromValue(val);
                            if (uuid) cascadeId = uuid;
                        }
                    }
                }

                prevSnapshot = currSnapshot;
                return cascadeId;
            };

            /** Apply a cascade switch: update state, notify QuotaManager, persist. */
            const applySwitch = (cascadeId: string, source: string): void => {
                if (cascadeId === this.lastActiveCascadeId) return;
                log.info(`activeCascade: ${source} → ${cascadeId.substring(0, 12)}`);
                this.lastActiveCascadeId = cascadeId;
                this.quotaManager.setActiveConversation(cascadeId);
                this.quotaManager.fetchContextWindowOnce(cascadeId);
                this.context.workspaceState.update(WORKSPACE_CASCADE_KEY, cascadeId);
            };

            // Event-driven: only accept when THIS window is focused
            this.disposables.push(
                topic.onDidChange(() => {
                    if (!vscode.window.state.focused) return;
                    try {
                        const id = readCascadeDiff();
                        if (id) applySwitch(id, 'switch');
                    } catch (err) {
                        log.warn(`activeCascade handler error: ${(err as Error)?.message}`);
                    }
                }),
            );

            // Boot poll: renderer pushes cascade ID AFTER extension host starts.
            // Poll every 3s until first valid ID arrives (only accept if focused).
            if (!this.lastActiveCascadeId) {
                let pollCount = 0;
                const MAX_POLLS = 30; // 30 × 3s = 90s
                log.info('activeCascade: starting boot poll');
                this.bootPollTimer = setInterval(() => {
                    pollCount++;
                    if (!vscode.window.state.focused) return;
                    const id = readCascadeDiff();
                    if (id) {
                        applySwitch(id, `boot poll #${pollCount}`);
                        clearInterval(this.bootPollTimer!);
                        this.bootPollTimer = undefined;
                    } else if (pollCount >= MAX_POLLS) {
                        log.info('activeCascade: boot poll exhausted (90s)');
                        clearInterval(this.bootPollTimer!);
                        this.bootPollTimer = undefined;
                    }
                }, 3000);
            }

            log.info('activeCascade: ✅ listening');
            this.activeCascadeRunning = true;
            return true;
        } catch (e: unknown) {
            log.warn(`activeCascade failed: ${(e as Error)?.message}`);
            return false;
        }
    }

    // ── Fallback: trajectorySummaries ──────────────────────────────

    private async startTrajectorySummariesListener(uss: USSSubscriber): Promise<void> {
        try {
            const topic = await Promise.race([
                uss.subscribe('trajectorySummaries'),
                this.timeout(SUBSCRIBE_TIMEOUT),
            ]);
            if (!topic) return;

            const previousValues = new Map<string, string>();

            const handleChange = () => {
                const state = topic.getState();
                if (!state) return;

                const changedIds: string[] = [];
                for (const [cascadeId, row] of Object.entries(state)) {
                    if (!row) continue;
                    const val = row.value || '';
                    if (previousValues.get(cascadeId) !== val) {
                        changedIds.push(cascadeId);
                    }
                    previousValues.set(cascadeId, val);
                }
                if (changedIds.length === 0) return;

                if (this.lastActiveCascadeId && changedIds.includes(this.lastActiveCascadeId)) {
                    log.info(`trajSummaries: active=${this.lastActiveCascadeId.substring(0, 12)} changed`);
                    this.quotaManager.debouncedContextFetch(this.lastActiveCascadeId);
                    return;
                }

                // activeCascade tracker is authority — don't switch here
                if (this.activeCascadeRunning) return;

                if (!this.lastActiveCascadeId && changedIds.length > 0) {
                    const target = changedIds[0];
                    log.info(`trajSummaries fallback: initial cascade → ${target.substring(0, 12)}`);
                    this.lastActiveCascadeId = target;
                    this.quotaManager.setActiveConversation(target);
                    this.quotaManager.fetchContextWindowOnce(target);
                    this.context.workspaceState.update(WORKSPACE_CASCADE_KEY, target);
                }
            };

            // Seed previousValues so the first onDidChange only detects real deltas
            const initialState = topic.getState();
            if (initialState) {
                for (const [id, row] of Object.entries(initialState)) {
                    if (row) previousValues.set(id, row.value || '');
                }
            }
            this.disposables.push(topic.onDidChange(() => handleChange()));
            log.info('trajectorySummaries: ✅ listening');
        } catch (e: unknown) {
            log.warn(`trajectorySummaries failed: ${(e as Error)?.message}`);
        }
    }

    // ── UserStatus: account change detection ──────────────────────

    private async startUserStatusListener(uss: USSSubscriber): Promise<void> {
        try {
            const topic = await Promise.race([
                uss.subscribe('uss-userStatus'),
                this.timeout(SUBSCRIBE_TIMEOUT),
            ]);
            if (!topic) {
                log.info('userStatus topic not available');
                return;
            }

            let lastEmail = '';

            const handleChange = () => {
                const email = this.extractEmail(topic.getState());
                if (email && email !== lastEmail) {
                    lastEmail = email;
                    log.info(`userStatus: email changed → ${email}`);
                    this.quotaManager.refresh();
                }
            };

            lastEmail = this.extractEmail(topic.getState());
            log.info(`userStatus: ✅ listening (initial=${lastEmail || '?'})`);
            this.disposables.push(topic.onDidChange(() => handleChange()));
        } catch (e: unknown) {
            log.warn(`userStatus failed: ${(e as Error)?.message}`);
        }
    }

    // ── Helpers ────────────────────────────────────────────────────

    /** Extract UUID from a single base64-encoded protobuf value or raw string */
    private extractUuidFromValue(val: string): string | undefined {
        try {
            const decoded = Buffer.from(val, 'base64').toString('utf8');
            const match = decoded.match(UUID_RE);
            if (match) return match[0];
        } catch { /* not base64 */ }
        const rawMatch = val.match(UUID_RE);
        return rawMatch ? rawMatch[0] : undefined;
    }

    /** Extract the first UUID found in any USS state row */
    private extractFirstUuid(state: Record<string, USSRow> | null): string | undefined {
        if (!state) return undefined;
        for (const row of Object.values(state)) {
            if (!row?.value || row.value.length < 10) continue;
            const uuid = this.extractUuidFromValue(row.value);
            if (uuid) return uuid;
        }
        return undefined;
    }

    private extractEmail(state: Record<string, USSRow> | null): string {
        if (!state) return '';
        for (const row of Object.values(state)) {
            if (!row?.value || row.value.length < 10) continue;
            try {
                const bytes = Buffer.from(row.value, 'base64');
                const userStatus = extractField(bytes, 1);
                if (userStatus) return extractStringField(userStatus, 7) || '';
                return extractStringField(bytes, 7) || '';
            } catch { /* ignore parse errors */ }
        }
        return '';
    }

    private timeout(ms: number): Promise<never> {
        return new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms));
    }
}
