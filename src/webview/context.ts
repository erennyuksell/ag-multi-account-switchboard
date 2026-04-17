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

// ─── Refresh Timer ───
let _timer: ReturnType<typeof setInterval> | null = null;
let _fn: (() => void) | null = null;
export let intervalMs = 60000;

/** Call once at init — registers the refresh callback and starts the timer. */
export function initTimer(fn: () => void, ms: number): void {
    _fn = fn;
    intervalMs = ms;
    _timer = setInterval(fn, ms);
}

/** Updates the refresh interval and persists to webview state. */
export function updateInterval(ms: number): void {
    intervalMs = ms;
    if (_timer) clearInterval(_timer);
    if (_fn) _timer = setInterval(_fn, ms);
    vscode.setState({ ...vscode.getState(), intervalMs: ms });
}
