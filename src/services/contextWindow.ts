/**
 * Context Window Service
 * Fetches real-time context window data for the active conversation.
 * Data source: LS Metadata API → contextWindowMetadata + completionConfig
 */

import { ServerInfo } from '../types';
import { callLsJson } from '../utils/lsClient';
import { createLogger } from '../utils/logger';

const log = createLogger('ContextWindow');

/** Known model context limits (tokens) */
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
    'claude-opus-4-6-thinking': 200_000,
    'claude-opus-4-7-thinking': 200_000,
    'claude-opus-4-6': 200_000,
    'claude-opus-4-7': 200_000,
    'claude-sonnet-4-6-thinking': 200_000,
    'claude-sonnet-4-6': 200_000,
    'gemini-3.1-pro': 1_000_000,
    'gemini-3-flash': 1_000_000,
    'gemini-2.5-flash': 1_000_000,
    'gemini-2.5-flash-lite': 1_000_000,
};

/** Chat message step type categories (children of "Chat Messages" group) */
const CHAT_STEP_MAP: Record<string, string> = {
    'USER_INPUT': 'User Input',
    'PLANNER_RESPONSE': 'Model Response',
    'CODE_ACTION': 'Code Edit',
    'RUN_COMMAND': 'Commands',
    'COMMAND_STATUS': 'Commands',
    'VIEW_FILE': 'File Read',
    'BROWSER_SUBAGENT': 'Browser',
    'ERROR_MESSAGE': 'Errors',
    'SEARCH': 'Search',
    'MCP_TOOL': 'MCP Call',
    'CHECKPOINT': 'Checkpoint',
};

/** Category display colors */
const CATEGORY_META: Record<string, { color: string; icon: string }> = {
    // Top-level groups
    'System Prompt': { color: '#6b7280', icon: '⚙' },
    'Tools': { color: '#f59e0b', icon: '🔧' },
    'Mcp Tools': { color: '#c084fc', icon: '🔌' },
    'Chat Messages': { color: '#4f9cf7', icon: '💬' },
    // Chat sub-categories
    'User Input': { color: '#4f9cf7', icon: '💬' },
    'Model Response': { color: '#a78bfa', icon: '🤖' },
    'Code Edit': { color: '#f59e0b', icon: '✏️' },
    'Commands': { color: '#4ade80', icon: '▶' },
    'File Read': { color: '#38bdf8', icon: '📄' },
    'Browser': { color: '#f472b6', icon: '🌐' },
    'MCP Call': { color: '#c084fc', icon: '🔧' },
    'Search': { color: '#fb923c', icon: '🔍' },
    'Errors': { color: '#ef4444', icon: '⚠' },
    'Checkpoint': { color: '#6b7280', icon: '📌' },
    'Other': { color: '#9ca3af', icon: '·' },
};

export interface ContextWindowCategory {
    name: string;
    tokens: number;
    percentage: number;
    color: string;
    icon: string;
    count: number;
}

export interface ContextBreakdownChild {
    name: string;
    numTokens: number;
    children?: { name: string; numTokens: number }[];
}

export interface ContextBreakdownGroup {
    name: string;
    numTokens: number;
    children?: ContextBreakdownChild[];
}

export interface ContextWindowData {
    conversationId: string;
    title: string;
    model: string;
    provider: string;
    usedTokens: number;
    maxTokens: number;
    percentage: number;
    categories: ContextWindowCategory[];
    /** Raw tokenBreakdown groups for the detail dashboard */
    rawBreakdown?: ContextBreakdownGroup[];
    completionConfig: {
        maxOutputTokens: number;
        temperature: number;
        topK: number;
        topP: number;
    };
    lastUpdated: string;
}

export class ContextWindowService {
    /** In-flight request dedup — prevents parallel identical LS calls */
    private inFlight = new Map<string, Promise<ContextWindowData | null>>();

