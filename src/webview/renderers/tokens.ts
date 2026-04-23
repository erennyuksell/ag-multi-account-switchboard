/**
 * Token Budget tab renderer — builds the donut chart and category breakdown.
 */

import { pctClass, fmtNum } from '../../shared/helpers';

const CAT_ICONS: Record<string, string> = { 'Rules': '📋', 'Skills': '🧠', 'Workflows': '⚙️', 'Mcp Tools': '🔌' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderTokenBudget(tb: any): void {
    const el = document.getElementById('tokenContent');
    if (!el || !tb) return;

    const usedPct = tb.usedPercent;
    const cls = pctClass(usedPct);

    // SVG donut (64px)
    const r = 26, c = 2 * Math.PI * r;
    const dashOffset = c - (c * Math.min(usedPct, 100) / 100);

    // Save current open state before rebuilding
    const openCats = new Set<string>();
    const openMcps = new Set<string>();
    el.querySelectorAll('.cat-card.open .cat-name').forEach(function(n) { openCats.add(n.textContent || ''); });
    el.querySelectorAll('.mcp-server.open .cat-item-name').forEach(function(n) { openMcps.add(n.textContent || ''); });

    let html = '';

    // Budget summary strip with donut
    html += '<div class="budget-strip">';
    html += '<div class="donut-wrap">';
    html += '<svg viewBox="0 0 64 64"><circle class="donut-bg" cx="32" cy="32" r="' + r + '"/>';
    html += '<circle class="donut-fg ' + cls + '" cx="32" cy="32" r="' + r + '" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + dashOffset.toFixed(1) + '"/></svg>';
    html += '<div class="donut-label">' + usedPct + '%</div>';
    html += '</div>';
    html += '<div class="budget-info">';
    html += '<div class="budget-title">Context Token Usage</div>';
    html += '<div class="budget-detail">';
    html += fmtNum(tb.totalTokens) + ' / ' + fmtNum(tb.customizationBudget) + ' tokens';
    if (tb.remainingBudget < 0) {
        html += '<br><span class="over">Over budget by ' + fmtNum(Math.abs(tb.remainingBudget)) + ' tokens</span>';
    } else {
        html += '<br>' + fmtNum(tb.remainingBudget) + ' remaining';
    }
    if (usedPct >= 90) {
        html += '<br><span class="over">\u26a0 Context may be trimmed</span>';
    }
    html += '</div></div></div>';

    // Category breakdown
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cats = (tb.categories || []).sort((a: any, b: any) => b.totalTokens - a.totalTokens);

    for (let ci = 0; ci < cats.length; ci++) {
        const cat = cats[ci];
        const catPct = tb.customizationBudget > 0 ? Math.round(cat.totalTokens / tb.customizationBudget * 100) : 0;
        const icon = CAT_ICONS[cat.name] || '\ud83d\udce6';

        html += '<div class="cat-card">';
        html += '<div class="cat-hdr" data-action="toggle-open">';
        html += '<span class="cat-icon">' + icon + '</span>';
        html += '<span class="cat-name">' + cat.name + '</span>';
        html += '<span class="cat-tokens">' + fmtNum(cat.totalTokens) + '</span>';
        html += '<span class="cat-pct ' + pctClass(catPct * 3) + '">' + catPct + '%</span>';
        html += '<span class="cat-chev">\u203a</span>';
        html += '</div>';

        // Items
        html += '<div class="cat-items">';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items = (cat.items || []).sort((a: any, b: any) => b.tokens - a.tokens);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const item of items as any[]) {
            const itemPct = cat.totalTokens > 0 ? Math.round(item.tokens / cat.totalTokens * 100) : 0;
            const hasTools = item.tools && item.tools.length > 0;

            if (hasTools) {
                // MCP server — 2nd level collapsible
                html += '<div class="mcp-server">';
                html += '<div class="mcp-server-hdr" data-action="toggle-open">';
                html += '<span class="mcp-server-chev">\u203a</span>';
                html += '<span class="cat-item-name">' + item.name + '</span>';
                html += '<span class="cat-item-tokens">' + fmtNum(item.tokens) + '</span>';
                html += '<div class="cat-item-bar"><div class="cat-item-fill ' + pctClass(itemPct) + '" style="width:' + itemPct + '%"></div></div>';
                html += '</div>';
                html += '<div class="mcp-tools">';
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const sortedTools = item.tools.slice().sort(function(a: any, b: any) { return b.tokens - a.tokens; });
                for (let ti = 0; ti < sortedTools.length; ti++) {
                    html += '<div class="mcp-tool">';
                    html += '<span class="mcp-tool-name">' + sortedTools[ti].name + '</span>';
                    html += '<span class="mcp-tool-tokens">' + fmtNum(sortedTools[ti].tokens) + '</span>';
                    html += '</div>';
                }
                html += '</div></div>';
            } else {
                // Regular item (rules, skills, workflows)
                html += '<div class="cat-item">';
                html += '<span class="cat-item-name">' + item.name + '</span>';
                html += '<span class="cat-item-tokens">' + fmtNum(item.tokens) + '</span>';
                html += '<div class="cat-item-bar"><div class="cat-item-fill ' + pctClass(itemPct) + '" style="width:' + itemPct + '%"></div></div>';
                html += '</div>';
            }
        }
        html += '</div></div>';
    }

    el.innerHTML = html;

    // Restore open state
    el.querySelectorAll('.cat-card .cat-name').forEach(function(n) {
        if (openCats.has(n.textContent || '')) n.closest('.cat-card')!.classList.add('open');
    });
    el.querySelectorAll('.mcp-server .cat-item-name').forEach(function(n) {
        if (openMcps.has(n.textContent || '')) n.closest('.mcp-server')!.classList.add('open');
    });
}
