/**
 * ConversationTracker — Reactive USS topic listeners for conversation switches and data updates.
 * Encapsulates all USS subscription logic (activeCascade, trajectorySummaries, userStatus).
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

            const handleChange = () => {
                const cascadeId = this.extractActiveCascade(topic.getState());
                if (cascadeId && cascadeId !== this.lastActiveCascadeId) {
                    log.info(`activeCascade: switch → ${cascadeId.substring(0, 12)}`);
                    this.lastActiveCascadeId = cascadeId;
                    this.quotaManager.setActiveConversation(cascadeId);
                    this.quotaManager.fetchContextWindowOnce(cascadeId);
                }
            };

            handleChange();
            topic.onDidChange(() => handleChange());
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
                    const prev = previousValues.get(cascadeId);
                    if (prev !== undefined && prev !== val) {
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

    private extractActiveCascade(state: Record<string, USSRow> | null): string | undefined {
        if (!state) return undefined;
        for (const row of Object.values(state)) {
            if (!row?.value || row.value.length < 10) continue;
            try {
                const decoded = Buffer.from(row.value, 'base64').toString('utf8');
                const match = decoded.match(UUID_RE);
                if (match) return match[0];
            } catch { /* not base64 */ }
            const rawMatch = row.value.match(UUID_RE);
            if (rawMatch) return rawMatch[0];
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
