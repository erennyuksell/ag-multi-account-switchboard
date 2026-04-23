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

export interface ContextWindowData {
    conversationId: string;
    title: string;
    model: string;
    provider: string;
    usedTokens: number;
    maxTokens: number;
    percentage: number;
    categories: ContextWindowCategory[];
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
    private static readonly META_PAGE_SIZE = 644;        // max entries per API response (empirically verified)
    private static readonly MAX_CACHE_ENTRIES = 5;       // LRU eviction threshold

    // getActiveContext removed — USS determines active conversation directly.
    // No heuristic "sort by lastUserInputTime" needed.

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
        // 1) GetCascadeTrajectory — gives numTotalGeneratorMetadata
        //    Note: this endpoint does NOT include summary/title — that comes from the caller.
        const trajResp = await this.callLs(serverInfo, 'GetCascadeTrajectory', { cascade_id: cascadeId });
        if (!trajResp) {
            log.info(`fetchAndCache: GetCascadeTrajectory returned null for ${cascadeId.substring(0, 12)}`);
            return null;
        }

        const totalMeta = parseInt(trajResp.numTotalGeneratorMetadata || '0', 10);
        if (totalMeta === 0) {
            log.info('fetchAndCache: numTotalGeneratorMetadata=0');
            return null;
        }

        // 2) Direct seek to last page
        const offset = Math.max(0, totalMeta - ContextWindowService.META_PAGE_SIZE);
        const resp = await this.callLs(serverInfo,
            'GetCascadeTrajectoryGeneratorMetadata',
            { cascade_id: cascadeId, generator_metadata_offset: offset });
        const metas = resp?.generatorMetadata || [];
        if (metas.length === 0) {
            log.info(`fetchAndCache: empty response at offset=${offset} (total=${totalMeta})`);
            return null;
        }

        // 3) Scan backwards for latest entry with real token data
        const lastMeta = this.scanForTokenData(metas);
        if (!lastMeta) {
            log.info(`fetchAndCache: no entry with token data in ${metas.length} entries`);
            return null;
        }

        // 4) Build ContextWindowData
        const result = this.buildContextWindowData(cascadeId, title, lastMeta);
        if (result) {
            this.setCacheEntry(cascadeId, result);
            const tokens = result.usedTokens;
            log.info(`fetchAndCache: offset=${offset}, total=${totalMeta}, entries=${metas.length}, tokens=${tokens}`);
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

        return {
            conversationId: cascadeId,
            title,
            model: this.formatModelName(responseModel),
            provider: this.formatProvider(usage.apiProvider || ''),
            usedTokens: totalTokens,
            maxTokens,
            percentage: Math.min(100, Math.round(totalTokens / maxTokens * 100)),
            categories,
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

    /** Scan metadata array backwards for the latest entry with real token data */
    private scanForTokenData(metas: any[]): any | null {
        // Diagnostic: dump last 5 entries to understand what's available
        const diagPath = '/tmp/ag-ctx-diag.log';
        const diag = (msg: string) => { try { require('fs').appendFileSync(diagPath, `[${new Date().toISOString()}] SCAN: ${msg}\n`); } catch {} };

        const last5 = metas.slice(-5);
        for (let j = last5.length - 1; j >= 0; j--) {
            const m = last5[j];
            const usage = m?.chatModel?.usage;
            const cwm = m?.chatModel?.chatStartMetadata?.contextWindowMetadata;
            const inputTokens = parseInt(usage?.inputTokens || '0', 10);
            const estimatedUsed = cwm?.estimatedTokensUsed || 0;
            const hasUsage = !!usage;
            const model = m?.chatModel?.responseModel || m?.chatModel?.usage?.model || '?';
            diag(`entry[${metas.length - last5.length + j}]: model=${model} inputTokens=${inputTokens} estimatedUsed=${estimatedUsed} hasUsage=${hasUsage}`);
        }

        for (let i = metas.length - 1; i >= 0; i--) {
            const m = metas[i];
            const usage = m?.chatModel?.usage;
            const cwm = m?.chatModel?.chatStartMetadata?.contextWindowMetadata;
            if (usage
                && parseInt(usage.inputTokens || '0', 10) > 0
                && cwm?.estimatedTokensUsed > 0) {
                diag(`MATCHED at index ${i}: tokens=${cwm.estimatedTokensUsed}`);
                return m;
            }
        }
        diag(`NO MATCH in ${metas.length} entries`);
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
     * Lightweight check: how many generator metadata entries exist for this cascade?
     * Only calls GetCascadeTrajectory (1 API call, fast) — no metadata fetch.
     * Used by quotaManager to detect when new entries appear (definitive "new data" signal).
     */
    async getMetaEntryCount(serverInfo: ServerInfo, cascadeId: string): Promise<number> {
        try {
            const resp = await this.callLs(serverInfo, 'GetCascadeTrajectory', { cascade_id: cascadeId });
            return parseInt(resp?.numTotalGeneratorMetadata || '0', 10);
        } catch {
            return 0;
        }
    }

    /** Thin wrapper: callLsJson that resolves null on error (contextWindow is best-effort) */
    private callLs(serverInfo: ServerInfo, method: string, body: any): Promise<any> {
        return callLsJson(serverInfo, method, body).catch(() => null);
    }
}
