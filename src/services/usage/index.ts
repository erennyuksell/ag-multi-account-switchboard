/**
 * UsageStatsService — orchestrates token usage statistics from the Antigravity
 * Language Server's cascade trajectory endpoints.
 *
 * Data flow:
 * 1. Scan ~/.gemini/antigravity/brain/ for conversation UUIDs
 * 2. Fetch metadata for each via parallel batched API calls
 * 3. Aggregate into daily/hourly/model/cascade breakdowns
 *
 * Delegates to:
 * - aggregator.ts — pure aggregation functions
 * - cache.ts — disk cache persistence
 * - types.ts — shared types and constants
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ServerInfo, DeepUsageStats } from '../../types';
import { RpcDirectClient } from '../rpcDirectClient';
import { callLsJson } from '../../utils/lsClient';
import { createLogger } from '../../utils/logger';
import {
    ConvoTokenData, DiskCacheData, TokenEntry,
    EP, BATCH_CONCURRENCY, HOT_THRESHOLD_MS, FETCH_TIMEOUT_MS,
    entryFingerprint,
} from './types';
import { aggregateFromPerConvo, extractTokens } from './aggregator';
import { StatsCache } from './cache';
import { ProcessLock } from './processLock';
import { getGlobalIndexData } from '../../shared/titleResolver';
import { concurrentPool } from './pool';

const log = createLogger('UsageStats');

export class UsageStatsService {

    /** Memory cache for deep stats (expensive to compute) */
    private deepStatsCache: DeepUsageStats | null = null;

    /** In-memory per-convo data — available during progressive fetch before disk cache exists */
    private currentPerConvo: Record<string, ConvoTokenData> = {};
    private currentTitleMap: Map<string, string> = new Map();
    private currentStepCounts: Map<string, number> = new Map();

    /** Raw (pre-dedup) meta/steps counts per conversation — for correct offset-based delta */
    private rawFetchCounts: Record<string, { meta: number; steps: number }> = {};

    private readonly cache = new StatsCache();
    private readonly processLock = new ProcessLock();

    // ═══════════════════════════════════════════
    //  Deep Stats (All-Time, All Conversations)
    // ═══════════════════════════════════════════

    async fetchDeepStats(
        serverInfo: ServerInfo,
        forceRefresh = false,
        /** Called when background backfill completes with updated stats */
        onBackfillComplete?: (stats: DeepUsageStats) => void,
        /** Called during scan with (done, total) for progress UI */
        onProgress?: (done: number, total: number) => void,
    ): Promise<DeepUsageStats | null> {
        log.info(`fetchDeepStats: start — port=${serverInfo.port} forceRefresh=${forceRefresh} memCache=${!!this.deepStatsCache}`);

        // 1. Instant return from memory cache (fastest) — skip if forceRefresh
        if (this.deepStatsCache && !forceRefresh) {
            log.info('fetchDeepStats: returning memory cache (no refresh needed)');
            return this.deepStatsCache;
        }

        // 2. Try disk cache + incremental refresh (picks up new conversations)
        const diskCache = this.cache.read();
        if (diskCache) {
            this.deepStatsCache = diskCache.stats;
            log.info(`fetchDeepStats: disk cache hit — ${diskCache.fetchedIds.length} conversations cached, updatedAt=${diskCache.updatedAt}`);

            // Cross-process lock: only 1 window fetches, others read cache only
            if (!this.processLock.acquire()) {
                log.info('fetchDeepStats: lock held by another instance — returning disk cache as-is');
                return this.deepStatsCache;
            }
            try {
                log.info('fetchDeepStats: starting incremental refresh...');
                const updated = await this.incrementalRefresh(serverInfo, diskCache).catch((e: any) => {
                    log.warn('fetchDeepStats: incrementalRefresh threw:', e?.message);
                    return false;
                });
                log.info(`fetchDeepStats: incremental refresh done — updated=${updated}`);
                if (updated && onBackfillComplete) onBackfillComplete(this.deepStatsCache!);
            } finally {
                this.processLock.release();
            }

            return this.deepStatsCache;
        }

        // 3. Two-phase fetch (first time only — no disk cache exists)
        log.info('fetchDeepStats: no disk cache — starting cold two-phase fetch');
        //    Lock guard: only 1 window does the expensive cold boot
        if (!this.processLock.acquire()) {
            log.info('fetchDeepStats: lock held by another instance during cold boot — returning null');
            return null;
        }
        try {
            return await this.twoPhaseFullFetch(serverInfo, onBackfillComplete, onProgress);
        } finally {
            this.processLock.release();
        }
    }

    /**
     * Two-phase full fetch:
     * Phase 1: Fetch recent conversations (mtime < 48h) → return immediately for 24h view
     * Phase 2: Backfill remaining conversations in background → notify via callback
     */
    private async twoPhaseFullFetch(
        serverInfo: ServerInfo,
        onBackfillComplete?: (stats: DeepUsageStats) => void,
        onProgress?: (done: number, total: number) => void,
    ): Promise<DeepUsageStats | null> {
        try {
            this.rawFetchCounts = {};
            const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
            log.info(`twoPhaseFullFetch: scanning brain dir: ${brainDir}`);

            const allIds = this.discoverConversationIds();
            log.info(`twoPhaseFullFetch: found ${allIds.length} conversation(s) on disk`);
            if (allIds.length === 0) {
                log.warn('twoPhaseFullFetch: NO conversations found on disk — check brain dir exists and contains UUID folders');
                const emptyStats = aggregateFromPerConvo({}, new Map());
                this.deepStatsCache = emptyStats;
                if (onBackfillComplete) onBackfillComplete(emptyStats);
                return emptyStats;
            }

            // Split into HOT (recent 48h) and COLD
            const cutoffMs = Date.now() - HOT_THRESHOLD_MS;
            const { hot, cold } = this.partitionByMtime(allIds, cutoffMs);
            log.info(`twoPhaseFullFetch: partition done — ${hot.length} hot (recent 48h) + ${cold.length} cold = ${allIds.length} total`);

            // Phase 1: Fetch HOT conversations + trajectory summaries (titles + stepCounts)
            log.info(`twoPhaseFullFetch: Phase 1 — fetching trajectory summaries + ${hot.length} hot conversations...`);
            const [summaries, hotData] = await Promise.all([
                this.fetchTrajectorySummaries(serverInfo),
                this.fetchConversationData(serverInfo, hot, onProgress ? (d) => onProgress(d, allIds.length) : undefined),
            ]);

            log.diag(`twoPhaseFullFetch: Phase 1 API done — titleMap=${summaries.titleMap.size} titles, stepCounts=${summaries.stepCounts.size}, hotData=${Object.keys(hotData).length} convos with data`);

            this.currentTitleMap = summaries.titleMap;
            this.currentStepCounts = summaries.stepCounts;
            this.currentPerConvo = { ...hotData };

            const hotStats = aggregateFromPerConvo(hotData, summaries.titleMap);
            this.deepStatsCache = hotStats;
            log.diag(`twoPhaseFullFetch: Phase 1 aggregated — totalCalls=${hotStats.totalCalls} totalTokens=${hotStats.totalTokens} from ${hot.length} hot convos`);

            // If no cold conversations, write final cache and return
            if (cold.length === 0) {
                log.diag('twoPhaseFullFetch: no cold conversations — writing cache and returning Phase 1 result');
                const entryCounts = this.buildEntryCounts();
                this.cache.write(hotData, allIds, hotStats, summaries.titleMap, summaries.stepCounts, entryCounts);
                return hotStats;
            }

            // Phase 2: Fetch COLD conversations inline (not background).
            // Returning partial Phase 1 data caused flip-flop ($3 → $177 → $203).
            // Await full result so the UI transitions once: loading → correct data.
            log.info(`twoPhaseFullFetch: Phase 2 — fetching ${cold.length} cold conversations...`);
            const hotDone = hot.length;
            const coldData = await this.fetchConversationData(serverInfo, cold, onProgress ? (d) => onProgress(hotDone + d, allIds.length) : undefined);
            log.diag(`twoPhaseFullFetch: Phase 2 API done — coldData=${Object.keys(coldData).length} convos with data`);

            const merged = { ...hotData, ...coldData };
            this.currentPerConvo = merged;

            const fullStats = aggregateFromPerConvo(merged, summaries.titleMap);
            this.deepStatsCache = fullStats;

            // Build entryCounts for offset-based delta on next incremental
            const entryCounts = this.buildEntryCounts();
            this.cache.write(merged, allIds, fullStats, summaries.titleMap, summaries.stepCounts, entryCounts);
            log.info(`twoPhaseFullFetch: Phase 2 complete — totalCalls=${fullStats.totalCalls} totalTokens=${fullStats.totalTokens} across ${Object.keys(merged).length} convos`);

            if (onBackfillComplete) onBackfillComplete(fullStats);
            return fullStats;

        } catch (e: any) {
            log.warn('twoPhaseFullFetch: FAILED with error:', e?.message);
            log.warn('twoPhaseFullFetch: stack:', e?.stack?.split('\n').slice(0, 5).join(' | '));
            return null;
        }
    }



    /**
     * Partition conversation IDs into hot (mtime > cutoff) and cold.
     */
    private partitionByMtime(ids: string[], cutoffMs: number): { hot: string[]; cold: string[] } {
        const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
        const hot: string[] = [];
        const cold: string[] = [];
        for (const cid of ids) {
            try {
                const stat = fs.statSync(path.join(brainDir, cid));
                if (stat.mtimeMs > cutoffMs) {
                    hot.push(cid);
                } else {
                    cold.push(cid);
                }
            } catch { // EXPECTED: directory deleted between readdir and stat — treat as hot
                // Can't stat → treat as hot (fetch it)
                hot.push(cid);
            }
        }
        return { hot, cold };
    }

    /**
     * Incremental refresh — fetches NEW conversations + re-fetches MODIFIED ones.
     * Uses filesystem mtime to detect conversations that changed since last cache update.
     */
    private async incrementalRefresh(serverInfo: ServerInfo, diskCache: DiskCacheData): Promise<boolean> {
        try {
            this.rawFetchCounts = {};
            const allIds = this.discoverConversationIds();
            const cachedSet = new Set(diskCache.fetchedIds);
            log.diag(`incrementalRefresh: disk has ${allIds.length} convos, cache has ${cachedSet.size} fetched IDs`);

            // 1. NEW conversations (not in cache at all)
            const newIds = allIds.filter(id => !cachedSet.has(id));
            log.diag(`incrementalRefresh: ${newIds.length} new conversations not in cache`);

            // 2. CHANGED conversations — precise stepCount delta detection
            //    Compare server's current stepCount vs our cached stepCount.
            //    Only re-fetch conversations where steps actually increased.
            const summaries = await this.fetchTrajectorySummaries(serverInfo);
            this.currentTitleMap = summaries.titleMap;
            this.currentStepCounts = summaries.stepCounts;

            const cachedStepCounts = diskCache.stepCounts || {};
            const changedIds = allIds.filter(id => {
                if (!cachedSet.has(id)) return false; // already in newIds
                const currentCount = summaries.stepCounts.get(id) ?? 0;
                const cachedCount = cachedStepCounts[id] ?? 0;
                return currentCount > cachedCount;
            });
            log.diag(`incrementalRefresh: ${changedIds.length} conversations changed (stepCount delta)`);

            const dirtyIds = [...new Set([...newIds, ...changedIds])];

            if (dirtyIds.length === 0) {
                log.info('incrementalRefresh: nothing to fetch — all conversations up to date');
                return false;
            }

            // Build offset map for changed conversations (new ones start at 0)
            const cachedEntryCounts = diskCache.entryCounts || {};
            const offsetMap = new Map<string, { meta: number; steps: number }>();
            for (const cid of changedIds) {
                const cached = cachedEntryCounts[cid];
                if (cached) offsetMap.set(cid, cached);
            }

            log.info(`incrementalRefresh: fetching ${dirtyIds.length} dirty (${newIds.length} new + ${changedIds.length} changed)`);

            const deltaCount = [...offsetMap.values()].filter(v => v.meta > 0 || v.steps > 0).length;
            log.info(`Deep stats: incremental fetch — ${newIds.length} new, ${changedIds.length} changed (${deltaCount} offset-based delta)`);

            const freshData = await this.fetchConversationData(serverInfo, dirtyIds, undefined, offsetMap);

            // ADDITIVE merge: never delete entries, only add new unique ones.
            // Prevents flip-flop when steps endpoint sporadically returns empty.
            const merged = { ...diskCache.perConvo };
            for (const [cid, fresh] of Object.entries(freshData)) {
                const existing = merged[cid];
                if (!existing) {
                    merged[cid] = fresh;
                } else {
                    const seen = new Set(existing.entries.map(entryFingerprint));
                    const newOnly = fresh.entries.filter(e => !seen.has(entryFingerprint(e)));
                    if (newOnly.length > 0) {
                        merged[cid] = { entries: [...existing.entries, ...newOnly] };
                    }
                }
            }
            const mergedIds = [...new Set([...diskCache.fetchedIds, ...newIds])];

            // Build entryCounts from raw (pre-dedup) fetch counts.
            // Meta/steps use independent LS offsets — must NOT mix via deduped entry count.
            const entryCounts = this.buildEntryCounts(cachedEntryCounts);

            const stats = aggregateFromPerConvo(merged, summaries.titleMap);

            this.deepStatsCache = stats;
            this.currentPerConvo = merged;
            this.cache.write(merged, mergedIds, stats, summaries.titleMap, summaries.stepCounts, entryCounts);

            log.info(`incrementalRefresh: complete — totalCalls=${stats.totalCalls} (${newIds.length} new + ${changedIds.length} changed convos updated)`);
            return true;
        } catch (e: any) {
            log.warn('incrementalRefresh: FAILED:', e?.message);
            return false;
        }
    }

    /**
     * Fetch metadata for conversation IDs (parallel chunks).
     * Hybrid: RPC Direct (HTTPS) first, HTTP fallback on failure.
     */
    private async fetchConversationData(
        serverInfo: ServerInfo,
        conversationIds: string[],
        onProgress?: (done: number) => void,
        /** Per-conversation offsets for delta fetch (incrementalRefresh only) */
        offsetMap?: Map<string, { meta: number; steps: number }>,
    ): Promise<Record<string, ConvoTokenData>> {
        const result: Record<string, ConvoTokenData> = {};
        if (conversationIds.length === 0) {
            log.diag('fetchConversationData: called with 0 conversations — returning empty');
            return result;
        }

        const rpc = new RpcDirectClient(serverInfo);
        const rpcAvailable = rpc.isAvailable();
        log.diag(`fetchConversationData: ${conversationIds.length} conversations — RPC available=${rpcAvailable} (httpsPort=${serverInfo.httpsPort ?? 'none'})`);

        let useRpc = false;
        if (rpcAvailable) {
            try {
                useRpc = await rpc.heartbeat();
                log.diag(`fetchConversationData: RPC heartbeat ${useRpc ? '✓ validated' : '✗ failed'} on port ${serverInfo.httpsPort}`);
            } catch (e: any) {
                log.diag('fetchConversationData: RPC heartbeat threw:', e?.message);
            }
        } else {
            log.diag(`fetchConversationData: RPC not available — httpsPort is ${serverInfo.httpsPort} — will use HTTP fallback`);
        }

        let processed = 0;
        let withEntries = 0;
        await concurrentPool(
            conversationIds,
            async (cid) => {
                const offsets = offsetMap?.get(cid);
                const entries = await this.fetchAndDedup(
                    serverInfo, rpc, useRpc, cid, 1,
                    offsets?.meta ?? 0, offsets?.steps ?? 0,
                );
                if (entries.length > 0) { result[cid] = { entries }; withEntries++; }
            },
            BATCH_CONCURRENCY,
            () => { this.processLock.heartbeat(); processed++; onProgress?.(processed); },
        );
        log.diag(`fetchConversationData: pool done — ${processed} processed, ${withEntries}/${conversationIds.length} had token data`);

        // Retry: conversations with known stepCounts but 0 entries (timeout under load)
        if (this.currentStepCounts) {
            const missed = conversationIds.filter(cid =>
                !(cid in result) && (this.currentStepCounts?.get(cid) ?? 0) > 0,
            );
            if (missed.length > 0) {
                log.info(`fetchConversationData: retry — ${missed.length} conversations had stepCounts but 0 entries — serial, full fetch`);
                let retryHits = 0;
                await concurrentPool(
                    missed,
                    async (cid) => {
                        // Retry always does full fetch (offset=0) — the delta may have been the issue
                        const entries = await this.fetchAndDedup(serverInfo, rpc, false, cid, 2, 0, 0);
                        if (entries.length > 0) {
                            result[cid] = { entries };
                            retryHits++;
                            log.diag(`fetchConversationData: RETRY OK: ${cid.substring(0, 12)} — ${entries.length} entries`);
                        }
                    },
                    1,
                );
                log.info(`fetchConversationData: retry complete — ${retryHits}/${missed.length} recovered`);
            } else {
                const zeroEntryCount = conversationIds.filter(cid => !(cid in result)).length;
                if (zeroEntryCount > 0) {
                    log.diag(`fetchConversationData: ${zeroEntryCount} conversations returned 0 entries and had 0 stepCount (likely empty/no-op)`);
                }
            }
        }

        return result;
    }

    /** Fetch meta+steps for a single conversation, merge, and dedup. */
    private async fetchAndDedup(
        serverInfo: ServerInfo, rpc: RpcDirectClient, useRpc: boolean,
        cid: string, timeoutMultiplier: number,
        startMetaOffset = 0, startStepOffset = 0,
    ): Promise<TokenEntry[]> {
        const STEPS_TIMEOUT = 20000 * timeoutMultiplier;
        const META_TIMEOUT = FETCH_TIMEOUT_MS * timeoutMultiplier;

        // RPC Direct doesn't support offset — use only for full fetch (offset=0)
        const canRpc = useRpc && startMetaOffset === 0 && startStepOffset === 0;

        const [metaResult, stepsResult] = await Promise.allSettled([
            this.fetchMetaForConvo(serverInfo, rpc, canRpc, cid, META_TIMEOUT, startMetaOffset),
            this.fetchStepsForConvo(serverInfo, rpc, canRpc, cid, STEPS_TIMEOUT, startStepOffset),
        ]);

        const meta = metaResult.status === 'fulfilled' ? metaResult.value : null;
        const steps = stepsResult.status === 'fulfilled' ? stepsResult.value : null;

        // Track raw counts BEFORE dedup — meta/steps use independent LS offsets
        this.rawFetchCounts[cid] = {
            meta: startMetaOffset + (meta?.length ?? 0),
            steps: startStepOffset + (steps?.length ?? 0),
        };

        const metaEntries = meta ? this.extractEntries(meta) : [];
        const stepEntries = steps ? this.extractStepEntries(steps) : [];

        return this.dedupEntries([...metaEntries, ...stepEntries]);
    }

    /**
     * Fetch ALL metadata for a conversation using cumulative-offset pagination.
     *
     * The LS caps each response at ~8 MB, so large conversations (4000+ entries)
     * require multiple calls. The `generator_metadata_offset` parameter skips
     * that many entries from the start. We use the cumulative item count as
     * the next offset and stop when no new items arrive.
     *
     * History: paginateAll (pre-b61) produced 20× redundant 8 MB payloads
     * because it re-fetched overlapping ranges without a proper stop condition.
     */
    private async fetchMetaForConvo(
        serverInfo: ServerInfo, rpc: RpcDirectClient, useRpc: boolean,
        cid: string, timeout: number, startOffset = 0,
    ): Promise<any[] | null> {
        if (useRpc) {
            const result = await rpc.getMetadata(cid);
            if (result) return result;
        }
        const all: any[] = [];
        let offset = startOffset;
        for (let pg = 0; pg < 30; pg++) {
            const resp = await callLsJson(serverInfo, EP.METADATA,
                { cascade_id: cid, generator_metadata_offset: offset }, timeout,
            ).catch((err) => { log.warn(`Meta page ${pg} for ${cid.substring(0,8)}: ${err?.message}`); return null; });
            const items = resp?.generatorMetadata || resp?.generator_metadata || [];
            if (items.length === 0) break;
            all.push(...items);
            offset = startOffset + all.length;
        }
        return all.length > 0 ? all : null;
    }

    /**
     * Fetch ALL steps for a conversation using cumulative-offset pagination.
     * Same strategy as fetchMetaForConvo — cumulative offset until exhausted.
     */
    private async fetchStepsForConvo(
        serverInfo: ServerInfo, rpc: RpcDirectClient, useRpc: boolean,
        cid: string, timeout: number, startOffset = 0,
    ): Promise<any[] | null> {
        if (useRpc) {
            const result = await rpc.getSteps(cid);
            if (result) return result;
        }
        const all: any[] = [];
        let offset = startOffset;
        for (let pg = 0; pg < 30; pg++) {
            const resp = await callLsJson(serverInfo, EP.STEPS,
                { cascade_id: cid, step_offset: offset }, timeout,
            ).catch((err) => { log.warn(`Steps page ${pg} for ${cid.substring(0,8)}: ${err?.message}`); return null; });
            const items = resp?.steps || [];
            if (items.length === 0) break;
            all.push(...items);
            offset = startOffset + all.length;
        }
        return all.length > 0 ? all : null;
    }

    /**
     * Fingerprint-based dedup: token counts + timestamp truncated to seconds.
     * Model EXCLUDED — meta returns resolved name, steps returns placeholder.
     * Uses shared entryFingerprint() from types.ts.
     */
    private dedupEntries(entries: TokenEntry[]): TokenEntry[] {
        const seen = new Set<string>();
        return entries.filter(e => {
            const fp = entryFingerprint(e);
            if (seen.has(fp)) return false;
            seen.add(fp);
            return true;
        });
    }

    /**
     * Build per-conversation entry counts for offset-based delta fetch.
     * Uses raw (pre-dedup) meta/steps counts from rawFetchCounts.
     * Critical: generator_metadata_offset and step_offset are independent
     * LS-side counters. Using deduped entry count (meta+steps combined)
     * would produce offset > totalMeta → LS returns 0 → silent data loss.
     */
    private buildEntryCounts(
        existingCounts?: Record<string, { meta: number; steps: number }>,
    ): Record<string, { meta: number; steps: number }> {
        return { ...(existingCounts || {}), ...this.rawFetchCounts };
    }

    /**
     * Re-aggregate stats with a date range filter.
     * Called when user changes time range (24h/7d/30d/all).
     * Prefers in-memory data to avoid redundant disk I/O.
     */
    getFilteredStats(range: string): DeepUsageStats | null {
        // Prefer memory → disk fallback
        let perConvo: Record<string, ConvoTokenData> | null = null;
        let titleMap = this.currentTitleMap;

        if (Object.keys(this.currentPerConvo).length > 0) {
            perConvo = this.currentPerConvo;
        } else {
            const diskCache = this.cache.read();
            if (diskCache) {
                perConvo = diskCache.perConvo;
                titleMap = diskCache.titleMap
                    ? new Map<string, string>(Object.entries(diskCache.titleMap))
                    : this.currentTitleMap;
            }
        }

        if (!perConvo) return this.deepStatsCache;

        let cutoffStr = '';
        if (range !== 'all') {
            const now = new Date();
            let cutoff: Date | null = null;

            switch (range) {
                // Rolling presets (relative to now)
                case '24h': cutoff = new Date(now.getTime() - 86400000); break;
                case '7d': cutoff = new Date(now.getTime() - 7 * 86400000); break;
                case '30d': cutoff = new Date(now.getTime() - 30 * 86400000); break;

                // Calendar presets (midnight-aligned)
                case 'today':
                    cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                    break;
                case 'this-week': {
                    const dayOfWeek = now.getDay() || 7; // Mon=1, Sun=7
                    cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek + 1);
                    break;
                }
                case 'this-month':
                    cutoff = new Date(now.getFullYear(), now.getMonth(), 1);
                    break;
                case 'last-month':
                    cutoff = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                    break;
                default: break;
            }

            if (cutoff) {
                cutoffStr = cutoff.toISOString();
            }
        }

        return aggregateFromPerConvo(perConvo, titleMap, cutoffStr);
    }

    // ─── Trajectory Summaries (titles + stepCounts) ───

    private async fetchTrajectorySummaries(serverInfo: ServerInfo): Promise<{
        titleMap: Map<string, string>;
        stepCounts: Map<string, number>;
    }> {
        const titleMap = new Map<string, string>();
        const stepCounts = new Map<string, number>();
        // Phase 1: Fetch global data directly from state.vscdb (SSOT for all workspaces)
        try {
            const globalData = await getGlobalIndexData();
            for (const [id, title] of globalData.titleMap.entries()) {
                titleMap.set(id, title);
            }
            for (const [id, count] of globalData.stepCounts.entries()) {
                stepCounts.set(id, count);
            }
            log.info(`fetchTrajectorySummaries: loaded ${globalData.titleMap.size} titles, ${globalData.stepCounts.size} stepCounts from vscdb`);
        } catch (e: any) {
            log.warn('Failed to fetch global index data:', e.message);
        }

        // Phase 2: Fetch current workspace stats via LS
        log.info(`fetchTrajectorySummaries: calling ${EP.TRAJECTORIES} on port ${serverInfo.port}`);
        try {
            const trajResp = await callLsJson(serverInfo, EP.TRAJECTORIES, {});
            if (!trajResp) {
                log.warn('fetchTrajectorySummaries: API returned null/empty response — LS may be offline or on wrong port');
                return { titleMap, stepCounts };
            }
            const sums = trajResp?.trajectorySummaries || {};
            const entries = Object.entries(sums);
            log.info(`fetchTrajectorySummaries: API returned ${entries.length} trajectory summaries`);

            // Debug: log first entry's field names to help diagnose schema changes
            if (entries.length > 0) {
                const [firstId, firstVal] = entries[0];
                log.diag(`fetchTrajectorySummaries: sample fields for ${firstId.substring(0, 12)}: [${Object.keys(firstVal as any).join(', ')}]`);
            } else {
                log.warn('fetchTrajectorySummaries: trajectorySummaries is empty — no conversations visible to this LS instance');
                log.warn(`fetchTrajectorySummaries: raw response keys: [${Object.keys(trajResp).join(', ')}]`);
            }

            for (const [id, v] of entries) {
                const val = v as any;
                const title = val.summary || val.title || val.displayName || val.name || val.description || '';
                // LS titles have highest fidelity for the current workspace, so override if present
                if (title) titleMap.set(id, title);
                else if (!titleMap.has(id)) titleMap.set(id, 'Untitled');

                const sc = parseInt(val.stepCount || '0', 10);
                if (sc > 0) stepCounts.set(id, sc);
            }
            log.diag(`fetchTrajectorySummaries: done — ${titleMap.size} titles, ${stepCounts.size} with stepCounts`);
        } catch (e: unknown) {
            log.warn('fetchTrajectorySummaries: FAILED:', (e as Error)?.message);
        }
        return { titleMap, stepCounts };
    }

    /**
     * Synchronous disk cache load — returns pre-aggregated stats instantly.
     * Called during refresh() to populate usage stats BEFORE the first webview render.
     * Returns null if no cache exists (triggers full async fetch instead).
     */
    loadFromDiskCacheSync(): DeepUsageStats | null {
        if (this.deepStatsCache) return this.deepStatsCache;
        const result = this.cache.loadSync(this.currentTitleMap);
        if (!result) return null;
        this.currentTitleMap = result.titleMap;
        // NOTE: intentionally NOT setting this.deepStatsCache here.
        // The quotaManager stores this in lastUsageStats.
        // Keeping deepStatsCache empty allows fetchDeepStats() to proceed
        // to incrementalRefresh() for fresh data from the language server.
        return result.stats;
    }

    /** Scan ~/.gemini/antigravity/brain/ for conversation UUIDs */
    private discoverConversationIds(): string[] {
        const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
        if (!fs.existsSync(brainDir)) {
            log.warn(`discoverConversationIds: brain dir does not exist: ${brainDir}`);
            return [];
        }

        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        try {
            const allEntries = fs.readdirSync(brainDir, { withFileTypes: true });
            const uuidDirs = allEntries.filter(d => d.isDirectory() && UUID_RE.test(d.name));
            log.diag(`discoverConversationIds: brain dir has ${allEntries.length} total entries, ${uuidDirs.length} are UUID conversation dirs`);
            return uuidDirs.map(d => d.name);
        } catch (e: any) {
            log.warn(`discoverConversationIds: failed to read brain dir: ${e?.message}`);
            return [];
        }
    }

    // ─── Response Extractors ───




    /** Extract TokenEntry[] from metadata items array */
    private extractEntries(items: any[]): TokenEntry[] {
        const entries: TokenEntry[] = [];

        for (const item of items) {
            const cm = item.chatModel || item.chat_model || {};
            const usage = cm.usage || {};
            const { inp, out, cache, cacheWrite, reasoning } = extractTokens(usage);
            if (inp === 0 && out === 0 && cache === 0) continue;

            const rawModel = cm.responseModel || cm.response_model || usage.model || cm.model || 'Unknown';
            const apiProvider = usage.apiProvider || usage.api_provider || '';

            const ts = cm.chatStartMetadata?.createdAt || cm.chat_start_metadata?.created_at || '';
            entries.push({ inp, out, cache, cacheWrite, reasoning, model: rawModel, provider: apiProvider, ts });
        }

        return entries;
    }

    /** Extract TokenEntry[] from steps items array */
    private extractStepEntries(steps: any[]): TokenEntry[] {
        const entries: TokenEntry[] = [];

        for (const step of steps) {
            const usage = step.modelUsage || step.model_usage || step.metadata?.modelUsage || {};
            const rawModel = usage.model || 'Unknown';
            const { inp, out, cache, cacheWrite, reasoning } = extractTokens(usage);
            if (inp === 0 && out === 0 && cache === 0) continue;

            // Protobuf schema: real timestamp lives inside step.metadata (CortexStepMetadata)
            const meta = step.metadata || {};
            let ts = meta.createdAt || meta.created_at || meta.startedAt || meta.started_at
                || step.createdAt || step.created_at || step.startTime || step.start_time || '';
            // Handle stepTimestamp (varint epoch from GetCascadeTrajectory's TrajectoryStep wrapper)
            if (!ts) {
                const epoch = Number(step.stepTimestamp || step.step_timestamp || 0);
                if (epoch > 1e9) {
                    ts = new Date(epoch > 1e12 ? epoch : epoch * 1000).toISOString();
                }
            }
            entries.push({ inp, out, cache, cacheWrite, reasoning, model: rawModel, provider: '', ts });
        }

        return entries;
    }

}
