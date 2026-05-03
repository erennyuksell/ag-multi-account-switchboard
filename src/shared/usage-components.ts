/**
 * Shared Usage Stats render components — SSOT for sidebar & detail panel.
 * Pure HTML-string generators. No DOM, no Node APIs, no side effects.
 * Used by: webview/renderers/usage.ts (sidebar) & providers/usageStatsPanel.ts (detail panel)
 */

import { fmtNum, fmtBig, fmtShortDate, escHtml } from './helpers';
import { DailyBucket, HourlyBucket, ModelBucket, CascadeBucket, MonthlyBucket, ProviderBucket, WeekdayBucket } from '../types';
import {
    CASCADE_LIST_LIMIT, CASCADE_TITLE_MAX_LEN,
    CASCADE_ENRICHED_LIMIT, CASCADE_ENRICHED_TITLE_MAX_LEN,
} from './uiConstants';

// ═══════════════════════════════════════════
//  KPI Cards
// ═══════════════════════════════════════════

export function kpiCard(_icon: string, value: string, label: string, color: string = ''): string {
    const style = color ? ` style="border-color:${color}33"` : '';
    const dot = color ? `<span class="deep-kpi-dot" style="background:${color}"></span>` : '';
    return `<div class="deep-kpi"${style}>`
        + '<div class="deep-kpi-val">' + value + '</div>'
        + '<div class="deep-kpi-label">' + dot + label + '</div>'
        + '</div>';
}

// ═══════════════════════════════════════════
//  Daily Breakdown Bars
// ═══════════════════════════════════════════

export function renderDailyBars(daily: DailyBucket[], costPerToken: number = 0): string {
    if (!daily || daily.length === 0) return '<div class="deep-empty">No data for this period</div>';

    const sorted = [...daily].sort((a, b) => b.date.localeCompare(a.date));
    const maxTokens = Math.max(...sorted.map(d => d.input + d.output + d.cache), 1);

    let html = '<div class="deep-daily-chart">';
    for (const d of sorted) {
        const total = d.input + d.output + d.cache;
        const barW = (total / maxTokens) * 100;
        const inPct = total > 0 ? (d.input / total * barW) : 0;
        const caPct = total > 0 ? (d.cache / total * barW) : 0;
        const ouPct = total > 0 ? (d.output / total * barW) : 0;

        let tipText = fmtShortDate(d.date) + '&#10;Input: ' + fmtBig(d.input) + '&#10;Cache: ' + fmtBig(d.cache) + '&#10;Output: ' + fmtBig(d.output) + '&#10;Total: ' + fmtBig(total) + ' (' + fmtNum(d.calls) + ' calls)';
        if (costPerToken > 0) {
            tipText += '&#10;Est. Cost: ' + fmtDollar(total * costPerToken);
        }
        html += '<div class="deep-daily-row" data-tip="' + tipText + '">';
        html += '<span class="deep-daily-date">' + fmtShortDate(d.date) + '</span>';
        html += '<div class="deep-daily-bar">';
        if (inPct > 0) html += '<div class="usage-bar-seg usage-c-input" style="width:' + inPct.toFixed(1) + '%"></div>';
        if (caPct > 0) html += '<div class="usage-bar-seg usage-c-cache" style="width:' + caPct.toFixed(1) + '%"></div>';
        if (ouPct > 0) html += '<div class="usage-bar-seg usage-c-output" style="width:' + ouPct.toFixed(1) + '%"></div>';
        html += '</div>';
        html += '<span class="deep-daily-total">' + fmtBig(total) + '</span>';
        html += '</div>';
    }
    html += '</div>';
    return html;
}

// ═══════════════════════════════════════════
//  Hourly Heatmap (24-hour pattern)
// ═══════════════════════════════════════════

export function renderHourlyHeatmap(hourly: HourlyBucket[], costPerToken: number = 0): string {
    if (!hourly || hourly.length === 0) return '';

    const maxTokens = Math.max(...hourly.map(h => h.input + h.output + h.cache), 1);
    const peakHour = hourly.reduce((best, cur) =>
        (cur.input + cur.output + cur.cache) > (best.input + best.output + best.cache) ? cur : best, hourly[0]);

    let html = '<div class="deep-heatmap-wrap">';
    html += '<div class="deep-heatmap">';
    for (const h of hourly) {
        const total = h.input + h.output + h.cache;
        const intensity = maxTokens > 0 ? (total / maxTokens) : 0;
        const isPeak = h.hour === peakHour.hour;
        const cls = isPeak ? ' deep-heatmap-peak' : '';
        const tipCls = h.hour <= 2 ? ' tip-right' : h.hour >= 22 ? ' tip-left' : '';
        let tipText = `${String(h.hour).padStart(2, '0')}:00`;
        tipText += `&#10;Tokens: ${fmtBig(total)}`;
        tipText += `&#10;Calls: ${fmtNum(h.calls)}`;
        if (total > 0) {
            tipText += `&#10;Input: ${fmtBig(h.input)}`;
            tipText += `&#10;Cache: ${fmtBig(h.cache)}`;
            tipText += `&#10;Output: ${fmtBig(h.output)}`;
        }
        if (costPerToken > 0 && total > 0) {
            tipText += `&#10;Cost: ~${fmtDollar(total * costPerToken)}`;
        }
        html += `<div class="deep-heatmap-cell${cls}${tipCls}" style="--intensity:${intensity.toFixed(3)}" data-tip="${tipText}">`;
        html += '<span class="deep-heatmap-hour">' + h.hour + '</span>';
        html += '</div>';
    }
    html += '</div>';
    html += '<div class="deep-heatmap-info">Peak: <strong>' + String(peakHour.hour).padStart(2, '0') + ':00</strong> (' + fmtBig(peakHour.input + peakHour.output + peakHour.cache) + ')</div>';
    html += '</div>';
    return html;
}

