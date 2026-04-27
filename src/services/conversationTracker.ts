/**
 * ConversationTracker — Reactive USS topic listeners for conversation switches and data updates.
 * Encapsulates all USS subscription logic (activeCascade, trajectorySummaries, userStatus).
 *
 * Architecture note: USS state for activeCascadeIds contains one entry per IDE window
 * (keyed by numeric windowId). On boot we take the first UUID found; on subsequent
 * changes we diff against the previous snapshot to detect which window changed.
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

/** USS subscribe() signature — not exposed in official API */
interface USSSubscriber {
    subscribe(topicName: string): Promise<USSTopic | null>;
}

export class ConversationTracker implements vscode.Disposable {
    private activeCascadeRunning = false;
    private lastActiveCascadeId: string | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private bootPollTimer: ReturnType<typeof setInterval> | undefined;

    constructor(private readonly quotaManager: QuotaManager) {}

    async start(): Promise<void> {
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

            let isFirstCall = true;
            let prevSnapshot = new Map<string, string>();

            const handleChange = () => {
                try {
                    const rawState = topic.getState();
                    if (!rawState) return;

                    // Snapshot current values keyed by windowId
                    const currSnapshot = new Map<string, string>();
                    for (const [k, v] of Object.entries(rawState)) {
                        currSnapshot.set(k, v?.value || '');
                    }

                    let cascadeId: string | undefined;

                    if (isFirstCall) {
                        // Boot: take first UUID found — correct for the active window at startup
                        isFirstCall = false;
                        cascadeId = this.extractFirstUuid(rawState);
                    } else {
                        // Switch: diff against previous snapshot — changed row = active window
                        for (const [k, val] of currSnapshot) {
                            if (prevSnapshot.get(k) !== val && val.length >= 10) {
                                const uuid = this.extractUuidFromValue(val);
                                if (uuid) cascadeId = uuid;
                            }
                        }
                    }

                    prevSnapshot = currSnapshot;

                    if (cascadeId && cascadeId !== this.lastActiveCascadeId) {
                        log.info(`activeCascade: switch → ${cascadeId.substring(0, 12)}`);
                        this.lastActiveCascadeId = cascadeId;
                        this.quotaManager.setActiveConversation(cascadeId);
                        this.quotaManager.fetchContextWindowOnce(cascadeId);
                    }
                } catch (err) {
                    log.info(`activeCascade handler error: ${(err as Error)?.message}`);
                }
            };

            // Initial read (likely empty on cold boot — renderer hasn't pushed yet)
            handleChange();
            topic.onDidChange(() => handleChange());

            // Boot-aware polling: renderer pushes cascade ID AFTER extension host starts.
            // Poll every 3s until first valid ID arrives, capped at 90s.
            if (!this.lastActiveCascadeId) {
                let pollCount = 0;
                const MAX_POLLS = 30;
                log.info('activeCascade: initial state empty — starting boot poll');
                this.bootPollTimer = setInterval(() => {
                    pollCount++;
                    const cascadeId = this.extractFirstUuid(topic.getState());
                    if (cascadeId) {
                        log.info(`activeCascade: boot poll #${pollCount} → found ${cascadeId.substring(0, 12)}`);
                        if (cascadeId !== this.lastActiveCascadeId) {
                            this.lastActiveCascadeId = cascadeId;
                            this.quotaManager.setActiveConversation(cascadeId);
                            this.quotaManager.fetchContextWindowOnce(cascadeId);
                        }
                        clearInterval(this.bootPollTimer!);
                        this.bootPollTimer = undefined;
                    } else if (pollCount >= MAX_POLLS) {
                        log.info('activeCascade: boot poll exhausted (90s) — giving up');
                        clearInterval(this.bootPollTimer!);
                        this.bootPollTimer = undefined;
                    }
                }, 3000);
            } else {
                log.info(`activeCascade: immediate boot → ${this.lastActiveCascadeId.substring(0, 12)}`);
            }

            log.info('activeCascade: ✅ listening');
            this.activeCascadeRunning = true;
            return true;
        } catch (e: unknown) {
            log.info(`activeCascade failed: ${(e as Error)?.message}`);
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
                    // Detect both new keys and value changes
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
                }
            };

            // Seed previousValues so the first onDidChange only detects real deltas
            const initialState = topic.getState();
            if (initialState) {
                for (const [id, row] of Object.entries(initialState)) {
                    if (row) previousValues.set(id, row.value || '');
                }
            }
            topic.onDidChange(() => handleChange());
            log.info('trajectorySummaries: ✅ listening');
        } catch (e: unknown) {
            log.info(`trajectorySummaries failed: ${(e as Error)?.message}`);
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
            topic.onDidChange(() => handleChange());
        } catch (e: unknown) {
            log.info(`userStatus failed: ${(e as Error)?.message}`);
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

    /** Extract the first UUID found in any USS state row (boot fallback) */
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
