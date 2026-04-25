/**
 * StatusBarService — manages the VS Code status bar item for quota display.
 * Includes context window percentage inline with the active model.
 */

import * as vscode from 'vscode';
import { ClientModelConfig, LocalQuotaData } from '../types';

export class StatusBarService {
    private readonly statusBarItem: vscode.StatusBarItem;

    // Cached state for re-rendering when either quota or context changes
    private lastQuotaData: LocalQuotaData | null = null;
    private lastSelectedIds: string[] = [];
    private ctxUsed = 0;
    private ctxMax = 0;
    private ctxModel = '';
    private ctxHideTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(context: vscode.ExtensionContext) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = 'ag.refreshQuota';
        this.statusBarItem.text = '$(pulse) Antigravity Quota: Loading...';
        this.statusBarItem.show();
        context.subscriptions.push(this.statusBarItem);
    }

    /** Set error state on status bar */
    setError(text: string, tooltip?: string): void {
        this.statusBarItem.text = text;
        if (tooltip) this.statusBarItem.tooltip = tooltip;
    }

    /** Update status bar from quota data */
    update(data: LocalQuotaData, selectedIds: string[]): void {
        this.lastQuotaData = data;
        this.lastSelectedIds = selectedIds;
        this._render();
    }

    /** Update context window info (shown inline with quota) */
    updateContext(usedTokens: number, maxTokens: number, model: string): void {
        this.ctxUsed = usedTokens;
        this.ctxMax = maxTokens;
        this.ctxModel = model;
        this._render();

        // Auto-hide context after 5min idle
        if (this.ctxHideTimer) clearTimeout(this.ctxHideTimer);
        this.ctxHideTimer = setTimeout(() => {
            this.ctxUsed = 0;
            this.ctxMax = 0;
            this._render();
        }, 5 * 60_000);
    }

    // ── Internal render ──

    private _render(): void {
        const data = this.lastQuotaData;
        const selectedIds = this.lastSelectedIds;

        const rawModels = data?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
        if (!rawModels || rawModels.length === 0) return;

        const sorted = [...rawModels].sort((a, b) => (a.label || '').localeCompare(b.label || ''));
        const selected = sorted.filter(m => selectedIds.includes(m.modelOrAlias?.model || ''));

        // ── Status bar text ──
        if (selected.length === 0) {
            this.statusBarItem.text = '$(pulse) Quota: No Model Selected';
        } else {
            const parts = selected.map(m => {
                const pct = getQuotaPercent(m);
                return `${quotaIcon(pct)} ${m.label}: ${pct === null ? 'N/A' : pct.toFixed(0) + '%'}`;
            });

            // Append context window percentage if active
            if (this.ctxMax > 0 && this.ctxUsed > 0) {
                const ctxPct = Math.min((this.ctxUsed / this.ctxMax) * 100, 100);
                const ctxIcon = ctxPct > 90 ? '$(warning)' : '$(symbol-misc)';
                parts.push(`${ctxIcon} ${ctxPct.toFixed(0)}% ctx`);
            }

            this.statusBarItem.text = parts.join('  ·  ');
        }

        // ── Background color from context level ──
        if (this.ctxMax > 0 && this.ctxUsed > 0) {
            const ctxPct = (this.ctxUsed / this.ctxMax) * 100;
            if (ctxPct > 90) {
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            } else if (ctxPct > 75) {
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            } else {
                this.statusBarItem.backgroundColor = undefined;
            }
        } else {
            this.statusBarItem.backgroundColor = undefined;
        }

        // ── Rich tooltip ──
        const md = new vscode.MarkdownString('', true);
        md.appendMarkdown('**Antigravity Quota Models**\n\n---\n\n');

        for (const m of sorted) {
            if (!m.quotaInfo) continue;
            const pct = getQuotaPercent(m);
            const sel = selectedIds.includes(m.modelOrAlias?.model || '') ? ' *(Selected)*' : '';

            const resetDate = m.quotaInfo.resetTime ? new Date(m.quotaInfo.resetTime) : null;
            const isValid = resetDate && !isNaN(resetDate.getTime());
            const timeStr = isValid
                ? resetDate.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                : 'Unknown';
            const timeLeft = isValid ? formatTimeLeft(resetDate.getTime() - Date.now()) : '';

            md.appendMarkdown(`${quotaIcon(pct)} **${m.label}** (${pct === null ? 'N/A' : pct.toFixed(0) + '%'})${sel}\n\n`);
            md.appendMarkdown(`*Resets:* ${timeStr} ${timeLeft}\n\n---\n\n`);
        }

        // Context window section in tooltip
        if (this.ctxMax > 0 && this.ctxUsed > 0) {
            const ctxPct = Math.min((this.ctxUsed / this.ctxMax) * 100, 100);
            const shortModel = this.ctxModel.split('/').pop() || this.ctxModel;
            md.appendMarkdown(`**Context Window** — ${shortModel}\n\n`);
            md.appendMarkdown(`**${ctxPct.toFixed(1)}%** used · ${formatTokens(this.ctxUsed)} / ${formatTokens(this.ctxMax)} tokens\n\n`);
            md.appendMarkdown(`**Free:** ${formatTokens(this.ctxMax - this.ctxUsed)} tokens\n\n`);
        }

        this.statusBarItem.tooltip = md;
    }
}

// ==================== Standalone Helpers ====================

/** Format token count: 147580 → "147.6K" */
function formatTokens(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
}

function getQuotaPercent(m: ClientModelConfig): number | null {
    if (m.quotaInfo?.remainingFraction === undefined) return null;
    return Math.max(0, Math.min(100, m.quotaInfo.remainingFraction * 100));
}

function quotaIcon(pct: number | null): string {
    if (pct === null) return '⚪';
    if (pct >= 100) return '🟢';
    if (pct <= 0) return '🔴';
    return '🟡';
}

function formatTimeLeft(ms: number): string {
    if (ms <= 0) return '(Reset)';
    const h = Math.floor(ms / 3_600_000);
    const min = Math.floor((ms % 3_600_000) / 60_000);
    if (h >= 24) {
        const d = Math.floor(h / 24);
        const rh = h % 24;
        return rh > 0 ? `(${d}d ${rh}h left)` : `(${d}d left)`;
    }
    return h > 0 ? `(${h}h ${min}m left)` : `(${min}m left)`;
}