// ═══════════════════════════════════════════
//  GitHub-style Daily Contribution Grid
// ═══════════════════════════════════════════

const DAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', ''];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * @param large — if true, uses gh-grid-lg class for bigger cells (detail panel)
 * @param year — which year to render (defaults to current year)
 * @param costPerToken — blended cost per token for cost estimation
 */
export function renderDailyGrid(daily: DailyBucket[], large: boolean = false, year?: number, costPerToken: number = 0): string {
    const selectedYear = year ?? new Date().getFullYear();
    const today = new Date().toISOString().slice(0, 10);

    // Build date → tokens lookup
    const dateMap = new Map<string, { total: number; calls: number }>();
    for (const d of daily) {
        if (!d.date.startsWith(String(selectedYear))) continue; // filter to selected year
        const total = d.input + d.output + d.cache;
        dateMap.set(d.date, { total, calls: d.calls });
    }

    // Full year: Jan 1 → Dec 31
    const gridStartDate = new Date(selectedYear, 0, 1);   // Jan 1
    const gridEndDate = new Date(selectedYear, 11, 31);    // Dec 31

    // Align start to Monday
    const startDay = gridStartDate.getDay();
    const mondayOffset = startDay === 0 ? -6 : 1 - startDay;
    const gridStart = new Date(gridStartDate);
    gridStart.setDate(gridStart.getDate() + mondayOffset);

    // Extend end to Sunday
    const endDay = gridEndDate.getDay();
    const sundayOffset = endDay === 0 ? 0 : 7 - endDay;
    const gridEnd = new Date(gridEndDate);
    gridEnd.setDate(gridEnd.getDate() + sundayOffset);

    const maxTokens = Math.max(...Array.from(dateMap.values()).map(v => v.total), 1);

    type Cell = { date: string; total: number; calls: number; future: boolean };
    const weeks: Cell[][] = [];
    let currentWeek: Cell[] = [];
    const cursor = new Date(gridStart);
    let peakDay = { date: '', total: 0, calls: 0 };

    while (cursor <= gridEnd) {
        const iso = cursor.toISOString().slice(0, 10);
        const data = dateMap.get(iso);
        const total = data?.total || 0;
        const calls = data?.calls || 0;
        const future = iso > today;
        currentWeek.push({ date: iso, total, calls, future });
        if (total > peakDay.total) peakDay = { date: iso, total, calls };
        if (currentWeek.length === 7) { weeks.push(currentWeek); currentWeek = []; }
        cursor.setDate(cursor.getDate() + 1);
    }
    if (currentWeek.length > 0) weeks.push(currentWeek);

    // Month labels
    const lgCls = large ? ' gh-grid-lg' : '';
    let html = '<div class="gh-grid-wrap' + lgCls + '">';
    html += '<div class="gh-month-row"><span class="gh-day-label"></span>';
    let lastMonth = -1;
    for (const week of weeks) {
        const m = new Date(week[0].date + 'T00:00:00').getMonth();
        html += '<span class="gh-month-label">' + (m !== lastMonth ? MONTH_NAMES[m] : '') + '</span>';
        if (m !== lastMonth) lastMonth = m;
    }
    html += '</div>';

    // Grid
    html += '<div class="gh-grid">';
    html += '<div class="gh-day-col">';
    for (let row = 0; row < 7; row++) html += '<span class="gh-day-label">' + DAY_LABELS[row] + '</span>';
    html += '</div>';

    for (const week of weeks) {
        html += '<div class="gh-week-col">';
        for (const cell of week) {
            const level = cell.future ? 0
                : cell.total === 0 ? 0
                : (cell.total / maxTokens) < 0.15 ? 1
                : (cell.total / maxTokens) < 0.35 ? 2
                : (cell.total / maxTokens) < 0.65 ? 3 : 4;
            const costStr = (costPerToken > 0 && cell.total > 0) ? '&#10;~' + fmtDollar(cell.total * costPerToken) : '';
            const title = cell.future ? fmtShortDate(cell.date)
                : fmtShortDate(cell.date) + '&#10;' + (cell.total > 0 ? fmtBig(cell.total) + ' tokens&#10;' + fmtNum(cell.calls) + ' calls' + costStr : 'No activity');
            html += '<div class="gh-cell gh-lvl-' + level + '" data-tip="' + title + '"></div>';
        }
        html += '</div>';
    }
    html += '</div>';

    // Legend + Peak
    html += '<div class="gh-footer">';
    html += '<span class="gh-legend">Less <span class="gh-cell gh-lvl-0 gh-sm"></span><span class="gh-cell gh-lvl-1 gh-sm"></span><span class="gh-cell gh-lvl-2 gh-sm"></span><span class="gh-cell gh-lvl-3 gh-sm"></span><span class="gh-cell gh-lvl-4 gh-sm"></span> More</span>';
    if (peakDay.total > 0) {
        html += '<span class="gh-peak">Peak: <strong>' + fmtShortDate(peakDay.date) + '</strong> (' + fmtBig(peakDay.total) + ')</span>';
    }
    html += '</div>';
    html += '</div>';
    return html;
}

