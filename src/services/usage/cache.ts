/**
 * Disk cache management for usage stats.
 * Handles read/write persistence and synchronous cache loading.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DeepUsageStats } from '../../types';
import {
    CACHE_SCHEMA_VERSION,
    DiskCacheData,
    ConvoTokenData,
    entryFingerprint,
    mergePreferredEntry,
} from './types';
import { aggregateFromPerConvo } from './aggregator';
import { createLogger } from '../../utils/logger';

const log = createLogger('StatsCache');

export class StatsCache {
    /** Path to the disk cache file */
    get filePath(): string {
        return path.join(os.homedir(), '.gemini', 'antigravity', 'brain', '.deep_stats_cache.json');
    }

    /** Read cached data from disk. Returns null if missing or corrupted. */
    read(): DiskCacheData | null {
        try {
            if (!fs.existsSync(this.filePath)) return null;
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            const data = JSON.parse(raw) as DiskCacheData;
            if (!data.perConvo || !data.fetchedIds || !data.stats) return null;
            if (data.schemaVersion !== CACHE_SCHEMA_VERSION) {
                log.info(`Cache read: ignoring schema v${data.schemaVersion ?? 1}; rebuild required for v${CACHE_SCHEMA_VERSION}`);
                return null;
            }

            // Sanitize: remove duplicate entries that may have been persisted
            // by older versions with the RPC pagination overlap bug.
            let totalRemoved = 0;
            for (const cid of Object.keys(data.perConvo)) {
                const entries = data.perConvo[cid].entries;
                if (!entries || entries.length === 0) continue;
                const byFingerprint = new Map<string, typeof entries[number]>();
                for (const e of entries) {
                    const fp = entryFingerprint(e);
                    const existing = byFingerprint.get(fp);
                    byFingerprint.set(fp, existing ? mergePreferredEntry(existing, e) : e);
                }
                const clean = [...byFingerprint.values()];
                if (clean.length < entries.length) {
                    totalRemoved += entries.length - clean.length;
                    data.perConvo[cid] = { entries: clean };
                }
            }
            if (totalRemoved > 0) {
                log.info(`Cache read: sanitized ${totalRemoved} duplicate entries`);
            }

            return data;
        } catch { /* expected: cache file may be corrupted or missing */
            return null;
        }
    }

    /** Write stats data to disk cache. */
    write(
        perConvo: Record<string, ConvoTokenData>,
        fetchedIds: string[],
        stats: DeepUsageStats,
        titleMap: Map<string, string>,
        stepCounts?: Map<string, number>,
        entryCounts?: Record<string, { meta: number; steps: number }>,
    ): void {
        try {
            // Serialize titleMap as plain object for JSON persistence
            const titleMapObj: Record<string, string> = {};
            for (const [k, v] of titleMap) titleMapObj[k] = v;
            const stepCountsObj: Record<string, number> = {};
            if (stepCounts) { for (const [k, v] of stepCounts) stepCountsObj[k] = v; }
            const data: DiskCacheData = {
                schemaVersion: CACHE_SCHEMA_VERSION,
                perConvo, fetchedIds, stats,
                updatedAt: new Date().toISOString(),
                titleMap: titleMapObj,
                stepCounts: stepCounts ? stepCountsObj : undefined,
                entryCounts,
            };
            const tmp = this.filePath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
            fs.renameSync(tmp, this.filePath); // atomic on POSIX
            log.info(`Disk cache written: ${fetchedIds.length} conversations, ${titleMap.size} titles`);
        } catch (e: any) {
            log.warn('Failed to write disk cache:', e?.message);
        }
    }

    /**
     * Synchronous disk cache load — returns pre-aggregated stats instantly.
     * Called during refresh() to populate usage stats BEFORE the first webview render.
     * Returns null if no cache exists.
     */
    loadSync(currentTitleMap: Map<string, string>): { stats: DeepUsageStats; titleMap: Map<string, string> } | null {
        const cache = this.read();
        if (!cache) return null;

        let titleMap = currentTitleMap;

        if (cache.titleMap) {
            titleMap = new Map(Object.entries(cache.titleMap));
        }
        // Re-aggregate from raw entries so semantic fixes apply to older caches.
        const stats = aggregateFromPerConvo(cache.perConvo, titleMap);

        log.info(`loadSync: loaded ${cache.fetchedIds.length} conversations, titles: ${titleMap.size}`);
        return { stats, titleMap };
    }
}
