/**
 * Shared webview context — breaks circular dependencies between modules.
 * All modules import from here; this file imports from nobody.
 */

// ─── API ───
export const vscode = acquireVsCodeApi();
export const wlog = (m: string) => vscode.postMessage({ type: 'weblog', msg: m });

// ─── Shared State ───
export let pinnedModels: Record<string, string> = {};
export let lastRenderArgs: unknown[] = [];
export const setPinnedModels = (m: Record<string, string>) => { pinnedModels = m; };
export const setLastRenderArgs = (a: unknown[]) => { lastRenderArgs = a; };

// ─── Refresh rate ───
// The extension host owns the refresh timer (it keeps running while the panel
// is collapsed); the picker only asks it to change and shows what it reports.

/** Highlight the rate the host says is in effect. */
export function showInterval(ms: number): void {
    document.querySelectorAll('.iv-btn').forEach(b => {
        b.classList.toggle('active', parseInt((b as HTMLElement).dataset.ms || '0') === ms);
    });
}