/** Extract available years from daily data (sorted descending) */
export function getAvailableYears(daily: DailyBucket[]): number[] {
    if (!daily || daily.length === 0) return [new Date().getFullYear()];
    const years = new Set<number>();
    for (const d of daily) {
        if (d.date.length >= 4) years.add(parseInt(d.date.slice(0, 4), 10));
    }
    return Array.from(years).sort((a, b) => b - a); // newest first
}

/** Year selector buttons */
export function renderYearSelector(years: number[], activeYear: number): string {
    if (years.length <= 1) return ''; // single year — no need for selector
    let html = '<div class="gh-year-bar">';
    for (const y of years) {
        const active = y === activeYear ? ' active' : '';
        html += '<button class="gh-year-btn' + active + '" data-action="set-grid-year" data-year="' + y + '">' + y + '</button>';
    }
    html += '</div>';
    return html;
}

// ═══════════════════════════════════════════
//  Model Breakdown
// ═══════════════════════════════════════════

export function renderModelBreakdown(models: ModelBucket[], totalTokens: number): string {
    if (!models || models.length === 0) return '';

    let html = '';
    for (const m of models) {
        const mTotal = m.input + m.output + m.cache;
        const pct = totalTokens > 0 ? (mTotal / totalTokens * 100).toFixed(1) : '0';
        const barPct = totalTokens > 0 ? (mTotal / totalTokens * 100) : 0;

        html += '<div class="deep-model">';
        // Header: name + total + pct
        html += '<div class="deep-model-hdr">';
        html += '<span class="deep-model-name">' + escHtml(m.displayName) + '</span>';
        html += '<span class="deep-model-stats">' + fmtNum(mTotal) + ' <span class="deep-model-pct">' + pct + '%</span></span>';
        html += '</div>';
        // Stacked progress bar (input + cache + output)
        html += '<div class="deep-model-bar">';
        if (mTotal > 0) {
            const inW = (m.input / mTotal * 100).toFixed(1);
            const caW = (m.cache / mTotal * 100).toFixed(1);
            const ouW = (m.output / mTotal * 100).toFixed(1);
            html += '<div class="usage-bar-seg usage-c-input" style="width:' + inW + '%"></div>';
            html += '<div class="usage-bar-seg usage-c-cache" style="width:' + caW + '%"></div>';
            html += '<div class="usage-bar-seg usage-c-output" style="width:' + ouW + '%"></div>';
        } else {
            html += '<div class="deep-model-fill" style="width:0%"></div>';
        }
        html += '</div>';
        // Detail: ● input · ● cache · ● output
        html += '<div class="deep-model-detail">';
        html += '<span><span class="usage-dot usage-c-input"></span>' + fmtNum(m.input) + ' in</span>';
        html += '<span><span class="usage-dot usage-c-cache"></span>' + fmtNum(m.cache) + ' cache</span>';
        html += '<span><span class="usage-dot usage-c-output"></span>' + fmtNum(m.output) + ' out</span>';
        html += '</div>';
        html += '<div class="deep-model-calls">' + fmtNum(m.calls) + ' calls</div>';
        html += '</div>';
    }
    return html;
}

// ═══════════════════════════════════════════
//  Cascade / Conversation List
// ═══════════════════════════════════════════

export function renderCascadeList(cascades: CascadeBucket[], limit: number = CASCADE_LIST_LIMIT, maxTitleLen: number = CASCADE_TITLE_MAX_LEN): string {
    const shown = cascades.slice(0, limit);

    let html = '<div class="deep-cascade-list">';
    for (const c of shown) {
        const total = c.input + c.output + c.cache;
        const title = c.title || 'Conversation';
        const short = title.length > maxTitleLen ? title.substring(0, maxTitleLen) + '…' : title;

        html += '<div class="deep-cascade-row">';
        html += '<span class="deep-cascade-title">' + escHtml(short) + '</span>';
        html += '<span class="deep-cascade-tokens">' + fmtBig(total) + '</span>';
        html += '</div>';
    }
    if (cascades.length > limit) {
        html += '<div class="deep-cascade-more">+' + (cascades.length - limit) + ' more</div>';
    }
    html += '</div>';
    return html;
}

