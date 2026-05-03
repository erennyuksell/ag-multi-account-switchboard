/**
 * Pure aggregation functions for token usage data.
 * All functions are stateless and testable in isolation.
 */

import {
    TokenEntry, ConvoTokenData, MonthlyAccumulator, MetadataUsage,
    PLACEHOLDER_MAP, OPUS_46_CUTOFF, PROVIDER_DISPLAY,
} from './types';
import {
    DeepUsageStats, DailyBucket, HourlyBucket, ModelBucket,
    CascadeBucket, MonthlyBucket, MonthlyModelEntry,
    ProviderBucket, WeekdayBucket,
} from '../../types';
import { matchPricing } from '../../shared/usage-components';
import { HOURS_IN_DAY } from '../../shared/uiConstants';
import { isGenericTitle, getTitleFromBrain, getTitleFromTranscript } from '../../shared/titleResolver';

// ─── Model Display Name Resolution ───

function extractVersion(raw: string): string {
    const m = raw.match(/(?:opus|sonnet|haiku|gemini)-(\d+(?:[.-]\d+)?)/i);
    if (m) return m[1].replace('-', '.');
    return '';
}

/**
 * Resolve raw model string to display name.
 * @param ts — ISO timestamp for date-aware placeholder resolution (optional)
 */