    /**
     * Result-level cache — caches the FINAL ContextWindowData, not raw metadata.
     * On cache hit: ZERO API calls. On miss: 2 calls (GetCascadeTrajectory + metadata seek).
     * Capped at MAX_CACHE_ENTRIES to prevent unbounded growth across conversations.
     */
    private resultCache = new Map<string, { data: ContextWindowData; ts: number }>();
    private static readonly CACHE_TTL = 8_000;          // 8s — fast refresh during active coding
    private static readonly META_PAGE_SIZE = 150;         // small page → avoids API response truncation
    private static readonly MAX_CACHE_ENTRIES = 5;       // LRU eviction threshold

    /**
     * Fetch context window for a SPECIFIC cascade ID (no heuristic selection).
     * Used by USS tracker when it detects which conversation just changed.
     * Deduplicates parallel calls per cascadeId.
     */
    async getContextForCascade(serverInfo: ServerInfo, cascadeId: string): Promise<ContextWindowData | null> {
        const key = `cascade:${cascadeId}`;
        const existing = this.inFlight.get(key);
        if (existing) { log.info('getContextForCascade: reusing in-flight'); return existing; }

        const promise = this._getContextForCascade(serverInfo, cascadeId);
        this.inFlight.set(key, promise);
        try { return await promise; }
        finally { this.inFlight.delete(key); }
    }

    private async _getContextForCascade(serverInfo: ServerInfo, cascadeId: string): Promise<ContextWindowData | null> {
        try {
            log.info(`getContextForCascade: ${cascadeId.substring(0, 12)} (port=${serverInfo.port})`);

            // Check result cache first — ZERO API calls on hit
            const cached = this.resultCache.get(cascadeId);
            if (cached && Date.now() - cached.ts < ContextWindowService.CACHE_TTL) {
                log.info(`getContextForCascade: result cache hit (age=${Date.now() - cached.ts}ms)`);
                return cached.data;
            }

            // GetCascadeTrajectory does NOT include summary/title.
            // Fetch it from GetAllCascadeTrajectories for the specific cascade.
            const allResp = await this.callLs(serverInfo, 'GetAllCascadeTrajectories', {});
            const title = allResp?.trajectorySummaries?.[cascadeId]?.summary || 'Conversation';

            return this.fetchAndCacheContextData(serverInfo, cascadeId, title);
        } catch (err) {
            log.error('getContextForCascade failed:', err);
            return null;
        }
    }

    // ── Core: single call path for both entry points ──