// ═══════════════════════════════════════════
//  Estimated API Cost
// ═══════════════════════════════════════════

/** Per-1M-token pricing — updated April 2026 */
export type PricingEntry = { input: number; output: number; cache: number; reasoning: number };

/** External pricing resolver — injected by extension at boot (e.g. LiteLLM catalog) */
let externalResolver: ((displayName: string) => PricingEntry | null) | null = null;

/** Register an external pricing resolver (e.g. LiteLLM dynamic catalog) */
export function setExternalPricingResolver(resolver: (displayName: string) => PricingEntry | null): void {
    externalResolver = resolver;
}

let pricing: Record<string, PricingEntry> = {
    // Claude family (Anthropic) — reasoning = output rate per Anthropic pricing
    opus:           { input: 5.00,  output: 25.00, cache: 0.50, reasoning: 25.00 },
    sonnet:         { input: 3.00,  output: 15.00, cache: 0.30, reasoning: 15.00 },
    haiku:          { input: 1.00,  output: 5.00,  cache: 0.10, reasoning: 5.00 },
    // Gemini 3.x family
    'gemini-3-pro':   { input: 2.00,  output: 12.00, cache: 0.20, reasoning: 12.00 },
    'gemini-3-flash': { input: 0.50,  output: 3.00,  cache: 0.05, reasoning: 3.00 },
    // Gemini 2.5 family (deprecated June 2026)
    'gemini-2-pro':   { input: 1.25,  output: 10.00, cache: 0.125, reasoning: 10.00 },
    'gemini-2-flash': { input: 0.30,  output: 2.50,  cache: 0.03, reasoning: 2.50 },
    'flash-lite':     { input: 0.10,  output: 0.40,  cache: 0.01, reasoning: 0.40 },
    // Other
    'gpt-oss':      { input: 2.50,  output: 10.00, cache: 0.25, reasoning: 10.00 },
};

/** Override pricing at runtime (called from extension with VS Code settings) */
export function updatePricing(overrides: Record<string, Partial<PricingEntry>>): void {
    for (const [key, val] of Object.entries(overrides)) {
        if (val && typeof val.input === 'number') {
            pricing[key] = {
                input: val.input ?? pricing[key]?.input ?? 3,
                output: val.output ?? pricing[key]?.output ?? 15,
                cache: val.cache ?? pricing[key]?.cache ?? 0.3,
                reasoning: val.reasoning ?? val.output ?? pricing[key]?.reasoning ?? 15,
            };
        }
    }
}

/** Export current pricing for webview injection */
export function getPricing(): Record<string, PricingEntry> {
    return { ...pricing };
}

export function matchPricing(displayName: string): PricingEntry {
    // 1. External resolver (LiteLLM dynamic catalog — highest priority after settings override)
    if (externalResolver) {
        const external = externalResolver(displayName);
        if (external) return external;
    }

    // 2. Hardcoded fallback — keyword-based heuristic matching
    const lower = displayName.toLowerCase();
    // Claude tiers
    if (lower.includes('opus'))   return pricing['opus'];
    if (lower.includes('haiku'))  return pricing['haiku'];
    if (lower.includes('sonnet')) return pricing['sonnet'];
    // Gemini tiers — version-aware (2.5 vs 3.x)
    if (lower.includes('flash lite') || lower.includes('flash-lite'))  return pricing['flash-lite'];
    if (lower.includes('checkpoint'))  return { input: 0, output: 0, cache: 0, reasoning: 0 };
    const is25 = lower.includes('2.5') || lower.includes('2_5');
    if (lower.includes('flash'))  return pricing[is25 ? 'gemini-2-flash' : 'gemini-3-flash'];
    if (lower.includes('pro') || lower.includes('gemini'))
        return pricing[is25 ? 'gemini-2-pro' : 'gemini-3-pro'];
    // GPT
    if (lower.includes('gpt'))    return pricing['gpt-oss'];
    return pricing['sonnet']; // fallback
}

/** Smart dollar format: $0.42 for small, $15 for large */
export function fmtDollar(v: number): string {
    if (v < 0.01) return '$0';
    if (v < 1)    return '$' + v.toFixed(2);
    if (v < 10)   return '$' + v.toFixed(1);
    return '$' + Math.round(v).toLocaleString();
}