export function getModelDisplayName(raw: string, apiProvider?: string, ts?: string): string {
    if (!raw || raw === 'Unknown') {
        return apiProvider ? (PROVIDER_DISPLAY[apiProvider] || apiProvider.replace(/^API_PROVIDER_/i, '')) : 'Unknown';
    }

    // Resolve placeholders — M26 is date-aware (4.5 before cutoff, 4.6 after)
    let resolved = PLACEHOLDER_MAP[raw] || raw;
    if (raw === 'MODEL_PLACEHOLDER_M26' && ts && ts.slice(0, 10) < OPUS_46_CUTOFF) {
        resolved = 'claude-opus-4-5-thinking';
    }

    // Unmapped placeholders: show as readable label (e.g. "Placeholder M50")
    if (resolved === raw && /^MODEL_PLACEHOLDER_/i.test(raw)) {
        const id = raw.replace(/^MODEL_PLACEHOLDER_/i, '');
        return `Placeholder ${id}`;
    }

    const name = resolved.replace(/^models[/\-_]/, '');
    const ver = extractVersion(name);
    const v = ver ? ` ${ver}` : '';

    if (/claude.*opus.*thinking/i.test(name)) return `Claude Opus${v} (Thinking)`;
    if (/claude.*opus/i.test(name)) return `Claude Opus${v}`;
    if (/claude.*sonnet.*thinking/i.test(name)) return `Claude Sonnet${v} (Thinking)`;
    // Sonnet 4.6+ is always the thinking variant — merge with above
    if (/claude.*sonnet/i.test(name)) {
        const version = parseFloat(ver);
        return version >= 4.6 ? `Claude Sonnet${v} (Thinking)` : `Claude Sonnet${v}`;
    }
    if (/claude.*haiku/i.test(name)) return `Claude Haiku${v}`;
    if (/claude/i.test(name)) return `Claude${v}`;

    if (/gemini.*pro.*high/i.test(name)) return `Gemini${v} Pro`;
    if (/gemini.*pro.*low/i.test(name)) return `Gemini${v} Pro (Low)`;
    if (/gemini.*pro.*image/i.test(name)) return `Gemini${v} Pro (Image)`;
    if (/gemini.*pro/i.test(name)) return `Gemini${v} Pro`;
    if (/gemini.*flash.*lite/i.test(name)) return `Gemini${v} Flash Lite`;
    if (/gemini.*flash/i.test(name)) return `Gemini${v} Flash`;

    if (/gpt.*oss/i.test(name)) return `GPT-OSS 120B`;

    return name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ─── Token Extraction ───

/** Extract token counts from an API usage object, handling both camelCase and snake_case field names. */
export function extractTokens(usage: MetadataUsage): { inp: number; out: number; cache: number; cacheWrite: number; reasoning: number } {
    return {
        inp: parseInt(usage.inputTokens || usage.input_tokens || '0', 10) || 0,
        out: parseInt(usage.outputTokens || usage.output_tokens || usage.responseOutputTokens || usage.response_output_tokens || '0', 10) || 0,
        cache: parseInt(usage.cacheReadTokens || usage.cache_read_tokens || '0', 10) || 0,
        cacheWrite: parseInt(usage.cacheCreationInputTokens || usage.cache_creation_input_tokens || usage.cacheWriteTokens || usage.cache_write_tokens || '0', 10) || 0,
        reasoning: parseInt(usage.reasoningTokens || usage.reasoning_tokens || usage.thinkingOutputTokens || usage.thinking_output_tokens || '0', 10) || 0,
    };
}

// ─── Bucket Builders ───

/** Build daily token buckets from filtered entries. */
function buildDailyBuckets(entries: Array<TokenEntry & { _caW: number; _reas: number }>): DailyBucket[] {
    const map: Record<string, DailyBucket> = {};
    for (const e of entries) {
        if (e.ts.length < 10) continue;
        const day = e.ts.slice(0, 10);
        if (!map[day]) map[day] = { date: day, input: 0, output: 0, cache: 0, cacheWrite: 0, reasoning: 0, calls: 0 };
        map[day].input += e.inp;
        map[day].output += e.out;
        map[day].cache += e.cache;
        map[day].cacheWrite += e._caW;
        map[day].reasoning += e._reas;
        map[day].calls++;
    }
    return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
}

/** Build 24-hour token buckets from filtered entries (UTC → local). */
function buildHourlyBuckets(entries: Array<TokenEntry & { _caW: number; _reas: number }>): HourlyBucket[] {
    const map: Record<number, HourlyBucket> = {};
    for (let h = 0; h < HOURS_IN_DAY; h++) {
        map[h] = { hour: h, input: 0, output: 0, cache: 0, cacheWrite: 0, reasoning: 0, calls: 0 };
    }
    const localOffset = -(new Date().getTimezoneOffset() / 60);
    for (const e of entries) {
        if (e.ts.length < 13) continue;
        const utcHour = parseInt(e.ts.slice(11, 13), 10);
        const hour = Math.floor((utcHour + localOffset + HOURS_IN_DAY) % HOURS_IN_DAY);
        if (hour >= 0 && hour < HOURS_IN_DAY) {
            map[hour].input += e.inp;
            map[hour].output += e.out;
            map[hour].cache += e.cache;
            map[hour].cacheWrite += e._caW;
            map[hour].reasoning += e._reas;
            map[hour].calls++;
        }
    }
    return Object.values(map).sort((a, b) => a.hour - b.hour);
}

/** Build model usage buckets from filtered entries. */
function buildModelBuckets(entries: Array<TokenEntry & { _caW: number; _reas: number; _displayName: string }>): ModelBucket[] {
    const map: Record<string, ModelBucket> = {};
    for (const e of entries) {
        const dn = e._displayName;
        if (!map[dn]) map[dn] = { displayName: dn, input: 0, output: 0, cache: 0, cacheWrite: 0, reasoning: 0, calls: 0 };
        map[dn].input += e.inp;
        map[dn].output += e.out;
        map[dn].cache += e.cache;
        map[dn].cacheWrite += e._caW;
        map[dn].reasoning += e._reas;
        map[dn].calls++;
    }
    return Object.values(map).sort((a, b) => (b.input + b.output + b.cache) - (a.input + a.output + a.cache));
}

/** Build provider usage buckets from filtered entries. */
function buildProviderBuckets(entries: Array<TokenEntry & { _caW: number; _reas: number }>): ProviderBucket[] {
    const map: Record<string, ProviderBucket> = {};
    for (const e of entries) {
        const prov = e.provider || 'unknown';
        if (!map[prov]) {
            const displayName = PROVIDER_DISPLAY[prov] || prov.replace(/^API_PROVIDER_/i, '') || 'Unknown';
            map[prov] = { provider: prov, displayName, input: 0, output: 0, cache: 0, cacheWrite: 0, reasoning: 0, calls: 0 };
        }
        map[prov].input += e.inp;
        map[prov].output += e.out;
        map[prov].cache += e.cache;
        map[prov].cacheWrite += e._caW;
        map[prov].reasoning += e._reas;
        map[prov].calls++;
    }
    return Object.values(map).sort((a, b) => (b.input + b.output + b.cache) - (a.input + a.output + a.cache));
}

/** Build day-of-week buckets from filtered entries (Mon=0 .. Sun=6). */
function buildWeekdayBuckets(entries: Array<TokenEntry & { _caW: number; _reas: number }>): WeekdayBucket[] {
    const LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const map: WeekdayBucket[] = LABELS.map((label, i) => ({
        day: i, label, input: 0, output: 0, cache: 0, cacheWrite: 0, reasoning: 0, calls: 0,
    }));
    for (const e of entries) {
        if (e.ts.length < 10) continue;
        const d = new Date(e.ts);
        const jsDay = d.getDay(); // 0=Sun .. 6=Sat
        const isoDay = jsDay === 0 ? 6 : jsDay - 1; // Mon=0 .. Sun=6
        map[isoDay].input += e.inp;
        map[isoDay].output += e.out;
        map[isoDay].cache += e.cache;
        map[isoDay].cacheWrite += e._caW;
        map[isoDay].reasoning += e._reas;
        map[isoDay].calls++;
    }
    return map;
}

/**
 * Build monthly buckets from ALL entries (ignores date filter).
 * Data-driven: emits every month that has data, sorted chronologically.
 * Consumers (sidebar/dashboard) decide which slice to display (e.g., by year).
 */
function buildMonthlyBuckets(allEntries: TokenEntry[]): MonthlyBucket[] {
    const monthlyMap: Record<string, MonthlyAccumulator> = {};

    for (const e of allEntries) {
        if (!e.ts || e.ts.length < 7) continue;
        const mk = e.ts.slice(0, 7);
        if (!monthlyMap[mk]) {
            monthlyMap[mk] = { input: 0, output: 0, cache: 0, cacheWrite: 0, reasoning: 0, calls: 0, models: {} };
        }
        const mm = monthlyMap[mk];
        mm.input += e.inp;
        mm.output += e.out;
        mm.cache += e.cache;
        mm.cacheWrite += e.cacheWrite || 0;
        mm.reasoning += e.reasoning || 0;
        mm.calls++;
        const dn = getModelDisplayName(e.model, e.provider, e.ts);
        if (!mm.models[dn]) mm.models[dn] = { tokens: 0, inp: 0, out: 0, cache: 0, reas: 0 };
        mm.models[dn].tokens += e.inp + e.out + e.cache;
        mm.models[dn].inp += e.inp;
        mm.models[dn].out += e.out;
        mm.models[dn].cache += e.cache;
        mm.models[dn].reas += e.reasoning || 0;
    }

    const MNAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthly: MonthlyBucket[] = [];

    // Data-driven: emit every month that exists in the data, sorted chronologically
    for (const key of Object.keys(monthlyMap).sort()) {
        const md = monthlyMap[key];
        const monthIdx = parseInt(key.slice(5, 7), 10) - 1;
        const total = md.input + md.output + md.cache;
        const allModels = Object.entries(md.models)
            .sort((a, b) => b[1].tokens - a[1].tokens);
        // Cost from ALL models (not just top 5)
        let monthCost = 0;
        for (const [name, d] of allModels) {
            const p = matchPricing(name);
            monthCost += (d.inp * p.input + d.cache * p.cache + d.out * p.output + d.reas * p.reasoning) / 1_000_000;
        }
        const topModels: MonthlyModelEntry[] = allModels
            .slice(0, 5)
            .map(([name, d]) => ({ displayName: name, tokens: d.tokens, cost: 0, inp: d.inp, out: d.out, cache: d.cache, reas: d.reas }));
        monthly.push({
            key, label: MNAMES[monthIdx],
            input: md.input, output: md.output,
            cache: md.cache, cacheWrite: md.cacheWrite,
            reasoning: md.reasoning, calls: md.calls,
            total, cost: monthCost, topModels,
        });
    }

    return monthly;
}

// ─── Main Aggregation Composer ───

/**
 * Aggregate DeepUsageStats from per-conversation cached data.
 * Composes pure bucket builders into the final stats object.
 * @param dateCutoff — Full ISO timestamp to filter entries. Empty = no filter.
 */
export function aggregateFromPerConvo(
    perConvo: Record<string, ConvoTokenData>,
    titleMap: Map<string, string>,
    dateCutoff: string = '',
): DeepUsageStats {
    // Collect ALL entries for monthly (unfiltered) and filtered entries for other buckets
    const allEntries: TokenEntry[] = [];
    const filteredEntries: Array<TokenEntry & { _caW: number; _reas: number; _displayName: string }> = [];
    const cascadeList: CascadeBucket[] = [];
    let totalIn = 0, totalOut = 0, totalCa = 0, totalCaW = 0, totalReas = 0, totalCalls = 0;

    for (const [cid, data] of Object.entries(perConvo)) {
        let cIn = 0, cOut = 0, cCache = 0, ccW = 0, cReas = 0, cCalls = 0;

        for (const e of data.entries) {
            allEntries.push(e);

            // Date range filter: skip entries before cutoff
            if (dateCutoff && e.ts < dateCutoff) continue;

            const eCaW = e.cacheWrite || 0;
            const eReas = e.reasoning || 0;
            const displayName = getModelDisplayName(e.model, e.provider, e.ts);

            filteredEntries.push({ ...e, _caW: eCaW, _reas: eReas, _displayName: displayName });
            cIn += e.inp; cOut += e.out; cCache += e.cache; ccW += eCaW; cReas += eReas; cCalls++;
        }

        totalIn += cIn; totalOut += cOut; totalCa += cCache; totalCaW += ccW; totalReas += cReas; totalCalls += cCalls;

        if (cCalls > 0) {
            let title = titleMap.get(cid) || '';
            
            if (isGenericTitle(title)) {
                title = getTitleFromBrain(cid, 50) || '';
                if (!title) title = getTitleFromTranscript(cid, 50) || '';
                if (!title) title = 'Conversation';
            }

            cascadeList.push({
                id: cid,
                title,
                input: cIn, output: cOut, cache: cCache, cacheWrite: ccW, reasoning: cReas, calls: cCalls,
            });
        }
    }

    // Build all buckets from their respective entry sets
    const daily = buildDailyBuckets(filteredEntries);
    const hourly = buildHourlyBuckets(filteredEntries);
    const models = buildModelBuckets(filteredEntries);
    const providers = buildProviderBuckets(filteredEntries);
    const weekday = buildWeekdayBuckets(filteredEntries);
    const monthly = buildMonthlyBuckets(allEntries);

    cascadeList.sort((a, b) => (b.input + b.output + b.cache) - (a.input + a.output + a.cache));

    const totalTokens = totalIn + totalOut + totalCa;
    const dateRange = daily.length > 0
        ? { from: daily[0].date, to: daily[daily.length - 1].date }
        : { from: '', to: '' };

    return {
        totalTokens, totalInput: totalIn, totalOutput: totalOut, totalCache: totalCa,
        totalCacheWrite: totalCaW, totalReasoning: totalReas,
        totalCalls, daysActive: daily.length,
        cacheRate: totalTokens > 0 ? Math.round((totalCa / totalTokens) * 100) : 0,
        dateRange, daily, hourly, models, cascades: cascadeList, providers, weekday, monthly,
    };
}
