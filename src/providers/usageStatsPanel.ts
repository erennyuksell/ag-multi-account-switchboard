/**
 * UsageStatsPanel — Full-width editor tab for deep analytics dashboard.
 * Opens as a WebviewPanel (editor tab) with time-range filtering.
 * Uses shared components from usage-components.ts for DRY rendering.
 *
 * CSS lives in panel.css (SSOT). Formatting via shared/helpers.ts (DRY).
 */

import * as vscode from 'vscode';
import { DeepUsageStats } from '../types';
import { createLogger } from '../utils/logger';
import { fmtBig, fmtNum, fmtShortDate, escHtml, getNonce } from '../shared/helpers';
import {
    renderDailyGrid, renderHourlyHeatmap,
    renderModelBreakdown, renderCostEstimate,
    rangeLabel, calculateTotalCost, fmtDollar, renderMonthlySummary,
    getAvailableYears, renderYearSelector, getMonthlyYears,
    renderWeekdayChart, renderEnrichedCascadeList,
} from '../shared/usage-components';

const log = createLogger('UsagePanel');

export class UsageStatsPanel {
    public static currentPanel: UsageStatsPanel | undefined;
    private static readonly viewType = 'ag.usageStatsPanel';

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];
    private lastStats: DeepUsageStats | null = null;
    private currentRange: string = 'all';
    private currentGridYear: number = new Date().getFullYear();
    private currentMonthlyYear: number = new Date().getFullYear();

    /** Callback for range filter requests — set by the command registration */
    public onRangeFilter?: (range: string) => DeepUsageStats | null;

    // ─── Lifecycle ───

    public static createOrShow(extensionUri: vscode.Uri, stats: DeepUsageStats | null) {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

        if (UsageStatsPanel.currentPanel) {
            UsageStatsPanel.currentPanel.panel.reveal(column);
            if (stats) UsageStatsPanel.currentPanel.updateStats(stats);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            UsageStatsPanel.viewType, 'Usage Statistics', column,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] },
        );

        UsageStatsPanel.currentPanel = new UsageStatsPanel(panel, extensionUri, stats);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, stats: DeepUsageStats | null) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.lastStats = stats;
        this.panel.webview.html = this.buildHtml(stats);

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(msg => {
            if (msg.type === 'log') log.info(`[Panel] ${msg.msg}`);
            if (msg.type === 'setRange' && this.onRangeFilter) {
                this.currentRange = msg.range;
                const filtered = this.onRangeFilter(msg.range);
                if (filtered) this.updateStats(filtered);
            }
            if (msg.type === 'setGridYear') {
                this.currentGridYear = parseInt(msg.year, 10) || new Date().getFullYear();
                if (this.lastStats) this.updateStats(this.lastStats);
            }
            if (msg.type === 'setMonthlyYear') {
                this.currentMonthlyYear = parseInt(msg.year, 10) || new Date().getFullYear();
                if (this.lastStats) this.updateStats(this.lastStats);
            }
        }, null, this.disposables);
    }

    public updateStats(stats: DeepUsageStats) {
        this.lastStats = stats;
        const html = this.renderDashboard(stats);
        this.panel.webview.postMessage({ type: 'statsUpdate', html, range: this.currentRange });
    }

    public updateLatestStats(stats: DeepUsageStats) {
        if (this.currentRange === 'all') {
            this.updateStats(stats);
            return;
        }
        const filtered = this.onRangeFilter?.(this.currentRange);
        this.updateStats(filtered || stats);
    }

    public dispose() {
        UsageStatsPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) this.disposables.pop()?.dispose();
    }

    // ─── HTML Shell ───

    private buildHtml(stats: DeepUsageStats | null): string {
        const nonce = getNonce();
        const cssUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'out', 'webview', 'panel.css'),
        );

        // Pre-render initial content
        const initialContent = stats ? this.renderDashboard(stats) : this.renderLoading();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${this.panel.webview.cspSource} 'unsafe-inline';
                   script-src 'nonce-${nonce}';">
    <link href="${cssUri}" rel="stylesheet">
