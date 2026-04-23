/**
 * LiteLlmPricingCatalog — Dynamic pricing from LiteLLM's model catalog.
 * Fetches 700+ model prices from GitHub at boot, caches for 6 hours.
 * Resolution: exact match → suffix match → alias expansion → null
 */

import * as https from 'https';
import { createLogger } from '../utils/logger';

const log = createLogger('LiteLLM');

const PRICING_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface ModelPricing {
    inputCostPerToken: number;
    outputCostPerToken: number;
    cacheReadCostPerToken?: number;
    cacheWriteCostPerToken?: number;
    reasoningCostPerToken?: number;
}

interface CachedCatalog {
    exactIndex: Map<string, ModelPricing>;
    suffixIndex: Map<string, ModelPricing>;
    fetchedAt: number;
    modelCount: number;
}

let cached: CachedCatalog | null = null;

/** Initialize pricing catalog — call at boot (fire-and-forget). */
export async function initPricingCatalog(): Promise<void> {
    try { await fetchAndBuild(); }
    catch (e: any) { log.warn('LiteLLM init failed (hardcoded fallback active):', e?.message); }
}

/** Resolve pricing for a model name. Returns null → use hardcoded fallback. */
export function resolveLiteLlmPricing(modelName: string): ModelPricing | null {
    if (!cached) return null;

    // Background refresh if stale (still use current data)
    if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) {
        fetchAndBuild().catch(() => {});
    }

    const n = normalize(modelName);
    return cached.exactIndex.get(n)
        || cached.suffixIndex.get(n)
        || findByAliases(n)
        || null;
}

// ─── Internal ───

function findByAliases(model: string): ModelPricing | null {
    for (const alias of buildAliases(model)) {
        const m = cached!.exactIndex.get(alias) || cached!.suffixIndex.get(alias);
        if (m) return m;
    }
    return null;
}

async function fetchAndBuild(): Promise<void> {
    const raw = await fetchJson(PRICING_URL);
    const exactIndex = new Map<string, ModelPricing>();
    const suffixIndex = new Map<string, ModelPricing>();
    let count = 0;

    for (const [key, entry] of Object.entries(raw)) {
        if (key === 'sample_spec' || typeof entry !== 'object' || !entry) continue;
        const e = entry as Record<string, any>;

        // Skip non-chat models
        if (e.mode && e.mode !== 'chat' && e.mode !== 'completion') continue;
        if (!e.input_cost_per_token && !e.output_cost_per_token) continue;

        const p: ModelPricing = {
            inputCostPerToken: e.input_cost_per_token ?? 0,
            outputCostPerToken: e.output_cost_per_token ?? 0,
            cacheReadCostPerToken: e.cache_read_input_token_cost,
            cacheWriteCostPerToken: e.cache_creation_input_token_cost,
            reasoningCostPerToken: e.output_cost_per_reasoning_token,
        };

        const n = normalize(key);
        exactIndex.set(n, p);
        count++;

        for (const alias of buildAliases(n)) {
            if (!suffixIndex.has(alias)) suffixIndex.set(alias, p);
        }
    }

    cached = { exactIndex, suffixIndex, fetchedAt: Date.now(), modelCount: count };
    log.info(`LiteLLM pricing loaded: ${count} models`);
}

function normalize(name: string): string {
    return name.toLowerCase()
        .replace(/^(models[/\-_]|vertex_ai\/|anthropic\/|google\/|openai\/)/, '')
        .trim();
}

function buildAliases(model: string): string[] {
    const aliases: string[] = [];
    for (const s of ['-high', '-low', '-c', '-thinking', '-preview', '-latest', '-exp']) {
        if (model.endsWith(s)) aliases.push(model.slice(0, -s.length));
    }
    // gemini-3.1-pro → gemini-3-pro
    if (/\d+\.\d+/.test(model)) aliases.push(model.replace(/(\d+)\.\d+/, '$1'));
    // claude-opus-4-6 → claude-opus-4.6
    if (/\d+-\d+(?!-)/.test(model)) aliases.push(model.replace(/(\d+)-(\d+)(?!-)/, '$1.$2'));
    return aliases;
}

function fetchJson(url: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: 10000 }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch { reject(new Error('Invalid JSON from LiteLLM')); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('LiteLLM timeout')); });
    });
}