    /**
     * Fetch context data for a specific cascade.
     *
     * API call chain (exactly 2 calls):
     * 1. GetCascadeTrajectory → numTotalGeneratorMetadata (title comes from caller)
     * 2. GetCascadeTrajectoryGeneratorMetadata(offset) → last page with token data
     */
    private async fetchAndCacheContextData(
        serverInfo: ServerInfo,
        cascadeId: string,
        title: string,
    ): Promise<ContextWindowData | null> {
        // PATH 1 (fast): GetCascadeTrajectory tells us the total → seek directly to last page.
        // PATH 2 (checkpoint-safe): numTotalGeneratorMetadata missing → forward-paginate from 0.
        //   Each batch replaces the previous; the LAST non-empty batch IS the tail.
        const trajResp = await this.callLs(serverInfo, 'GetCascadeTrajectory', { cascade_id: cascadeId });
        const apiTotal = parseInt(trajResp?.numTotalGeneratorMetadata || '0', 10);

        let metas: any[] = [];

        if (apiTotal > 0) {
            // Fast path — direct seek (1 extra call)
            const offset = Math.max(0, apiTotal - ContextWindowService.META_PAGE_SIZE);
            const resp = await this.callLs(serverInfo,
                'GetCascadeTrajectoryGeneratorMetadata',
                { cascade_id: cascadeId, generator_metadata_offset: offset });
            metas = resp?.generatorMetadata || [];
            log.diag(`FETCH: fast path apiTotal=${apiTotal} offset=${offset} got=${metas.length} cascade=${cascadeId.substring(0, 12)}`);
        } else {
            // Checkpoint path — forward-paginate to find the true end
            let offset = 0;
            let calls = 0;
            while (calls < 50) {  // safety cap
                const resp = await this.callLs(serverInfo,
                    'GetCascadeTrajectoryGeneratorMetadata',
                    { cascade_id: cascadeId, generator_metadata_offset: offset });
                const batch = resp?.generatorMetadata || [];
                if (batch.length === 0) break;
                metas = batch;  // only keep the LAST batch (= most recent entries)
                offset += batch.length;
                calls++;
                if (batch.length < 100) break;  // partial batch = reached the end
            }
            log.diag(`FETCH: paginated ${calls} calls, trueTotal=${offset} using last ${metas.length} cascade=${cascadeId.substring(0, 12)}`);
        }

        if (metas.length === 0) {
            log.info(`fetchAndCache: no usable entries for ${cascadeId.substring(0, 12)}`);
            return null;
        }

        // 3) Find latest entry with real token data (most recent = most accurate context)
        const lastMeta = this.scanForTokenData(metas);
        if (!lastMeta) {
            log.info(`fetchAndCache: no entry with token data in ${metas.length} entries`);
            return null;
        }

        // If the freshest entry lacks model info (in-progress turn),
        // inherit model/usage from the nearest previous entry that has it.
        const chatModel = lastMeta.chatModel || {};
        const responseModel = chatModel.responseModel || chatModel.usage?.model;
        if (!responseModel || responseModel === 'unknown') {
            for (let i = metas.length - 2; i >= Math.max(0, metas.length - 10); i--) {
                const prev = metas[i]?.chatModel;
                const prevModel = prev?.responseModel || prev?.usage?.model;
                if (prevModel && prevModel !== 'unknown') {
                    // Merge model info into the matched entry
                    if (!chatModel.responseModel) chatModel.responseModel = prevModel;
                    if (!chatModel.usage && prev?.usage) chatModel.usage = prev.usage;
                    if (!chatModel.completionConfig && prev?.completionConfig) chatModel.completionConfig = prev.completionConfig;
                    break;
                }
            }
        }

        // 4) Build ContextWindowData
        const result = this.buildContextWindowData(cascadeId, title, lastMeta);
        if (result) {
            this.setCacheEntry(cascadeId, result);
            log.info(`fetchAndCache: entries=${metas.length}, tokens=${result.usedTokens}`);
        }
        return result;
    }

    // ── Builder ──

    private buildContextWindowData(
        cascadeId: string,
        title: string,
        lastMeta: any,
    ): ContextWindowData | null {
        const chatModel = lastMeta.chatModel || {};
        const usage = chatModel.usage || {};
        const config = chatModel.completionConfig || {};
        const cwm = chatModel.chatStartMetadata?.contextWindowMetadata;
        const responseModel = chatModel.responseModel || usage.model || 'unknown';
        const totalTokens = cwm?.estimatedTokensUsed || 0;

        log.info(`buildCtxData: model=${responseModel}, tokens=${totalTokens}`);
        if (totalTokens === 0) return null;

        const maxTokens = this.getMaxContext(responseModel);
        const categories = this.parseCategories(cwm);
        const rawBreakdown = this.extractRawBreakdown(cwm);

        return {
            conversationId: cascadeId,
            title,
            model: this.formatModelName(responseModel),
            provider: this.formatProvider(usage.apiProvider || ''),
            usedTokens: totalTokens,
            maxTokens,
            percentage: Math.min(100, Math.round(totalTokens / maxTokens * 100)),
            categories,
            rawBreakdown,
            completionConfig: {
                maxOutputTokens: parseInt(config.maxTokens || '0', 10),
                temperature: config.temperature || 0,
                topK: parseInt(config.topK || '0', 10),
                topP: config.topP || 0,
            },
            lastUpdated: new Date().toISOString(),
        };
    }