/** Calculate total estimated cost from model data */
export function calculateTotalCost(models: ModelBucket[]): number {
    if (!models || models.length === 0) return 0;
    let total = 0;
    for (const m of models) {
        const p = matchPricing(m.displayName);
        total += (m.input / 1e6) * p.input
            + ((m.cache || 0) / 1e6) * p.cache
            + ((m.cacheWrite || 0) / 1e6) * (p.input * 1.25)
            + (m.output / 1e6) * p.output
            + ((m.reasoning || 0) / 1e6) * p.reasoning;
    }
    return total;
}

/**
 * Compact model breakdown — sidebar version.
 * Shows only: model name + single bar + percentage. No in/cache/out detail.
 */
export function renderCompactModelBreakdown(models: ModelBucket[], totalTokens: number): string {
    if (!models || models.length === 0) return '';

    let html = '';
    for (const m of models) {
        const mTotal = m.input + m.output + (m.cache || 0) + (m.cacheWrite || 0) + (m.reasoning || 0);
        const pct = totalTokens > 0 ? (mTotal / totalTokens * 100).toFixed(1) : '0';
        const barPct = totalTokens > 0 ? (mTotal / totalTokens * 100) : 0;

        html += '<div class="deep-model-compact">';
        html += '<div class="deep-model-hdr">';
        html += '<span class="deep-model-name">' + escHtml(m.displayName) + '</span>';
        html += '<span class="deep-model-pct">' + pct + '%</span>';
        html += '</div>';
        html += '<div class="deep-model-bar"><div class="usage-bar-seg usage-c-input" style="width:' + barPct.toFixed(1) + '%"></div></div>';
        html += '<div class="deep-model-detail">';
        html += '<span><span class="usage-dot usage-c-input"></span>' + fmtBig(m.input) + '</span>';
        html += '<span><span class="usage-dot usage-c-cache"></span>' + fmtBig(m.cache || 0) + '</span>';
        html += '<span><span class="usage-dot usage-c-output"></span>' + fmtBig(m.output) + '</span>';
        if ((m.reasoning || 0) > 0) {
            html += '<span><span class="usage-dot usage-c-reasoning"></span>' + fmtBig(m.reasoning) + ' reas.</span>';
        }
        html += '</div>';
        html += '</div>';
    }
    return html;
}

// ═══════════════════════════════════════════
//  Monthly Column Chart (calendar year, filter-independent)
// ═══════════════════════════════════════════

/** Estimate cost for a single month bucket using per-model pricing */
function estimateMonthCost(m: MonthlyBucket): number {
    let totalCost = 0;
    for (const tm of m.topModels) {
        const p = matchPricing(tm.displayName);
        const cost = (tm.inp * p.input + tm.cache * p.cache + tm.out * p.output + tm.reas * p.reasoning) / 1_000_000;
        tm.cost = cost;
        totalCost += cost;
    }
    return totalCost;
}

/** Extract unique years from monthly data (newest first) */
export function getMonthlyYears(monthly: MonthlyBucket[]): number[] {
    if (!monthly || monthly.length === 0) return [new Date().getFullYear()];
    const years = new Set<number>();
    for (const m of monthly) {
        if (m.key.length >= 4) years.add(parseInt(m.key.slice(0, 4), 10));
    }
    return Array.from(years).sort((a, b) => b - a); // newest first
}

