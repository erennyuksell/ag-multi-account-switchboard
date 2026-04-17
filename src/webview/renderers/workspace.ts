/**
 * Workspace Context renderer — shows .agent/ items (rules, skills, workflows).
 */


// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderWorkspaceContext(wc: any): void {
    const el = document.getElementById('workspaceContextContent');
    if (!el) return;

    const rAon = (wc && wc.rules) ? wc.rules : [];
    const rMd  = (wc && wc.rulesModelDecision) ? wc.rulesModelDecision : [];
    const rMan = (wc && wc.rulesManual) ? wc.rulesManual : [];
    const skills = (wc && wc.skills) ? wc.skills : [];
    const workflows = (wc && wc.workflows) ? wc.workflows : [];

    if (!wc || (rAon.length + rMd.length + rMan.length + skills.length + workflows.length === 0)) {
        el.innerHTML = '<div class="wc-empty">No .agent/ items indexed for this workspace.</div>';
        return;
    }

    // Save open state
    const openGroups = new Set<string>();
    el.querySelectorAll('.wc-group.open .wc-group-title').forEach(function(n) {
        openGroups.add((n as HTMLElement).dataset.key || '');
    });

    let html = '';

    // Header
    const total = rAon.length + rMd.length + rMan.length + skills.length + workflows.length;
    html += '<div class="wc-header">';
    html += '<span class="wc-ws-name">' + ((wc && wc.workspaceName) ? wc.workspaceName : 'Workspace') + '</span>';
    html += '<span class="wc-total">' + total + ' items</span>';
    html += '</div>';

    const groups = [
        { key: 'rules',      icon: '\ud83d\udccb', label: 'Rules',              items: rAon,  mode: 'always-on' },
        { key: 'rulesmd',    icon: '\ud83d\udcc4', label: 'Rules (AI decides)', items: rMd,   mode: 'model-decision' },
        { key: 'rulesmanual',icon: '\ud83d\udcc4', label: 'Rules (manual)',      items: rMan,  mode: 'manual' },
        { key: 'skills',     icon: '\ud83e\udde0', label: 'Skills',              items: skills,    mode: 'on-demand' },
        { key: 'workflows',  icon: '\u2699\ufe0f', label: 'Workflows',           items: workflows, mode: 'on-demand' },
    ];

    for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        if (!g.items || g.items.length === 0) continue;
        const isOpen = openGroups.has(g.key);

        // Total token estimate for group
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const groupTokens = g.items.reduce(function(sum: number, it: any) { return sum + Math.round((it.sizeBytes || 0) / 4); }, 0);
        const groupTokStr = groupTokens > 0 ? '~' + groupTokens.toLocaleString() + ' tok' : '';

        html += '<div class="wc-group' + (isOpen ? ' open' : '') + '">';
        html += '<div class="wc-group-hdr" data-action="toggle-open">';
        html += '<span class="wc-group-icon">' + g.icon + '</span>';
        html += '<span class="wc-group-title" data-key="' + g.key + '">' + g.label + '</span>';
        html += '<span class="wc-mode-badge wc-mode-' + g.mode.replace(/-/g, '') + '">' + g.mode + '</span>';
        if (groupTokStr) html += '<span class="wc-group-tokens">' + groupTokStr + '</span>';
        html += '<span class="wc-group-count">' + g.items.length + '</span>';
        html += '<span class="wc-chev">\u203a</span>';
        html += '</div>';
        html += '<div class="wc-items">';
        for (let ii = 0; ii < g.items.length; ii++) {
            const item = g.items[ii];
            const tok = (item.sizeBytes || 0) > 0 ? Math.round(item.sizeBytes / 4) : 0;
            const escapedPath = (item.path || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
            const escapedName = (item.name || '').replace(/&/g,'&amp;').replace(/</g,'&lt;');
            html += '<div class="wc-item wc-item-clickable" data-action="open-file" data-open-path="' + escapedPath + '" title="' + escapedPath + '">';
            html += '<span class="wc-item-name">' + escapedName + '</span>';
            if (tok > 0) html += '<span class="wc-item-tokens">~' + tok.toLocaleString() + '</span>';
            html += '</div>';
        }
        html += '</div></div>';
    }

    el.innerHTML = html;


    // Restore open state
    el.querySelectorAll('.wc-group .wc-group-title').forEach(function(n) {
        if (openGroups.has((n as HTMLElement).dataset.key || '')) n.closest('.wc-group')!.classList.add('open');
    });
}