    private parseCategories(cwm: any): ContextWindowCategory[] {
        const groups = cwm?.tokenBreakdown?.groups;
        if (!groups || groups.length === 0) return [];

        const buckets: Record<string, { tokens: number; count: number }> = {};

        for (const group of groups) {
            const groupName: string = group.name || 'Other';
            const groupTokens: number = group.numTokens || 0;

            // "Chat Messages" group → break down by step type children
            if (groupName === 'Chat Messages' && group.children?.length > 0) {
                for (const child of group.children) {
                    const childName: string = child.name || '';
                    const childTokens: number = child.numTokens || 0;
                    if (childTokens <= 0) continue;

                    // Extract step type from "8392: PLANNER_RESPONSE" format
                    const typeMatch = childName.match(/^\d+:\s*(.+)$/);
                    const rawType = typeMatch ? typeMatch[1].trim() : childName;
                    const category = CHAT_STEP_MAP[rawType] || 'Other';

                    if (!buckets[category]) buckets[category] = { tokens: 0, count: 0 };
                    buckets[category].tokens += childTokens;
                    buckets[category].count += 1;
                }
            } else {
                // Top-level groups: System Prompt, Tools, Mcp Tools
                if (groupTokens > 0) {
                    buckets[groupName] = { tokens: groupTokens, count: group.children?.length || 1 };
                }
            }
        }

        const totalTokens = Object.values(buckets).reduce((s, b) => s + b.tokens, 0);

        return Object.entries(buckets)
            .sort(([, a], [, b]) => b.tokens - a.tokens)
            .map(([name, data]) => ({
                name,
                tokens: data.tokens,
                percentage: totalTokens > 0 ? Math.round(data.tokens / totalTokens * 100) : 0,
                color: CATEGORY_META[name]?.color || '#9ca3af',
                icon: CATEGORY_META[name]?.icon || '·',
                count: data.count,
            }));
    }

    private extractRawBreakdown(cwm: any): ContextBreakdownGroup[] {
        const groups = cwm?.tokenBreakdown?.groups;
        if (!groups || groups.length === 0) return [];

        return groups.map((g: any) => ({
            name: g.name || 'Unknown',
            numTokens: g.numTokens || 0,
            children: (g.children || []).map((c: any) => ({
                name: c.name || '',
                numTokens: c.numTokens || 0,
                children: (c.children || []).map((s: any) => ({
                    name: s.name || '',
                    numTokens: s.numTokens || 0,
                })),
            })),
        }));
    }

    private getMaxContext(model: string): number {
        // Try exact match first
        if (MODEL_CONTEXT_LIMITS[model]) return MODEL_CONTEXT_LIMITS[model];

        // Fuzzy match
        const lower = model.toLowerCase();
        if (lower.includes('opus')) return 200_000;
        if (lower.includes('sonnet')) return 200_000;
        if (lower.includes('gemini')) return 1_000_000;

        // Default fallback
        return 200_000;
    }

    private formatModelName(raw: string): string {
        return raw
            .replace('MODEL_PLACEHOLDER_', '')
            .replace(/-thinking$/, ' (Thinking)')
            .replace(/-/g, ' ')
            .replace(/\b\w/g, l => l.toUpperCase());
    }

    private formatProvider(raw: string): string {
        const map: Record<string, string> = {
            'API_PROVIDER_ANTHROPIC_VERTEX': 'Anthropic (Vertex)',
            'API_PROVIDER_GOOGLE': 'Google',
            'API_PROVIDER_OPENAI': 'OpenAI',
        };
        return map[raw] || raw.replace('API_PROVIDER_', '');
    }

