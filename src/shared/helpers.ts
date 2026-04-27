/**
 * Shared helpers — SSOT for both extension host and webview.
 * Pure functions only: no DOM, no Node APIs, no side effects.
 */

import {
    QUOTA_HEALTHY_PCT, QUOTA_WARN_PCT,
    USAGE_HIGH_PCT, USAGE_MEDIUM_PCT,
    HOURS_IN_DAY,
} from './uiConstants';

// ─── CSS class helpers ───

export function dotClass(pct: number): string {
    return pct >= QUOTA_HEALTHY_PCT ? 'g' : pct >= QUOTA_WARN_PCT ? 'y' : 'r';
}

export const fillClass = dotClass;

export function pctClass(pct: number): string {
    return pct >= USAGE_HIGH_PCT ? 'r' : pct >= USAGE_MEDIUM_PCT ? 'y' : 'g';
}

// ─── Time helpers ───

export function timeLeft(resetTimeStr: string | undefined | null): string {
    if (!resetTimeStr) return '';
    const reset = new Date(resetTimeStr);
    if (isNaN(reset.getTime())) return '';
    const diff = reset.getTime() - Date.now();
    if (diff <= 0) return 'Reset';
    return formatDurationMs(diff);
}

/** Duration in ms → compact string: "5h 23m", "42m", "2d 3h" */
export function formatDurationMs(ms: number): string {
    if (ms <= 0) return '';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h >= HOURS_IN_DAY) {
        const d = Math.floor(h / HOURS_IN_DAY);
        const rh = h % HOURS_IN_DAY;
        return rh > 0 ? d + 'd ' + rh + 'h' : d + 'd';
    }
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
}

export function resetDateStr(resetTimeStr: string | undefined | null): string {
    if (!resetTimeStr) return 'Unknown';
    const d = new Date(resetTimeStr);
    if (isNaN(d.getTime())) return 'Unknown';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ─── Model/Tier name helpers ───

export function shortModelName(name: string | undefined | null): string {
    if (!name) return '?';
    return name.split('/').pop()!.replace(/^models-/, '').replace(/^models_/, '');
}

export function shortTierName(name: string | undefined | null): string {
    if (!name) return '';
    const parts = name.split(' ');
    return parts[parts.length - 1] || name;
}

// ─── Number formatters ───

export function fmtK(n: number | null | undefined): string {
    if (n == null) return '';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return '' + n;
}

/** Number → locale string with separators (28,921) */
export function fmtNum(n: number): string {
    return n.toLocaleString();
}

/** Large number → compact string (1.2M, 489.7K) */
export function fmtBig(n: number): string {
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
}

/** ISO date → short display (Apr 19) */
export function fmtShortDate(iso: string): string {
    if (!iso || iso.length < 10) return iso;
    const parts = iso.split('-');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return months[parseInt(parts[1], 10) - 1] + ' ' + parseInt(parts[2], 10);
}

// ─── HTML/Security helpers ───

/** HTML entity escape */
export function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** CSP nonce generator */
export function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
}
