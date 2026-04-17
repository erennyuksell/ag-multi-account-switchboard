/**
 * User action handlers — thin wrappers around vscode.postMessage().
 * Each function corresponds to a UI interaction (button click, toggle, etc.)
 */

import { vscode, updateInterval, pinnedModels, lastRenderArgs } from './context';
import { renderAll } from './renderers/accounts';

// ─── Helpers ───

function spinAndCall(id: string, fn: () => void): void {
    const el = document.getElementById(id);
    if (el) { el.classList.add('spinning'); setTimeout(() => el.classList.remove('spinning'), 1200); }
    fn();
}

function activateOne(selector: string, el: HTMLElement): void {
    document.querySelectorAll(selector).forEach(b => b.classList.remove('active'));
    el.classList.add('active');
}

// ─── Actions ───

export function refresh(): void {
    vscode.postMessage({ type: 'refresh' });
}

export function addAccount(): void {
    vscode.postMessage({ type: 'addAccount' });
}

export function addAccountByToken(): void {
    vscode.postMessage({ type: 'addAccountByToken' });
}

export function removeAccount(id: string): void {
    vscode.postMessage({ type: 'removeAccount', accountId: id });
}

export function switchAccount(id: string): void {
    vscode.postMessage({ type: 'switchAccount', accountId: id });
}

export function copyToken(id: string): void {
    vscode.postMessage({ type: 'copyToken', accountId: id });
}

export function toggleModel(modelId: string, isVisible: boolean): void {
    vscode.postMessage({ type: 'toggleModel', modelId, isVisible });
}

export function pinModel(accountKey: string, rawModelId: string): void {
    const modelId = decodeURIComponent(rawModelId);
    const isCurrentlyPinned = pinnedModels[accountKey] === modelId;
    if (isCurrentlyPinned) {
        delete pinnedModels[accountKey];
        vscode.postMessage({ type: 'setPinnedModel', accountKey, modelId: null });
    } else {
        pinnedModels[accountKey] = modelId;
        vscode.postMessage({ type: 'setPinnedModel', accountKey, modelId });
    }
    renderAll(lastRenderArgs[0], lastRenderArgs[1], lastRenderArgs[2], lastRenderArgs[3] as string);
}

export const doRefresh = () => spinAndCall('refreshBtn', refresh);
export const doRefreshTokenOnly = () => spinAndCall('tokenRefreshBtn', () =>
    vscode.postMessage({ type: 'refreshTokenOnly' }));

export function switchTab(tabId: string, el: HTMLElement): void {
    activateOne('.tab-btn', el);
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const target = document.getElementById('tab-' + tabId);
    if (target) target.classList.add('active');
    vscode.setState({ ...vscode.getState(), activeTab: tabId });
}

export function pickInterval(el: HTMLElement): void {
    activateOne('.iv-btn', el);
    updateInterval(parseInt(el.dataset.ms || '60000'));
}

export function toggleOpen(el: HTMLElement): void {
    el.parentElement!.classList.toggle('open');
}
