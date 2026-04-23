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
    ConvoTokenData, DiskCacheData,
    EP, BATCH_CONCURRENCY, HOT_THRESHOLD_MS, FETCH_TIMEOUT_MS,
} from './types';
import { aggregateFromPerConvo, extractTokens, paginateAll } from './aggregator';
import { StatsCache } from './cache';
import { ProcessLock } from './processLock';
import { concurrentPool } from './pool';

const log = createLogger('UsageStats');

export class UsageStatsService {

    /** Memory cache for deep stats (expensive to compute) */
    private deepStatsCache: DeepUsageStats | null = null;

    /** In-memory per-convo data — available during progressive fetch before disk cache exists */
    private currentPerConvo: Record<string, ConvoTokenData> = {};
    private currentTitleMap: Map<string, string> = new Map();
    private currentStepCounts: Map<string, number> = new Map();

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
    ): Promise<DeepUsageStats | null> {
        // 1. Instant return from memory cache (fastest) — skip if forceRefresh
        if (this.deepStatsCache && !forceRefresh) return this.deepStatsCache;

        // 2. Try disk cache + incremental refresh (picks up new conversations)
        const diskCache = this.cache.read();
        if (diskCache) {
            this.deepStatsCache = diskCache.stats;
            log.info(`Deep stats: loaded from disk cache (${diskCache.fetchedIds.length} conversations, forceRefresh=${forceRefresh})`);

            // Cross-process lock: only 1 window fetches, others read cache only
            if (!this.processLock.acquire()) {
                return this.deepStatsCache;
            }
            try {
                const updated = await this.incrementalRefresh(serverInfo, diskCache).catch(() => false);
                if (updated && onBackfillComplete) onBackfillComplete(this.deepStatsCache!);
            } finally {
                this.processLock.release();
            }

            return this.deepStatsCache;
        }

        // 3. Two-phase fetch (first time only — no disk cache exists)
        //    Lock guard: only 1 window does the expensive cold boot
        if (!this.processLock.acquire()) {
            log.info('Another instance is fetching — waiting for disk cache');
            return null;
        }
        try {
            return await this.twoPhaseFullFetch(serverInfo, onBackfillComplete);
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
    ): Promise<DeepUsageStats | null> {
        try {
            const allIds = this.discoverConversationIds();
            if (allIds.length === 0) {
                log.info('No conversations found on disk');
                return null;
            }

            // Split into HOT (recent 48h) and COLD
            const cutoffMs = Date.now() - HOT_THRESHOLD_MS;
            const { hot, cold } = this.partitionByMtime(allIds, cutoffMs);
            log.info(`Two-phase fetch: ${hot.length} hot + ${cold.length} cold = ${allIds.length} total`);

            // Phase 1: Fetch HOT conversations + trajectory summaries (titles + stepCounts)
            const [summaries, hotData] = await Promise.all([
                this.fetchTrajectorySummaries(serverInfo),
                this.fetchConversationData(serverInfo, hot),
            ]);

            this.currentTitleMap = summaries.titleMap;
            this.currentStepCounts = summaries.stepCounts;
            this.currentPerConvo = { ...hotData };

            const hotStats = aggregateFromPerConvo(hotData, summaries.titleMap);
            this.deepStatsCache = hotStats;
            log.info(`Phase 1 complete: ${hotStats.totalCalls} calls from ${hot.length} recent conversations`);

            // If no cold conversations, write final cache and return
            if (cold.length === 0) {
                this.cache.write(hotData, allIds, hotStats, summaries.titleMap, summaries.stepCounts);
                return hotStats;
            }

            // Phase 2: Fetch COLD conversations inline (not background).
            // Returning partial Phase 1 data caused flip-flop ($3 → $177 → $203).
            // Await full result so the UI transitions once: loading → correct data.
            log.info(`Phase 2: fetching ${cold.length} cold conversations...`);
            const coldData = await this.fetchConversationData(serverInfo, cold);
            const merged = { ...hotData, ...coldData };
            this.currentPerConvo = merged;

            const fullStats = aggregateFromPerConvo(merged, summaries.titleMap);
            this.deepStatsCache = fullStats;
            this.cache.write(merged, allIds, fullStats, summaries.titleMap, summaries.stepCounts);
            log.info(`Phase 2 complete: ${fullStats.totalCalls} calls total`);

            if (onBackfillComplete) onBackfillComplete(fullStats);
            return fullStats;

        } catch (e: any) {
            log.warn('twoPhaseFullFetch failed:', e?.message);
            return null;
        }
    }

    /**
     * Background backfill: fetch cold conversations, merge, update cache.
     */
    private async backgroundBackfill(
        serverInfo: ServerInfo,
        coldIds: string[],
        existingData: Record<string, ConvoTokenData>,
        allIds: string[],
        titleMap: Map<string, string>,
        stepCounts: Map<string, number>,
        onComplete?: (stats: DeepUsageStats) => void,
    ): Promise<void> {
        log.info(`Background backfill: fetching ${coldIds.length} cold conversations...`);
        const coldData = await this.fetchConversationData(serverInfo, coldIds);

        // Merge hot + cold
        const merged = { ...existingData, ...coldData };
        this.currentPerConvo = merged;

        const stats = aggregateFromPerConvo(merged, titleMap);
        this.deepStatsCache = stats;
        this.cache.write(merged, allIds, stats, titleMap, stepCounts);

        log.info(`Background backfill complete: ${stats.totalCalls} calls total`);
        if (onComplete) onComplete(stats);
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
            } catch {
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
            const allIds = this.discoverConversationIds();
            const cachedSet = new Set(diskCache.fetchedIds);

            // 1. NEW conversations (not in cache at all)
            const newIds = allIds.filter(id => !cachedSet.has(id));

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

            const dirtyIds = [...new Set([...newIds, ...changedIds])];

            if (dirtyIds.length === 0) {
                log.info('Deep stats: incremental — no new or changed conversations');
                return false;
            }

            log.info(`Deep stats: incremental fetch — ${newIds.length} new, ${changedIds.length} changed (stepCount delta)`);

            const freshData = await this.fetchConversationData(serverInfo, dirtyIds);

            // ADDITIVE merge: never delete entries, only add new unique ones.
            // Prevents flip-flop when steps endpoint sporadically returns empty.
            const merged = { ...diskCache.perConvo };
            for (const [cid, fresh] of Object.entries(freshData)) {
                const existing = merged[cid];
                if (!existing) {
                    merged[cid] = fresh;
                } else {
                    const seen = new Set(existing.entries.map(e =>
                        `${e.inp}:${e.out}:${e.cache}:${e.model}:${e.ts}`));
                    const newOnly = fresh.entries.filter(e =>
                        !seen.has(`${e.inp}:${e.out}:${e.cache}:${e.model}:${e.ts}`));
                    if (newOnly.length > 0) {
                        merged[cid] = { entries: [...existing.entries, ...newOnly] };
                    }
                }
            }
            const mergedIds = [...new Set([...diskCache.fetchedIds, ...newIds])];
            const stats = aggregateFromPerConvo(merged, summaries.titleMap);

            this.deepStatsCache = stats;
            this.currentPerConvo = merged;
            this.cache.write(merged, mergedIds, stats, summaries.titleMap, summaries.stepCounts);

            log.info(`Deep stats: incremental complete — ${dirtyIds.length} dirty (${newIds.length} new + ${changedIds.length} changed)`);
            return true;
        } catch (e: any) {
            log.warn('incrementalRefresh failed:', e?.message);
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
    ): Promise<Record<string, ConvoTokenData>> {
        const result: Record<string, ConvoTokenData> = {};
        const rpc = new RpcDirectClient(serverInfo);
        let useRpc = rpc.isAvailable();
        if (useRpc) {
            const alive = await rpc.heartbeat();
            if (alive) {
                log.info(`RPC Direct validated on HTTPS port ${serverInfo.httpsPort}`);
            } else {
                log.warn('RPC Direct heartbeat failed — falling back to HTTP');
                useRpc = false;
            }
        }

        const STEPS_TIMEOUT = 12000;

        // Sliding-window pool: no batch-boundary idle time.
        // Each slot is reused the moment a conversation completes.
        await concurrentPool(
            conversationIds,
            async (cid) => {
                // Fetch BOTH metadata + steps in parallel per conversation.
                const [metaResult, stepsResult] = await Promise.allSettled([
                    (async () => {
                        let meta = useRpc ? await rpc.getMetadata(cid) : null;
                        if (!meta) {
                            const allMeta = await paginateAll(async (offset) => {
                                const resp = await callLsJson(serverInfo, EP.METADATA,
                                    { cascade_id: cid, generator_metadata_offset: offset }, FETCH_TIMEOUT_MS).catch(() => null);
                                return resp?.generatorMetadata || resp?.generator_metadata || [];
                            });
                            meta = allMeta.length > 0 ? allMeta : null;
                        }
                        return meta;
                    })(),
                    (async () => {
                        let steps = useRpc ? await rpc.getSteps(cid) : null;
                        if (!steps) {
                            const allSteps = await paginateAll(async (offset) => {
                                const resp = await callLsJson(serverInfo, EP.STEPS,
                                    { cascade_id: cid, step_offset: offset }, STEPS_TIMEOUT).catch(() => null);
                                return resp?.steps || [];
                            });
                            steps = allSteps.length > 0 ? allSteps : null;
                        }
                        return steps;
                    })(),
                ]);

                const meta = metaResult.status === 'fulfilled' ? metaResult.value : null;
                const steps = stepsResult.status === 'fulfilled' ? stepsResult.value : null;
                const metaEntries = meta ? this.extractEntries({ generatorMetadata: meta }) : [];
                const stepEntries = steps ? this.extractStepEntries({ steps }) : [];
                const merged = [...metaEntries, ...stepEntries];

                // Full fingerprint dedup across both sources
                const seen = new Set<string>();
                const entries = merged.filter(e => {
                    const fp = `${e.inp}:${e.out}:${e.cache}:${e.model}:${e.ts}`;
                    if (seen.has(fp)) return false;
                    seen.add(fp);
                    return true;
                });

                if (entries.length > 0) {
                    result[cid] = { entries };
                    const removed = merged.length - entries.length;
                    if (removed > 0 || stepEntries.length > 0) {
                        log.info(`FETCH: ${cid.substring(0, 12)} — meta=${metaEntries.length} steps=${stepEntries.length} deduped=${entries.length}`);
                    }
                }
            },
            BATCH_CONCURRENCY,
            // Heartbeat: keep the process lock alive during long fetches
            () => this.processLock.heartbeat(),
        );

        return result;
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
                case '7d':  cutoff = new Date(now.getTime() - 7 * 86400000); break;
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

    /**
     * Fetch trajectory summaries — extracts both titles and stepCounts in a single API call.
     * stepCounts are used for delta detection: only re-fetch conversations where steps increased.
     */
    private async fetchTrajectorySummaries(serverInfo: ServerInfo): Promise<{
        titleMap: Map<string, string>;
        stepCounts: Map<string, number>;
    }> {
        const titleMap = new Map<string, string>();
        const stepCounts = new Map<string, number>();
        try {
            const trajResp = await callLsJson(serverInfo, EP.TRAJECTORIES, {});
            const sums = trajResp?.trajectorySummaries || {};
            const entries = Object.entries(sums);

            // Debug: log first entry's field names
            if (entries.length > 0) {
                const [, firstVal] = entries[0];
                log.info(`TrajSummary sample fields: ${Object.keys(firstVal as any).join(', ')}`);
            }

            for (const [id, v] of entries) {
                const val = v as any;
                const title = val.summary || val.title || val.displayName || val.name || val.description || '';
                titleMap.set(id, title || 'Untitled');
                const sc = parseInt(val.stepCount || '0', 10);
                if (sc > 0) stepCounts.set(id, sc);
            }
        } catch { /* best-effort */ }
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
        if (!fs.existsSync(brainDir)) return [];

        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        try {
            return fs.readdirSync(brainDir, { withFileTypes: true })
                .filter(d => d.isDirectory() && UUID_RE.test(d.name))
                .map(d => d.name);
        } catch {
            return [];
        }
    }

    // ─── Response Extractors ───




    private extractMetadataItems(resp: any): any[] {
        if (!resp) return [];
        return resp.generator_metadata || resp.generatorMetadata || resp.metadata || [];
    }

    private extractStepItems(resp: any): any[] {
        if (!resp) return [];
        return resp.steps || resp.cascade_steps || resp.cascadeSteps || [];
    }

    /** Extract TokenEntry[] from metadata API response */
    private extractEntries(resp: any): import('./types').TokenEntry[] {
        const items = this.extractMetadataItems(resp);
        const entries: import('./types').TokenEntry[] = [];

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

    /** Extract TokenEntry[] from steps API response (separate endpoint) */
    private extractStepEntries(resp: any): import('./types').TokenEntry[] {
        const steps = this.extractStepItems(resp);
        const entries: import('./types').TokenEntry[] = [];

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