</head>
<body class="usage-panel-body">
    <div class="up-container">
        <div class="up-header">
            <div class="up-title">Token Usage Statistics</div>
            <div class="up-subtitle">Deep analytics across all conversations</div>
        </div>
        <div id="up-content">${initialContent}</div>
    </div>
    <script nonce="${nonce}">
    (function() {
        const vscode = acquireVsCodeApi();

        // Range button clicks
        document.addEventListener('click', function(e) {
            const rangeBtn = e.target.closest('.up-range-btn');
            if (rangeBtn) {
                document.querySelectorAll('.up-range-btn').forEach(b => b.classList.remove('active'));
                rangeBtn.classList.add('active');
                vscode.postMessage({ type: 'setRange', range: rangeBtn.dataset.range });
                return;
            }
            const yearBtn = e.target.closest('.gh-year-btn');
            if (yearBtn) {
                document.querySelectorAll('.gh-year-btn').forEach(b => b.classList.remove('active'));
                yearBtn.classList.add('active');
                vscode.postMessage({ type: 'setGridYear', year: yearBtn.dataset.year });
                return;
            }
            const monthlyYearBtn = e.target.closest('.monthly-year-btn');
            if (monthlyYearBtn) {
                document.querySelectorAll('.monthly-year-btn').forEach(b => b.classList.remove('active'));
                monthlyYearBtn.classList.add('active');
                vscode.postMessage({ type: 'setMonthlyYear', year: monthlyYearBtn.dataset.year });
                return;
            }
            const cascadeToggle = e.target.closest('.cascade-more-btn');
            if (cascadeToggle) {
                const overflow = cascadeToggle.previousElementSibling;
                if (overflow && overflow.classList.contains('cascade-overflow')) {
                    const hidden = overflow.style.display === 'none';
                    overflow.style.display = hidden ? '' : 'none';
                    cascadeToggle.textContent = hidden ? 'Show less' : '+' + cascadeToggle.dataset.overflowCount + ' more';
                }
                return;
            }
        });

        // Receive stats update — patch DOM instead of full rebuild
        window.addEventListener('message', function(e) {
            const msg = e.data;
            if (msg.type !== 'statsUpdate') return;

            // Update range bar active state
            const rangeBar = document.querySelector('.up-range-bar');
            if (rangeBar) {
                rangeBar.querySelectorAll('.up-range-btn').forEach(function(b) {
                    b.classList.toggle('active', b.dataset.range === msg.range);
                });
            }

            // Patch content
            const container = document.getElementById('up-content');
            if (container && msg.html) {
                container.innerHTML = msg.html;
            }
        });
    })();
    </script>
