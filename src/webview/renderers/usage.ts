/**
 * Usage Stats tab renderer — Sidebar compact view.
 * Shows: Compact KPI → Range selector → GitHub heatmap → Top model → Dashboard button
 * Heavy sections (daily bars, cost, conversations) live in the detail panel only.
 */

import { fmtBig, fmtNum, fmtShortDate, escHtml } from '../../shared/helpers';
import {
    kpiCard, renderDailyGrid, renderHourlyHeatmap, renderCompactModelBreakdown,
    renderRangeBar, rangeLabel, calculateTotalCost, fmtDollar, renderMonthlySummary,
    getMonthlyYears,
} from '../../shared/usage-components';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderUsageStats(stats: any): void {
    const el = document.getElementById('usageContent');
    if (!el) return;

    const hasMonthly = stats?.monthly && stats.monthly.some((m: any) => m.total > 0);
    if (!stats || (stats.totalCalls === 0 && (!stats.daily || stats.daily.length === 0) && !hasMonthly)) {
        el.innerHTML = renderShimmerSkeleton();
        return;
    }

    const isDeep = Boolean((stats.daily && stats.daily.length > 0) || hasMonthly);

    if (isDeep) {
        renderCompactDashboard(el, stats);
    } else {
        renderLegacyStats(el, stats);
    }
}

/** Shimmer skeleton — shown while data is loading */
function renderShimmerSkeleton(): string {
    let html = '<div class="usage-shimmer">';
    html += '<div class="shimmer-kpi-row">';
    for (let i = 0; i < 4; i++) {
        html += '<div class="shimmer-kpi"><div class="shimmer-line shimmer-val"></div><div class="shimmer-line shimmer-label"></div></div>';
    }
    html += '</div>';
    html += '<div class="shimmer-range"><div class="shimmer-line" style="width:200px;height:28px;margin:0 auto"></div></div>';
    for (let i = 0; i < 3; i++) {
        const w = 90 - i * 25;
        html += `<div class="shimmer-bar-row"><div class="shimmer-line" style="width:50px;height:12px"></div><div class="shimmer-line" style="width:${w}%;height:14px;flex:1"></div></div>`;
    }
    html += '<div class="shimmer-status">Scanning conversations…</div>';
    html += '</div>';
    return html;
}