export function renderMonthlySummary(monthly: MonthlyBucket[], filterYear?: number): string {
    if (!monthly || monthly.length === 0) return '';

    // Filter to selected year (if provided), otherwise show all
    const MNAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let displayMonths: MonthlyBucket[];

    if (filterYear) {
        // Build full Jan-Dec for the year, filling gaps with empties
        const yearMap = new Map<number, MonthlyBucket>();
        for (const m of monthly) {
            if (m.key.startsWith(String(filterYear))) {
                yearMap.set(parseInt(m.key.slice(5, 7), 10) - 1, m);
            }
        }
        displayMonths = [];
        for (let i = 0; i < 12; i++) {
            displayMonths.push(yearMap.get(i) || {
                key: `${filterYear}-${String(i + 1).padStart(2, '0')}`,
                label: MNAMES[i],
                input: 0, output: 0, cache: 0, cacheWrite: 0, reasoning: 0, calls: 0,
                total: 0, cost: 0, topModels: [],
            });
        }
    } else {
        displayMonths = monthly;
    }

    if (displayMonths.length === 0) return '';

    // Calculate cost for each month
    for (const m of displayMonths) {
        m.cost = estimateMonthCost(m);
    }

    const now = new Date();
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const maxTotal = Math.max(...displayMonths.map(m => m.total), 1);
    const BAR_HEIGHT = 110;

    let html = '<div class="deep-mchart">';

    for (const m of displayMonths) {
        const isCurrent = m.key === currentMonthKey;
        const isEmpty = m.total === 0;
        const totalH = (m.total / maxTotal) * BAR_HEIGHT;
        const inH = m.total > 0 ? (m.input / m.total * totalH) : 0;
        const caH = m.total > 0 ? (m.cache / m.total * totalH) : 0;
        const ouH = m.total > 0 ? (m.output / m.total * totalH) : 0;

        const colCls = 'deep-mcol' + (isCurrent ? ' deep-mcol-current' : '') + (isEmpty ? ' deep-mcol-empty' : '');

        html += '<div class="' + colCls + '">';

        // Custom floating tooltip
        if (!isEmpty) {
            html += '<div class="deep-mcol-tip">';
            html += '<div class="deep-mcol-tip-hdr">' + m.label + (isCurrent ? ' <span class="deep-mcol-tip-badge">current</span>' : '') + '</div>';
            html += '<div class="deep-mcol-tip-row"><span>Tokens</span><span>' + fmtBig(m.total) + '</span></div>';
            html += '<div class="deep-mcol-tip-row"><span>Cost</span><span class="deep-mcol-tip-cost">' + fmtDollar(m.cost) + '</span></div>';
            html += '<div class="deep-mcol-tip-row"><span>Calls</span><span>' + fmtNum(m.calls) + '</span></div>';
            html += '<div class="deep-mcol-tip-sep"></div>';
            html += '<div class="deep-mcol-tip-row"><span class="deep-mcol-tip-dotlabel"><span class="deep-mcol-tip-dot" style="background:#4f9cf7"></span>Input</span><span>' + fmtBig(m.input) + '</span></div>';
            html += '<div class="deep-mcol-tip-row"><span class="deep-mcol-tip-dotlabel"><span class="deep-mcol-tip-dot" style="background:#a78bfa"></span>Cache</span><span>' + fmtBig(m.cache) + '</span></div>';
            html += '<div class="deep-mcol-tip-row"><span class="deep-mcol-tip-dotlabel"><span class="deep-mcol-tip-dot" style="background:#4ade80"></span>Output</span><span>' + fmtBig(m.output) + '</span></div>';
            if (m.reasoning > 0) {
                html += '<div class="deep-mcol-tip-row"><span class="deep-mcol-tip-dotlabel"><span class="deep-mcol-tip-dot" style="background:#f59e0b"></span>Reasoning</span><span>' + fmtBig(m.reasoning) + '</span></div>';
            }
            if (m.topModels.length > 0) {
                html += '<div class="deep-mcol-tip-sep"></div>';
                html += '<div class="deep-mcol-tip-models-hdr">Models</div>';
                for (const tm of m.topModels.slice(0, 5)) {
                    html += '<div class="deep-mcol-tip-model">';
                    html += '<span>' + escHtml(tm.displayName) + '</span>';
                    html += '<span>' + fmtBig(tm.tokens) + ' · ' + fmtDollar(tm.cost) + '</span>';
                    html += '</div>';
                }
            }
            html += '</div>';
        }

        // Value above bar
        if (!isEmpty) {
            html += '<div class="deep-mcol-val">' + fmtDollar(m.cost) + '</div>';
        } else {
            html += '<div class="deep-mcol-val deep-mcol-val-empty">—</div>';
        }
        // Stacked bar
        html += '<div class="deep-mcol-stack" style="height:' + BAR_HEIGHT + 'px">';
        if (!isEmpty) {
            html += '<div class="deep-mcol-seg" style="height:' + ouH.toFixed(1) + 'px;background:#4ade80"></div>';
            html += '<div class="deep-mcol-seg" style="height:' + caH.toFixed(1) + 'px;background:#a78bfa"></div>';
            html += '<div class="deep-mcol-seg" style="height:' + inH.toFixed(1) + 'px;background:#4f9cf7"></div>';
        } else {
            html += '<div class="deep-mcol-seg deep-mcol-ghost" style="height:4px"></div>';
        }
        html += '</div>';
        // Month label
        html += '<div class="deep-mcol-lbl">' + m.label + '</div>';
        // Call count
        if (!isEmpty) {
            html += '<div class="deep-mcol-sub">' + fmtBig(m.total) + '</div>';
        }
        html += '</div>';
    }

    // Legend
    html += '</div>';
    html += '<div class="deep-mchart-legend">';
    html += '<span><span class="usage-dot usage-c-input"></span>Input</span>';
    html += '<span><span class="usage-dot usage-c-cache"></span>Cache</span>';
    html += '<span><span class="usage-dot usage-c-output"></span>Output</span>';
    html += '</div>';
    return html;
}

// ═══════════════════════════════════════════
//  Provider Breakdown
// ═══════════════════════════════════════════

const PROVIDER_COLORS: Record<string, string> = {
    'Claude (Vertex)': '#a78bfa',   // purple for Anthropic
    'Gemini': '#4f9cf7',            // blue for Google
    'OpenAI': '#4ade80',            // green for OpenAI
};