</body>
</html>`;
    }

    // ─── Loading State ───

    private renderLoading(): string {
        return `<div class="up-loading">
            <div class="up-loading-spinner"></div>
            <div class="up-loading-text">Loading usage stats…</div>
            <div class="up-loading-sub">First load may take up to 30 seconds while scanning all conversations.</div>
        </div>`;
    }

    // ─── Dashboard ───

    private renderDashboard(s: DeepUsageStats): string {
        const range = this.currentRange;
        const rl = rangeLabel(range);

        return [
            this.renderHeroKpi(s),
            this.renderRangeBar(),
            // ── Bento Grid ──
            '<div class="up-bento">',
                // Full-width: Model Distribution
                this.renderModelsCard(s),
                // Full-width: Activity Heatmap
                this.renderHeatmapCard(s),
                // Full-width: Weekly Pattern
                this.renderWeekdayCard(s),
                // Full-width: Monthly Breakdown
                this.renderMonthlyCard(s),
                // Full-width: Cost Estimation
                this.renderCostCard(s, rl),
                // Full-width: Conversations (enriched)
                this.renderConversationsCard(s),
            '</div>',
        ].join('');
    }

    // ─── Hero KPI (Cost + Tokens prominent, rest as chips) ───

    private renderHeroKpi(s: DeepUsageStats): string {
        const totalCost = calculateTotalCost(s.models);
        const totalReas = s.totalReasoning || 0;

        let html = '<div class="up-hero-section">';

        // Hero pair: Cost + Tokens
        html += '<div class="up-hero-pair">';
        html += '<div class="up-hero-card up-hero-cost">';
        html += `<div class="up-hero-val">${fmtDollar(totalCost)}</div>`;
        html += '<div class="up-hero-label">Estimated Cost</div>';
        html += '</div>';
        html += '<div class="up-hero-card up-hero-tokens">';
        html += `<div class="up-hero-val">${fmtBig(s.totalTokens)}</div>`;
        html += '<div class="up-hero-label">Total Tokens</div>';
        html += '</div>';
        html += '</div>';

        // Secondary chips
        html += '<div class="up-hero-chips">';
        html += `<span class="up-chip"><span class="up-chip-dot" style="background:#4f9cf7"></span>${fmtBig(s.totalInput)} <em>in</em></span>`;
        html += `<span class="up-chip"><span class="up-chip-dot" style="background:#a78bfa"></span>${fmtBig(s.totalCache)} <em>cache</em></span>`;
        html += `<span class="up-chip"><span class="up-chip-dot" style="background:#4ade80"></span>${fmtBig(s.totalOutput)} <em>out</em></span>`;
        if (totalReas > 0) {
            html += `<span class="up-chip"><span class="up-chip-dot" style="background:#f59e0b"></span>${fmtBig(totalReas)} <em>reas.</em></span>`;
        }
        html += `<span class="up-chip up-chip-muted">${fmtNum(s.totalCalls)} <em>calls</em></span>`;
        html += `<span class="up-chip up-chip-muted">${s.daysActive}d <em>active</em></span>`;
        html += `<span class="up-chip up-chip-muted">${s.cacheRate}% <em>cache rate</em></span>`;
        html += '</div>';

        // Date range
        if (s.dateRange?.from) {
            html += `<div class="up-hero-daterange">${fmtShortDate(s.dateRange.from)} → ${fmtShortDate(s.dateRange.to)}</div>`;
        }

        html += '</div>';
        return html;
    }

    private renderRangeBar(): string {
        const rolling = [
            { id: '24h', label: '24h' },
            { id: '7d', label: '7d' },
            { id: '30d', label: '30d' },
        ];
        const calendar = [
            { id: 'today', label: 'Today' },
            { id: 'this-week', label: 'Week' },
            { id: 'this-month', label: 'Month' },
        ];
        const all = [{ id: 'all', label: 'All Time' }];

        const renderBtns = (items: {id: string; label: string}[]) => items.map(r => {
            const active = r.id === this.currentRange ? ' active' : '';
            return `<button class="up-range-btn${active}" data-range="${r.id}">${r.label}</button>`;
        }).join('');

        return '<div class="up-range-bar">'
            + renderBtns(rolling)
            + '<span class="up-range-sep">│</span>'
            + renderBtns(calendar)
            + '<span class="up-range-sep">│</span>'
            + renderBtns(all)
            + '</div>';
    }



    // ─── GitHub Contribution Heatmap Card (shared) ───

    private renderHeatmapCard(s: DeepUsageStats): string {
        const totalCost = calculateTotalCost(s.models);
        const costPerToken = s.totalTokens > 0 ? totalCost / s.totalTokens : 0;

        let html = '<div class="up-card up-bento-full">';
        html += '<div class="up-card-hdr">Activity <span class="up-badge">Contribution</span></div>';
        if (!s.daily || s.daily.length === 0) {
            html += '<div class="up-empty">No data</div>';
        } else {
            const years = getAvailableYears(s.daily);
            html += renderYearSelector(years, this.currentGridYear);
            html += renderDailyGrid(s.daily, true, this.currentGridYear, costPerToken);
        }
        html += '</div>';
        return html;
    }



    // ─── Weekday Distribution Card (HALF-WIDTH) ───

    private renderWeekdayCard(s: DeepUsageStats): string {
        let html = '<div class="up-card up-bento-full">';
        html += '<div class="up-card-hdr">Weekly Pattern <span class="up-badge">Day of Week</span></div>';
        if (!s.weekday || s.weekday.length === 0) {
            html += '<div class="up-empty">No data</div>';
        } else {
            html += renderWeekdayChart(s.weekday);
        }
        html += '</div>';
        return html;
    }

    // ─── Model Distribution Card (shared) ───

    private renderModelsCard(s: DeepUsageStats): string {
        let html = '<div class="up-card up-bento-full">';
        html += '<div class="up-card-hdr">Model Distribution</div>';
        if (!s.models || s.models.length === 0) {
            html += '<div class="up-empty">No data</div>';
        } else {
            html += renderModelBreakdown(s.models, s.totalTokens);
        }
        html += '</div>';
        return html;
    }

    // ─── Monthly Breakdown Card ───

    private renderMonthlyCard(s: DeepUsageStats): string {
        if (!s.monthly || s.monthly.length === 0) return '';

        const years = getMonthlyYears(s.monthly);
        const activeYear = years.includes(this.currentMonthlyYear) ? this.currentMonthlyYear : years[0];
        const monthlyHtml = renderMonthlySummary(s.monthly, activeYear);
        if (!monthlyHtml) return '';

        // Year selector for monthly chart
        let yearBar = '';
        if (years.length > 1) {
            yearBar = '<div class="monthly-year-bar">';
            for (const y of years) {
                const active = y === activeYear ? ' active' : '';
                yearBar += `<button class="monthly-year-btn${active}" data-year="${y}">${y}</button>`;
            }
            yearBar += '</div>';
        }

        let html = '<div class="up-card up-bento-full">';
        html += '<div class="up-card-hdr">Monthly Breakdown <span class="up-badge">' + activeYear + '</span></div>';
        html += yearBar;
        html += monthlyHtml;
        html += '</div>';
        return html;
    }

    // ─── Cost Estimation Card (full-width) ───

    private renderCostCard(s: DeepUsageStats, rl: string): string {
        let html = '<div class="up-card up-bento-full">';
        html += '<div class="up-card-hdr">Estimated API Cost <span class="up-badge">' + escHtml(rl) + '</span></div>';
        html += renderCostEstimate(s.models);
        html += '</div>';
        return html;
    }

    // ─── Top Conversations Card (enriched) ───

    private renderConversationsCard(s: DeepUsageStats): string {
        let html = '<div class="up-card up-bento-full">';
        html += `<div class="up-card-hdr">Top Conversations <span class="up-badge">${s.cascades.length}</span></div>`;
        html += renderEnrichedCascadeList(s.cascades, s.models, 30, 60);
        html += '</div>';
        return html;
    }
}