// ═══════════════════════════════════════════
//  Compact Sidebar Dashboard
// ═══════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderCompactDashboard(el: HTMLElement, stats: any): void {
    const state = (window as any).__usageRange || '24h';

    // Preserve the range bar — only re-render KPI + data portions
    let rangeBarEl = el.querySelector('.deep-range-bar') as HTMLElement | null;
    let kpiEl = el.querySelector('.deep-kpi-wrap') as HTMLElement | null;
    let dataEl = el.querySelector('.deep-data-wrap') as HTMLElement | null;

    if (!rangeBarEl || !dataEl || !kpiEl) {
        // First render: KPI wrapper → range bar → data wrapper
        el.innerHTML = ''
            + '<div class="deep-kpi-wrap"></div>'
            + renderRangeBar(state, 'deep')
            + '<div class="deep-data-wrap"></div>';
        kpiEl = el.querySelector('.deep-kpi-wrap');
        rangeBarEl = el.querySelector('.deep-range-bar');
        dataEl = el.querySelector('.deep-data-wrap');
    }

    // Update active state on range buttons without replacing DOM
    rangeBarEl?.querySelectorAll('.deep-range-btn').forEach(b => {
        b.classList.toggle('active', (b as HTMLElement).dataset.range === state);
    });

    // ─── KPI Section: Hero + Breakdown ───
    const totalCost = calculateTotalCost(stats.models);
    const totalReas = stats.totalReasoning || 0;
    const totalCW = stats.totalCacheWrite || 0;

    let kpiHtml = '<div class="deep-kpi-hero">';
    kpiHtml += '<div class="deep-hero-metric">';
    kpiHtml += '<div class="deep-hero-val">' + fmtBig(stats.totalTokens) + '</div>';
    kpiHtml += '<div class="deep-hero-label">Total Tokens</div>';
    kpiHtml += '</div>';
    kpiHtml += '<div class="deep-hero-metric deep-hero-cost">';
    kpiHtml += '<div class="deep-hero-val">' + fmtDollar(totalCost) + '</div>';
    kpiHtml += '<div class="deep-hero-label">Est. Cost</div>';
    kpiHtml += '</div>';
    kpiHtml += '</div>';

    // Token breakdown chips
    kpiHtml += '<div class="deep-token-chips">';
    kpiHtml += '<span class="deep-chip"><span class="deep-chip-dot" style="background:#4f9cf7"></span>' + fmtBig(stats.totalInput) + ' <em>in</em></span>';
    kpiHtml += '<span class="deep-chip"><span class="deep-chip-dot" style="background:#a78bfa"></span>' + fmtBig(stats.totalCache) + ' <em>cache</em></span>';
    kpiHtml += '<span class="deep-chip"><span class="deep-chip-dot" style="background:#4ade80"></span>' + fmtBig(stats.totalOutput) + ' <em>out</em></span>';
    if (totalReas > 0) {
        kpiHtml += '<span class="deep-chip"><span class="deep-chip-dot" style="background:#f59e0b"></span>' + fmtBig(totalReas) + ' <em>reas.</em></span>';
    }
    kpiHtml += '<span class="deep-chip deep-chip-muted">' + fmtNum(stats.totalCalls) + ' <em>calls</em></span>';
    kpiHtml += '</div>';

    if (stats.dateRange?.from) {
        kpiHtml += '<div class="deep-date-range">'
            + fmtShortDate(stats.dateRange.from) + ' → ' + fmtShortDate(stats.dateRange.to)
            + '</div>';
    }
    kpiEl!.innerHTML = kpiHtml;

    // ─── Dynamic Data (below range bar) ───
    let html = '';

    // ─── Activity Heatmap ───
    html += '<div class="deep-section">';
    if (state === '24h') {
        html += '<div class="deep-section-hdr">Activity Pattern <span class="deep-section-badge">Hourly</span></div>';
        html += renderHourlyHeatmap(stats.hourly);
    } else {
        html += '<div class="deep-section-hdr">Activity <span class="deep-section-badge">' + rangeLabel(state) + '</span></div>';
        html += renderDailyGrid(stats.daily, false);
    }
    html += '</div>';

    // ─── Model Breakdown ───
    if (stats.models && stats.models.length > 0) {
        html += '<div class="deep-section">';
        html += '<div class="deep-section-hdr">Top Models</div>';
        html += renderCompactModelBreakdown(stats.models, stats.totalTokens);
        html += '</div>';
    }

    // ─── Monthly Summary (filter-independent, always shows) ───
    if (stats.monthly) {
        const years = getMonthlyYears(stats.monthly);
        const latestYear = years[0];
        const monthlyHtml = renderMonthlySummary(stats.monthly, latestYear);
        if (monthlyHtml) {
            html += '<div class="deep-section">';
            html += '<div class="deep-section-hdr">Monthly Breakdown <span class="deep-section-badge">' + latestYear + '</span></div>';
            html += monthlyHtml;
            html += '</div>';
        }
    }

    // ─── Open Full Dashboard Button ───
    html += '<button class="deep-open-btn" data-action="open-usage-panel">'
        + 'Open Full Dashboard →'
        + '</button>';

    // Preserve scroll position across rerenders
    const scrollParent = el.closest('.tab-content') || el.parentElement;
    const prevScroll = scrollParent?.scrollTop ?? 0;

    dataEl!.innerHTML = html;

    // Restore scroll position after DOM update
    if (scrollParent && prevScroll > 0) {
        requestAnimationFrame(() => { scrollParent.scrollTop = prevScroll; });
    }
}

// ─── Legacy renderer (fallback) ───

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderLegacyStats(el: HTMLElement, stats: any): void {
    const totalAll = stats.totalInput + stats.totalOutput + stats.totalCache;
    let html = '<div class="usage-summary">';
    html += '<div class="usage-total"><div class="usage-total-num">' + fmtNum(totalAll) + '</div><div class="usage-total-label">Total Tokens</div></div>';
    html += '<div class="usage-breakdown">';
    html += renderMiniStat('Input', stats.totalInput, totalAll, 'usage-c-input');
    html += renderMiniStat('Output', stats.totalOutput, totalAll, 'usage-c-output');
    html += renderMiniStat('Cache', stats.totalCache, totalAll, 'usage-c-cache');
    html += '</div>';
    html += '<div class="usage-calls"><span class="usage-calls-num">' + fmtNum(stats.totalCalls) + '</span><span class="usage-calls-label"> API calls</span></div>';
    html += '</div>';
    el.innerHTML = html;
}

function renderMiniStat(label: string, value: number, total: number, colorClass: string): string {
    const pct = total > 0 ? (value / total * 100).toFixed(1) : '0';
    return '<div class="usage-mini-stat">'
        + '<div class="usage-mini-hdr"><span class="usage-mini-label">' + label + '</span><span class="usage-mini-val">' + fmtNum(value) + '</span></div>'
        + '<div class="usage-mini-bar"><div class="usage-mini-fill ' + colorClass + '" style="width:' + pct + '%"></div></div>'
        + '</div>';
}