export function renderProviderBreakdown(providers: ProviderBucket[], totalTokens: number): string {
    if (!providers || providers.length === 0) return '<div class="deep-empty">No provider data</div>';

    let html = '<div class="provider-breakdown">';

    // Stacked horizontal bar
    html += '<div class="provider-stack-bar">';
    for (const p of providers) {
        const total = p.input + p.output + p.cache;
        const pct = totalTokens > 0 ? (total / totalTokens * 100) : 0;
        if (pct < 0.5) continue;
        const color = PROVIDER_COLORS[p.displayName] || '#666';
        html += `<div class="provider-stack-seg" style="width:${pct.toFixed(1)}%;background:${color}" title="${escHtml(p.displayName)}: ${pct.toFixed(1)}%"></div>`;
    }
    html += '</div>';

    // Legend rows
    for (const p of providers) {
        const total = p.input + p.output + p.cache;
        const pct = totalTokens > 0 ? (total / totalTokens * 100).toFixed(1) : '0';
        const color = PROVIDER_COLORS[p.displayName] || '#666';
        html += '<div class="provider-row">';
        html += `<span class="provider-dot" style="background:${color}"></span>`;
        html += `<span class="provider-name">${escHtml(p.displayName)}</span>`;
        html += `<span class="provider-pct">${pct}%</span>`;
        html += `<span class="provider-tokens">${fmtBig(total)}</span>`;
        html += `<span class="provider-calls">${fmtNum(p.calls)} calls</span>`;
        html += '</div>';
    }

    html += '</div>';
    return html;
}

// ═══════════════════════════════════════════
//  Day-of-Week Distribution
// ═══════════════════════════════════════════

export function renderWeekdayChart(weekday: WeekdayBucket[]): string {
    if (!weekday || weekday.length === 0) return '<div class="deep-empty">No data</div>';

    const maxCalls = Math.max(...weekday.map(w => w.calls), 1);
    const peakDay = weekday.reduce((a, b) => b.calls > a.calls ? b : a);
    const BAR_H = 80;

    let html = '<div class="weekday-chart">';
    for (const w of weekday) {
        const h = (w.calls / maxCalls) * BAR_H;
        const total = w.input + w.output + w.cache;
        const isPeak = w.day === peakDay.day;
        const cls = 'weekday-col' + (isPeak ? ' weekday-peak' : '');

        html += `<div class="${cls}">`;
        html += `<div class="weekday-val">${fmtNum(w.calls)}</div>`;
        html += `<div class="weekday-bar-wrap" style="height:${BAR_H}px">`;
        html += `<div class="weekday-bar" style="height:${h.toFixed(1)}px"></div>`;
        html += '</div>';
        html += `<div class="weekday-lbl">${w.label}</div>`;
        html += '</div>';
    }
    html += '</div>';

    // Summary line
    const weekdayCalls = weekday.filter(w => w.day < 5).reduce((s, w) => s + w.calls, 0);
    const weekendCalls = weekday.filter(w => w.day >= 5).reduce((s, w) => s + w.calls, 0);
    const total = weekdayCalls + weekendCalls;
    const weekdayPct = total > 0 ? Math.round(weekdayCalls / total * 100) : 0;
    html += `<div class="weekday-summary">Weekday ${weekdayPct}% · Weekend ${100 - weekdayPct}% · Peak: <strong>${peakDay.label}</strong></div>`;

    return html;
}

// ═══════════════════════════════════════════
//  Enriched Cascade List (with cost + mini bar)
// ═══════════════════════════════════════════

/** Render a single cascade row — shared between shown and overflow sections */
function renderCascadeRow(c: CascadeBucket, cpt: number, maxTokens: number, maxTitleLen: number): string {
    const total = c.input + c.output + c.cache;
    const cost = total * cpt;
    const title = c.title || 'Conversation';
    const short = title.length > maxTitleLen ? title.substring(0, maxTitleLen) + '…' : title;
    const barW = (total / maxTokens * 100);
    const inPct = total > 0 ? (c.input / total * barW) : 0;
    const caPct = total > 0 ? (c.cache / total * barW) : 0;
    const ouPct = total > 0 ? (c.output / total * barW) : 0;

    let html = '<div class="cascade-row">';
    html += '<div class="cascade-header">';
    html += `<span class="cascade-title">${escHtml(short)}</span>`;
    html += `<span class="cascade-cost">${fmtDollar(cost)}</span>`;
    html += '</div>';
    html += '<div class="cascade-meta">';
    html += '<div class="cascade-bar">';
    if (inPct > 0) html += `<div class="usage-bar-seg usage-c-input" style="width:${inPct.toFixed(1)}%"></div>`;
    if (caPct > 0) html += `<div class="usage-bar-seg usage-c-cache" style="width:${caPct.toFixed(1)}%"></div>`;
    if (ouPct > 0) html += `<div class="usage-bar-seg usage-c-output" style="width:${ouPct.toFixed(1)}%"></div>`;
    html += '</div>';
    html += `<span class="cascade-stats">${fmtBig(total)} · ${fmtNum(c.calls)} calls</span>`;
    html += '</div>';
    html += '</div>';
    return html;
}

