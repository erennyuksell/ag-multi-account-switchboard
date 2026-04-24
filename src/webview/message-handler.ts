/**
 * Message handler — routes incoming messages from the extension host.
 */

import { wlog, setPinnedModels, setLastRenderArgs, lastRenderArgs } from './context';
import { renderAll } from './renderers/accounts';
import { renderTokenBudget } from './renderers/tokens';
import { renderWorkspaceContext } from './renderers/workspace';
import { renderUsageStats, renderContextWindow } from './renderers/usage';
import { updatePricing } from '../shared/usage-components';

const $ = (id: string) => document.getElementById(id);

function stopSpinners(): void {
    $('loading')!.style.display = 'none';
    $('refreshBtn')?.classList.remove('spinning');
    $('tokenRefreshBtn')?.classList.remove('spinning');
}

export function setupMessageHandler(): void {
    window.addEventListener('message', event => {
        const msg = event.data;
        wlog('MSG_RECEIVED_TYPE_' + msg.type);

        switch (msg.type) {
            case 'loading': {
                const isFirst = $('content')!.classList.contains('hidden');
                if (isFirst) {
                    $('loading')!.style.display = 'block';
                    $('content')!.classList.add('hidden');
                } else {
                    $('refreshBtn')!.classList.add('spinning');
                    $('tokenRefreshBtn')?.classList.add('spinning');
                }
                $('error')!.innerText = '';
                break;
            }
            case 'error':
                stopSpinners();
                $('error')!.innerText = msg.message;
                if ($('content')!.classList.contains('hidden')) $('content')!.classList.remove('hidden');
                break;

            case 'update': {
                stopSpinners();
                $('content')!.classList.remove('hidden');
                $('error')!.innerText = '';
                try {
                // Save scroll position before re-render
                    const contentEl = $('content');
                    const scrollY = contentEl?.scrollTop ?? 0;

                    setLastRenderArgs([msg.accountCards || [], msg.pinnedModels || {}]);
                    if (msg.pinnedModels) setPinnedModels(msg.pinnedModels);
                    renderAll(lastRenderArgs[0] as any[], lastRenderArgs[1] as Record<string, string>);
                    if (msg.tokenBase) {
                        renderTokenBudget(msg.tokenBase);
                    } else {
                        const el = $('tokenContent');
                        if (el) el.innerHTML = '<div class="token-empty"><div class="em-icon">⚠️</div><div class="em-title">Token data unavailable</div><div class="em-sub">No Language Server found for this workspace.</div></div>';
                    }
                    renderWorkspaceContext(msg.workspaceContext || null);
                    const usageData = msg.usageStats || null;
                    if (msg.pricing) updatePricing(msg.pricing);
                    if (usageData) (window as any).__lastDeepStats = usageData;
                    renderUsageStats(usageData);
                    if (msg.contextWindow) renderContextWindow(msg.contextWindow);
                    $('lastUpdated')!.textContent = 'Updated ' + new Date().toLocaleTimeString();

                    // Restore scroll position after DOM updates
                    if (contentEl && scrollY > 0) {
                        requestAnimationFrame(() => { contentEl.scrollTop = scrollY; });
                    }
                } catch (e) {
                    wlog('RENDER_ERROR:' + (e as Error).message);
                    $('error')!.innerText = 'Render error: ' + (e as Error).message;
                }
                break;
            }

            case 'usageStatsUpdate': {
                const stats = msg.usageStats || null;
                if (stats) {
                    if (msg.pricing) updatePricing(msg.pricing);
                    (window as any).__lastDeepStats = stats;
                    renderUsageStats(stats);
                }
                break;
            }

            case 'contextWindowUpdate': {
                renderContextWindow(msg.data || null);
                break;
            }
        }
    });
}
