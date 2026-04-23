/**
 * Webview entry point — initializes state, registers error handlers,
 * and routes UI events via data-action delegation.
 *
 * This file is the esbuild entry point → bundled to out/webview/panel.js
 */

import { vscode, wlog, intervalMs, initTimer } from './context';
import { setupMessageHandler } from './message-handler';
import {
    refresh, addAccount, addAccountByToken, removeAccount, switchAccount,
    copyToken, toggleModel, pinModel, doRefresh, doRefreshTokenOnly,
    doRefreshUsage, switchTab, pickInterval, toggleOpen,
} from './actions';

interface SavedState { intervalMs?: number; activeTab?: string }

wlog('SCRIPT_EVALUATED_TOP');

// ─── Global Error Surface ───
window.onerror = function(msg, _src, line, _col, err) {
    document.getElementById('error')!.innerText += '\nGlobal crash: ' + msg + ' line: ' + line;
    vscode.postMessage({ type: 'weblog', msg: 'CRITICAL_CRASH: ' + msg + ' at line ' + line });
    let overlay = document.getElementById('fatalError');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'fatalError';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:10px 14px;background:#5a1d1d;color:#f97583;font-size:11px;font-family:monospace;z-index:9999;white-space:pre-wrap;word-break:break-all;border-bottom:1px solid #f97583';
        document.body.prepend(overlay);
    }
    overlay.textContent = '\u26a0 Panel Script Error\n' + msg + (line ? ' (line ' + line + ')' : '') + (err && err.stack ? '\n' + err.stack.slice(0, 300) : '');
    return false;
};
window.addEventListener('unhandledrejection', function(e) {
    window.onerror!('Unhandled Promise: ' + (e.reason?.message || e.reason), '', 0, 0, e.reason);
});

// ─── Init ───
const saved = (vscode.getState() || {}) as SavedState;
initTimer(refresh, saved.intervalMs || 60000);
document.querySelectorAll('.iv-btn').forEach(b => {
    b.classList.toggle('active', parseInt((b as HTMLElement).dataset.ms || '0') === intervalMs);
});
setupMessageHandler();

wlog('BEFORE_READY_POST');
vscode.postMessage({ type: 'ready' });
wlog('AFTER_READY_POST');

if (saved.activeTab) {
    const tabBtn = document.querySelector('.tab-btn[data-tab="' + saved.activeTab + '"]');
    if (tabBtn) switchTab(saved.activeTab, tabBtn as HTMLElement);
}

// ─── Event Delegation ───
import { renderUsageStats } from './renderers/usage';

const ACTIONS: Record<string, (t: HTMLElement) => void> = {
    'switch-tab':           t => switchTab(t.dataset.tab!, t),
    'refresh':              () => doRefresh(),
    'add-account':          () => addAccount(),
    'add-account-by-token': () => addAccountByToken(),
    'refresh-token-only':   () => doRefreshTokenOnly(),
    'refresh-usage-only':   () => doRefreshUsage(),
    'set-interval':         t => pickInterval(t),
    'switch-account':       t => switchAccount(t.dataset.id!),
    'copy-token':           t => copyToken(t.dataset.id!),
    'remove-account':       t => removeAccount(t.dataset.id!),
    'toggle-open':          t => toggleOpen(t),
    'pin-model':            t => pinModel(t.dataset.accountKey!, t.dataset.modelId!),
    'open-file':            t => vscode.postMessage({ type: 'openFile', path: t.dataset.openPath }),
    'set-usage-range':      t => {
        const range = t.dataset.range || 'all';
        (window as any).__usageRange = range;
        // Immediate visual feedback — toggle active class without waiting for backend
        const bar = document.getElementById('usageRangeBar');
        if (bar) {
            bar.querySelectorAll('.deep-range-btn').forEach(b => b.classList.remove('active'));
            t.classList.add('active');
        }
        // Send to extension host for proper re-aggregation
        vscode.postMessage({ type: 'setUsageRange', range });
    },
    'open-usage-panel':     () => vscode.postMessage({ type: 'openUsagePanel' }),
};

document.addEventListener('click', (e: MouseEvent) => {
    const t = (e.target as Element).closest('[data-action]') as HTMLElement | null;
    if (t) ACTIONS[t.dataset.action!]?.(t);
});

document.addEventListener('change', (e: Event) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset?.action === 'toggle-model') toggleModel(t.dataset.id!, t.checked);
});