export function renderEnrichedCascadeList(cascades: CascadeBucket[], models: ModelBucket[], limit: number = CASCADE_ENRICHED_LIMIT, maxTitleLen: number = CASCADE_ENRICHED_TITLE_MAX_LEN): string {
    const shown = cascades.slice(0, limit);
    if (shown.length === 0) return '<div class="deep-empty">No conversations</div>';

    // Compute average cost-per-token from model data for estimation
    const totalCost = calculateTotalCost(models);
    const totalT = models.reduce((s, m) => s + m.input + m.output + m.cache, 0);
    const cpt = totalT > 0 ? totalCost / totalT : 0;

    const maxTokens = Math.max(...shown.map(c => c.input + c.output + c.cache), 1);

    let html = '<div class="cascade-enriched">';
    for (const c of shown) html += renderCascadeRow(c, cpt, maxTokens, maxTitleLen);

    // Render overflow items (hidden by default)
    if (cascades.length > limit) {
        const overflow = cascades.slice(limit);
        html += '<div class="cascade-overflow" style="display:none">';
        for (const c of overflow) html += renderCascadeRow(c, cpt, maxTokens, maxTitleLen);
        html += '</div>';
        html += `<button class="cascade-more-btn" data-cascade-toggle="true" data-overflow-count="${overflow.length}">+${overflow.length} more</button>`;
    }
    html += '</div>';
    return html;
}


export function renderCostEstimate(models: ModelBucket[]): string {
    if (!models || models.length === 0) return '<div class="deep-empty">No model data</div>';

    let html = '<div class="deep-cost-table">';
    html += '<div class="deep-cost-row deep-cost-header">';
    html += '<span class="deep-cost-model">Model</span>';
    html += '<span class="deep-cost-val">Input</span>';
    html += '<span class="deep-cost-val">Cache</span>';
    html += '<span class="deep-cost-val">Output</span>';
    html += '<span class="deep-cost-val">Reas.</span>';
    html += '<span class="deep-cost-val deep-cost-total">Total</span>';
    html += '</div>';

    let grandTotal = 0;

    for (const m of models) {
        const p = matchPricing(m.displayName);
        const inputCost    = (m.input / 1e6) * p.input;
        const cacheCost    = ((m.cache || 0) / 1e6) * p.cache;
        const outputCost   = (m.output / 1e6) * p.output;
        const reasonCost   = ((m.reasoning || 0) / 1e6) * p.reasoning;
        const rowTotal     = inputCost + cacheCost + outputCost + reasonCost;
        grandTotal += rowTotal;

        if (rowTotal < 0.01) continue;

        html += '<div class="deep-cost-row">';
        html += '<span class="deep-cost-model">' + escHtml(m.displayName) + '</span>';
        html += '<span class="deep-cost-val">' + fmtDollar(inputCost) + '</span>';
        html += '<span class="deep-cost-val">' + fmtDollar(cacheCost) + '</span>';
        html += '<span class="deep-cost-val">' + fmtDollar(outputCost) + '</span>';
        html += '<span class="deep-cost-val">' + fmtDollar(reasonCost) + '</span>';
        html += '<span class="deep-cost-val deep-cost-total">' + fmtDollar(rowTotal) + '</span>';
        html += '</div>';
    }

    html += '<div class="deep-cost-row deep-cost-grand">';
    html += '<span class="deep-cost-model">TOTAL</span>';
    html += '<span class="deep-cost-val"></span><span class="deep-cost-val"></span><span class="deep-cost-val"></span><span class="deep-cost-val"></span>';
    html += '<span class="deep-cost-val deep-cost-total">' + fmtDollar(grandTotal) + '</span>';
    html += '</div></div>';
    html += '<div class="deep-cost-note">Based on current API pricing. Reasoning priced per model (may differ from output rate).</div>';
    return html;
}

// ═══════════════════════════════════════════
//  Range Bar
// ═══════════════════════════════════════════

const RANGES = [
    { id: '24h', label: '24h' },
    { id: '7d', label: '7d' },
    { id: '30d', label: '30d' },
    { id: 'all', label: 'All Time' },
] as const;

export function renderRangeBar(activeRange: string, cssPrefix: string = 'deep'): string {
    let html = `<div class="${cssPrefix}-range-bar" id="usageRangeBar">`;
    for (const r of RANGES) {
        const active = activeRange === r.id ? ' active' : '';
        html += `<button class="${cssPrefix}-range-btn${active}" data-action="set-usage-range" data-range="${r.id}">${r.label}</button>`;
    }
    html += '</div>';
    return html;
}

export function rangeLabel(state: string): string {
    switch (state) {
        case '24h':        return 'Last 24h';
        case '7d':         return 'Last 7 Days';
        case '30d':        return 'Last 30 Days';
        case 'today':      return 'Today';
        case 'this-week':  return 'This Week';
        case 'this-month': return 'This Month';
        case 'last-month': return 'Last Month';
        default:           return 'All Time';
    }
}
