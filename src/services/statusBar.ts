/**
 * StatusBarService — manages the VS Code status bar item for quota display.
 * Extracted from QuotaManager to follow Single Responsibility Principle.
 */

import * as vscode from 'vscode';
import { ClientModelConfig, LocalQuotaData } from '../types';

export class StatusBarService {
    private readonly statusBarItem: vscode.StatusBarItem;

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

    /** Update status bar text + tooltip from local quota data */
    update(data: LocalQuotaData, selectedIds: string[]): void {
        const rawModels = data.userStatus?.cascadeModelConfigData?.clientModelConfigs;
        if (!rawModels || rawModels.length === 0) return;

        const sorted = [...rawModels].sort((a, b) => (a.label || '').localeCompare(b.label || ''));
        const selected = sorted.filter(m => selectedIds.includes(m.modelOrAlias?.model || ''));

        // Status bar text
        if (selected.length === 0) {
            this.statusBarItem.text = '$(pulse) Quota: No Model Selected';
        } else {
            this.statusBarItem.text = selected.map(m => {
                const pct = getQuotaPercent(m);
                return `${quotaIcon(pct)} ${m.label}: ${pct === null ? 'N/A' : pct.toFixed(0) + '%'}`;
            }).join('  |  ');
        }

        // Rich tooltip
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

        this.statusBarItem.tooltip = md;
    }
}

// ==================== Standalone Helpers ====================

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