// ═══════════════════════════════════════════
//  Context Window Widget
// ═══════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderContextWindow(data: any): void {
    const el = document.getElementById('contextWindowContent') as HTMLElement;
    if (!el || !data) { if (el) el.innerHTML = ''; return; }

    const pct = data.percentage || 0;
    const colorClass = pct >= 80 ? 'ctx-danger' : pct >= 50 ? 'ctx-warn' : 'ctx-ok';

    // SVG donut params
    const radius = 30;
    const stroke = 5;
    const circumference = 2 * Math.PI * radius;
    const dashOffset = circumference * (1 - pct / 100);
    const gradientColor = pct >= 80 ? '#ef4444' : pct >= 50 ? '#f59e0b' : '#4ade80';
    const gradientEnd = pct >= 80 ? '#f87171' : pct >= 50 ? '#fbbf24' : '#22c55e';

    let html = '<div class="ctx-card">';

    // Header: title + model badge (original style)
    html += '<div class="ctx-header">';
    html += '<span class="ctx-title">Active Context</span>';
    html += `<span class="ctx-model-badge">${escHtml(data.model)}</span>`;
    html += '</div>';

    // ─── Donut + Stats ───
    html += '<div class="ctx-donut-row">';

    // Donut SVG — percentage only in center
    html += '<div class="ctx-donut-wrap">';
    html += `<svg class="ctx-donut-svg" viewBox="0 0 ${(radius + stroke) * 2} ${(radius + stroke) * 2}">`;
    html += `<defs><linearGradient id="ctxGrad" x1="0%" y1="0%" x2="100%" y2="100%">`;
    html += `<stop offset="0%" stop-color="${gradientEnd}"/>`;
    html += `<stop offset="100%" stop-color="${gradientColor}"/>`;
    html += `</linearGradient></defs>`;
    html += `<circle cx="${radius + stroke}" cy="${radius + stroke}" r="${radius}" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="${stroke}"/>`;
    html += `<circle class="ctx-donut-fill" cx="${radius + stroke}" cy="${radius + stroke}" r="${radius}" fill="none" stroke="url(#ctxGrad)" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${dashOffset}" transform="rotate(-90 ${radius + stroke} ${radius + stroke})"/>`;
    html += '</svg>';
    html += `<span class="ctx-donut-pct ${colorClass}">${pct}%</span>`;
    html += '</div>';

    // Token stats (right of donut) — title on top
    html += '<div class="ctx-donut-info">';
    if (data.title) {
        html += `<div class="ctx-convo-title" title="${escHtml(data.title)}">${escHtml(data.title)}</div>`;
    }
    html += `<div class="ctx-token-line">${fmtBig(data.usedTokens)} <span class="ctx-token-sep">/</span> ${fmtBig(data.maxTokens)}</div>`;
    html += `<div class="ctx-token-label">tokens used</div>`;
    html += '</div>';

    html += '</div>'; // ctx-donut-row

    // Category breakdown
    const cats = data.categories || [];
    if (cats.length > 0) {
        html += '<div class="ctx-categories">';

        // Stacked bar showing category proportions
        html += '<div class="ctx-stacked-bar">';
        for (const cat of cats) {
            if (cat.percentage < 1) continue;
            const segTooltip = `${cat.icon} ${cat.name}\n${fmtBig(cat.tokens)} tokens (${cat.percentage}%)\n${cat.count} ${cat.count === 1 ? 'entry' : 'entries'}`;
            html += '<div class="ctx-stacked-seg" style="width:' + cat.percentage + '%;background:' + cat.color + '" title="' + escHtml(segTooltip) + '"></div>';
        }
        html += '</div>';

        // Category list
        html += '<div class="ctx-cat-list">';
        for (const cat of cats) {
            if (cat.tokens < 100) continue;
            const itemTooltip = `${cat.icon} ${cat.name}\n${fmtNum(cat.tokens)} tokens (${cat.percentage}% of context)\n${cat.count} ${cat.count === 1 ? 'step' : 'steps'}`;
            html += '<div class="ctx-cat-item" title="' + escHtml(itemTooltip) + '">';
            html += '<span class="ctx-cat-dot" style="background:' + cat.color + '"></span>';
            html += '<span class="ctx-cat-name">' + cat.icon + ' ' + escHtml(cat.name) + '</span>';
            html += '<span class="ctx-cat-count">' + cat.count + '</span>';
            html += '<span class="ctx-cat-val">' + fmtBig(cat.tokens) + '</span>';
            html += '<span class="ctx-cat-pct">' + cat.percentage + '%</span>';
            html += '</div>';
        }
        html += '</div>';
    }

    // Completion config chips
    const cfg = data.completionConfig;
    if (cfg && cfg.maxOutputTokens > 0) {
        html += '<div class="ctx-config">';
        html += '<span class="ctx-cfg-chip">Max Out: ' + fmtBig(cfg.maxOutputTokens) + '</span>';
        html += '<span class="ctx-cfg-chip">Temp: ' + cfg.temperature + '</span>';
        if (cfg.topK > 0) html += '<span class="ctx-cfg-chip">TopK: ' + cfg.topK + '</span>';
        html += '<span class="ctx-cfg-chip">TopP: ' + cfg.topP + '</span>';
        html += '</div>';
    }

    html += '</div>';
    el.innerHTML = html;
}
