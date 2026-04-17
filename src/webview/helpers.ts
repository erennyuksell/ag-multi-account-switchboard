/**
 * Pure utility functions used across renderers.
 * No side effects, no DOM access — just data transformation.
 */

export function dotClass(pct: number): string {
    return pct >= 50 ? 'g' : pct >= 20 ? 'y' : 'r';
}

export const fillClass = dotClass;

export function pctClass(pct: number): string {
    return pct >= 80 ? 'r' : pct >= 50 ? 'y' : 'g';
}

export function timeLeft(resetTimeStr: string | undefined | null): string {
    if (!resetTimeStr) return '';
    const reset = new Date(resetTimeStr);
    if (isNaN(reset.getTime())) return '';
    const diff = reset.getTime() - Date.now();
    if (diff <= 0) return 'Reset';
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (h >= 24) {
        const d = Math.floor(h / 24);
        const rh = h % 24;
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

export function shortModelName(name: string | undefined | null): string {
    if (!name) return '?';
    return name.split('/').pop()!.replace(/^models-/, '').replace(/^models_/, '');
}

export function shortTierName(name: string | undefined | null): string {
    if (!name) return '';
    const parts = name.split(' ');
    return parts[parts.length - 1] || name;
}

export function fmtK(n: number | null | undefined): string {
    if (n == null) return '';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return '' + n;
}

export function fmtNum(n: number): string {
    return n.toLocaleString();
}
