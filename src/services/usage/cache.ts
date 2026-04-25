/**
 * Disk cache management for usage stats.
 * Handles read/write persistence and synchronous cache loading.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DeepUsageStats } from '../../types';
import { DiskCacheData, ConvoTokenData } from './types';
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

            // Sanitize: remove duplicate entries that may have been persisted
            // by older versions with the RPC pagination overlap bug.
            let totalRemoved = 0;
            for (const cid of Object.keys(data.perConvo)) {
                const entries = data.perConvo[cid].entries;
                if (!entries || entries.length === 0) continue;
                const seen = new Set<string>();
                const clean = entries.filter(e => {
                    const tsSec = e.ts?.substring(0, 19) || '';
                    const fp = `${e.inp}:${e.out}:${e.cache}:${tsSec}`;
                    if (seen.has(fp)) return false;
                    seen.add(fp);
                    return true;
                });
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
    ): void {
        try {
            // Serialize titleMap as plain object for JSON persistence
            const titleMapObj: Record<string, string> = {};
            for (const [k, v] of titleMap) titleMapObj[k] = v;
            const stepCountsObj: Record<string, number> = {};
            if (stepCounts) { for (const [k, v] of stepCounts) stepCountsObj[k] = v; }
            const data: DiskCacheData = {
                perConvo, fetchedIds, stats,
                updatedAt: new Date().toISOString(),
                titleMap: titleMapObj,
                stepCounts: stepCounts ? stepCountsObj : undefined,
            };
            fs.writeFileSync(this.filePath, JSON.stringify(data), 'utf-8');
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

        let stats: DeepUsageStats;
        let titleMap = currentTitleMap;

        if (cache.titleMap) {
            titleMap = new Map(Object.entries(cache.titleMap));
            // Re-aggregate with restored titleMap for correct cascade titles
            stats = aggregateFromPerConvo(cache.perConvo, titleMap);
        } else {
            stats = cache.stats;
        }

        log.info(`loadSync: loaded ${cache.fetchedIds.length} conversations, titles: ${titleMap.size}`);
        return { stats, titleMap };
    }
}