    /**
     * Find the most recent metadata entry with real token data (estimatedTokensUsed > 0).
     * This is always the most accurate context window snapshot.
     */
    private scanForTokenData(metas: any[]): any | null {
        for (let i = metas.length - 1; i >= Math.max(0, metas.length - 100); i--) {
            const m = metas[i];
            const cwm = m?.chatModel?.chatStartMetadata?.contextWindowMetadata;
            if (!cwm?.estimatedTokensUsed || cwm.estimatedTokensUsed <= 0) continue;

            const groups = cwm?.tokenBreakdown?.groups;
            const chatGroup = groups?.find((g: any) => g.name === 'Chat Messages');
            const lastChild = chatGroup?.children?.[chatGroup.children.length - 1];
            const childCount = chatGroup?.children?.length ?? 0;
            log.diag(`SCAN HIT: idx=${i}/${metas.length} tokens=${cwm.estimatedTokensUsed} chatChildren=${childCount} lastChild="${lastChild?.name || 'none'}" (scanned ${metas.length - i}, skipped ${metas.length - 1 - i})`);
            return m;
        }

        log.diag(`SCAN TOTAL MISS: no entry with token data in ${metas.length} entries`);
        return null;
    }

    /** Set cache entry with LRU eviction at MAX_CACHE_ENTRIES */
    private setCacheEntry(cascadeId: string, data: ContextWindowData): void {
        // Delete first to move to "newest" position in insertion order
        this.resultCache.delete(cascadeId);
        this.resultCache.set(cascadeId, { data, ts: Date.now() });

        // Evict oldest entries if over limit
        if (this.resultCache.size > ContextWindowService.MAX_CACHE_ENTRIES) {
            const oldest = this.resultCache.keys().next().value;
            if (oldest) this.resultCache.delete(oldest);
        }
    }

    /**
     * Invalidate cached result for a specific cascade.
     * Called by USS eTag tracker when it detects the conversation data changed —
     * ensures the next fetch reads fresh metadata from the LS instead of returning stale cache.
     */
    invalidateCache(cascadeId: string): void {
        this.resultCache.delete(cascadeId);
    }

    /**
     * Lightweight live-fetch: get ONLY the last metadata entry for real-time context window
     * updates during model execution. Called on every stream delta.
     *
     * NOTE: `streamTotalLength` is used ONLY as a signal that new data exists.
     * The actual offset is derived from the API's own `numTotalGeneratorMetadata`
     * because the stream counts ALL entry types (chat, system, metadata) while
     * the API only counts generator metadata entries.
     */
    async fetchLastEntry(
        serverInfo: ServerInfo,
        cascadeId: string,
        _streamTotalLength: number,
        title: string,
    ): Promise<ContextWindowData | null> {
        // Get the API's own total — this is the authoritative count
        const trajResp = await this.callLs(serverInfo, 'GetCascadeTrajectory', { cascade_id: cascadeId });
        const apiTotal = parseInt(trajResp?.numTotalGeneratorMetadata || '0', 10);
        if (apiTotal <= 0) return null;

        const offset = Math.max(0, apiTotal - 1);
        const resp = await this.callLs(serverInfo,
            'GetCascadeTrajectoryGeneratorMetadata',
            { cascade_id: cascadeId, generator_metadata_offset: offset });
        const metas = resp?.generatorMetadata || [];
        if (metas.length === 0) return null;

        const lastMeta = this.scanForTokenData(metas);
        if (!lastMeta) return null;

        // Inherit model info from cached result if this entry lacks it
        const chatModel = lastMeta.chatModel || {};
        const responseModel = chatModel.responseModel || chatModel.usage?.model;
        if ((!responseModel || responseModel === 'unknown') && this.resultCache.has(cascadeId)) {
            const cached = this.resultCache.get(cascadeId)!;
            if (!chatModel.responseModel && cached.data.model) {
                chatModel.responseModel = cached.data.model;
            }
        }

        const result = this.buildContextWindowData(cascadeId, title, lastMeta);
        if (result) {
            this.setCacheEntry(cascadeId, result);
            log.diag(`LIVE: offset=${offset} tokens=${result.usedTokens} (${result.model})`);
        }
        return result;
    }

    /** Thin wrapper: callLsJson that resolves null on error (contextWindow is best-effort) */
    private callLs(serverInfo: ServerInfo, method: string, body: any): Promise<any> {
        return callLsJson(serverInfo, method, body).catch(() => null);
    }
}
