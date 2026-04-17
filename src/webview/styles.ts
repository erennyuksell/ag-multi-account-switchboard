/**
 * Webview CSS styles for Quota Radar panel.
 * Exported as a template literal string for inline injection.
 */
export function getStyles(): string {
    return `
        :root {
            --bg: var(--vscode-editor-background);
            --fg: var(--vscode-foreground);
            --accent: var(--vscode-textLink-foreground);
            --border: var(--vscode-panel-border, var(--vscode-activityBar-border, rgba(128,128,128,0.2)));
            --hover: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05));
            --bar-fill: var(--vscode-progressBar-background, #0e70c0);
            --bar-warn: var(--vscode-editorWarning-foreground, #cca700);
            --bar-crit: var(--vscode-editorError-foreground, #f48771);
            --bar-empty: var(--vscode-editorWidget-border, rgba(128,128,128,0.15));
            --success: var(--vscode-terminal-ansiGreen, #4ec9b0);
            --error: var(--vscode-editorError-foreground, #f48771);
            --muted: var(--vscode-descriptionForeground, #858585);
            --btn-bg: var(--vscode-button-background);
            --btn-fg: var(--vscode-button-foreground);
            --badge-bg: var(--vscode-badge-background, #007acc);
            --badge-fg: var(--vscode-badge-foreground, #fff);
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: var(--vscode-font-family);
            font-size: 13px;
            color: var(--fg);
            background: var(--bg);
            display: flex;
            flex-direction: column;
            min-height: 100vh;
        }

        /* ─── Summary Strip ─── */
        .summary-strip {
            padding: 8px 10px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            border-bottom: 1px solid var(--border);
            background: rgba(128,128,128,0.03);
            flex-shrink: 0;
            gap: 6px;
        }
        .summary-left {
            display: flex;
            align-items: center;
            gap: 7px;
            font-size: 11px;
            min-width: 0;
            flex: 1;
        }
        .dot-group { display: flex; gap: 3px; flex-shrink: 0; }
        .hdot { width: 7px; height: 7px; border-radius: 50%; }
        .hdot.g { background: var(--success); box-shadow: 0 0 4px rgba(78,201,176,.4); }
        .hdot.y { background: var(--bar-warn); box-shadow: 0 0 4px rgba(204,167,0,.4); }
        .hdot.r { background: var(--bar-crit); box-shadow: 0 0 4px rgba(244,135,113,.4); }
        .summary-label {
            color: var(--muted);
            font-variant-numeric: tabular-nums;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .summary-right { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
        .s-btn {
            background: none; border: none; cursor: pointer;
            color: var(--muted); padding: 3px; border-radius: 3px;
            display: flex; align-items: center; justify-content: center;
            transition: color .15s, background .15s;
            width: 24px; height: 24px; flex-shrink: 0;
        }
        .s-btn:hover { color: var(--fg); background: var(--hover); }
        .s-btn svg { width: 14px; height: 14px; flex-shrink: 0; }
        .s-btn.spinning svg { animation: spin .8s linear infinite; }

        /* ─── Account List ─── */
        .account-list { padding: 6px 0; flex: 1; overflow-y: auto; }

        .acct {
            margin: 0 6px 4px; border-radius: 6px; overflow: hidden;
            border: 1px solid rgba(255,255,255,.04);
            transition: border-color .15s, box-shadow .15s;
        }
        .acct:hover { border-color: var(--border); }
        .acct-active {
            border-color: rgba(78,201,176,.2);
            box-shadow: 0 0 8px rgba(78,201,176,.06);
        }
        .acct-active:hover { border-color: rgba(78,201,176,.35); }

        .acct-hdr {
            display: flex; align-items: center;
            padding: 8px 8px; cursor: pointer;
            border-radius: 5px; gap: 8px;
            user-select: none; transition: background .12s;
        }
        .acct-hdr:hover { background: var(--hover); }

        .acct-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .acct-dot.g { background: var(--success); box-shadow: 0 0 5px rgba(78,201,176,.3); }
        .acct-dot.y { background: var(--bar-warn); box-shadow: 0 0 5px rgba(204,167,0,.3); }
        .acct-dot.r { background: var(--bar-crit); box-shadow: 0 0 5px rgba(244,135,113,.3); }
        .acct-dot.x { background: var(--muted); }

        .acct-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
        .acct-email {
            font-size: 13px; font-weight: 500;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            display: flex; align-items: center; gap: 6px;
        }
        .active-tag {
            font-size: 10px; font-weight: 600;
            color: var(--badge-fg);
            background: var(--success);
            padding: 1px 6px; border-radius: 3px;
            letter-spacing: .3px; flex-shrink: 0;
            line-height: 1.4;
        }
        .tier-tag {
            font-size: 10px; font-weight: 600;
            color: #7eb4ff;
            background: rgba(126,180,255,.12);
            padding: 1px 6px; border-radius: 3px;
            letter-spacing: .3px; flex-shrink: 0;
            line-height: 1.4;
        }
        .acct-credits {
            display: flex; gap: 4px; flex-wrap: wrap;
            margin-top: 1px;
        }
        .cr-chip {
            font-size: 10px; font-weight: 500;
            font-variant-numeric: tabular-nums;
            color: #b0b0b0;
            background: rgba(255,255,255,.06);
            padding: 1px 7px; border-radius: 4px;
            display: inline-flex; align-items: center; gap: 3px;
            line-height: 1.5;
        }
        .cr-icon { font-size: 9px; font-weight: 700; letter-spacing: 0.03em; opacity: 0.75; }
        .cr-prompt { color: #cca700; }
        .cr-flow { color: #e08050; }
        .acct-bn-wrap { display: flex; flex-direction: column; gap: 3px; }
        .acct-sub {
            font-size: 10px; color: var(--muted);
            font-variant-numeric: tabular-nums;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .bn-mini-track {
            height: 2px; border-radius: 1px;
            background: rgba(255,255,255,.06); overflow: hidden;
        }
        .bn-mini-fill { height: 100%; border-radius: 1px; transition: width .5s cubic-bezier(.4,0,.2,1); }
        .bn-mini-fill.g { background: var(--bar-fill); }
        .bn-mini-fill.y { background: var(--bar-warn); }
        .bn-mini-fill.r { background: var(--bar-crit); }
        .bn-model { color: var(--fg); font-weight: 500; }
        .bn-pct { font-weight: 600; font-variant-numeric: tabular-nums; }
        .bn-pct.g { color: var(--success); }
        .bn-pct.y { color: var(--bar-warn); }
        .bn-pct.r { color: var(--bar-crit); }
        .bn-sep { opacity: .3; }

        .acct-chev {
            color: var(--muted); font-size: 12px;
            transition: transform .2s; flex-shrink: 0;
            width: 14px; text-align: center;
        }
        .acct.open .acct-chev { transform: rotate(90deg); }

        /* ─── Account Action Buttons ─── */
        .acct-actions {
            display: flex; align-items: center; gap: 2px;
            opacity: 0; transition: opacity .12s; flex-shrink: 0;
        }
        .acct-hdr:hover .acct-actions { opacity: 1; }

        .acct-switch, .acct-key, .acct-del {
            background: none; border: none;
            color: var(--muted); cursor: pointer;
            padding: 3px; border-radius: 4px;
            transition: color .12s, background .12s; flex-shrink: 0;
            display: flex; align-items: center; justify-content: center;
        }
        .acct-switch svg, .acct-key svg, .acct-del svg { width: 14px; height: 14px; }
        .acct-switch:hover { color: var(--accent); background: rgba(74,222,128,.1); }
        .acct-key:hover { color: #cca700; background: rgba(204,167,0,.1); }
        .acct-del:hover { color: var(--error); background: rgba(244,135,113,.1); }

        /* ─── Model Details (collapsed) ─── */
        .m-details { max-height: 0; overflow: hidden; transition: max-height .25s ease; }
        .acct.open .m-details { max-height: 900px; }

        /* Two-line model layout: name+pct on top, bar below */
        /* ─── Quota Pool Headers (Expanded) ─── */
        .pool-hdr {
            display: flex; align-items: center; justify-content: space-between;
            padding: 8px 8px 4px 8px;
            border-bottom: 1px dashed rgba(255,255,255,.08);
            margin-bottom: 2px;
        }
        .pool-hdr:not(:first-child) { margin-top: 6px; }
        .pool-name {
            font-size: 9px; font-weight: 700; letter-spacing: .8px;
            text-transform: uppercase; color: var(--muted); opacity: .7;
        }
        .pool-meta { display: flex; align-items: center; gap: 4px; font-size: 10px; }
        .pool-pct { font-weight: 600; font-variant-numeric: tabular-nums; }
        .pool-pct.g { color: var(--success); }
        .pool-pct.y { color: var(--bar-warn); }
        .pool-pct.r { color: var(--bar-crit); }
        .pool-reset { color: var(--muted); font-size: 10px; }
        .pool-bar-wrap {
            height: 3px; border-radius: 2px;
            background: rgba(255,255,255,.05);
            margin: 0 8px 4px 8px; overflow: hidden;
        }
        .pool-bar-fill { height: 100%; border-radius: 2px; transition: width .6s cubic-bezier(.4,0,.2,1); }
        .pool-bar-fill.g { background: var(--bar-fill); }
        .pool-bar-fill.y { background: var(--bar-warn); }
        .pool-bar-fill.r { background: var(--bar-crit); }

        /* m-item: star + content column */
        .m-item {
            display: flex; align-items: center;
            padding: 4px 8px; gap: 6px;
        }
        .m-content { flex: 1; min-width: 0; }
        .m-top {
            display: flex; align-items: center; justify-content: space-between;
            gap: 6px; margin-bottom: 3px;
        }
        .m-label {
            font-size: 12px; color: var(--fg);
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            flex: 1; min-width: 0;
        }
        .m-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
        .m-pct {
            font-variant-numeric: tabular-nums; font-weight: 600;
            font-size: 12px; flex-shrink: 0;
        }
        .m-track { height: 3px; border-radius: 2px; background: var(--bar-empty); overflow: hidden; }
        .m-fill { height: 100%; border-radius: 2px; transition: width .5s cubic-bezier(.4,0,.2,1); }
        .m-fill.g { background: var(--bar-fill); }
        .m-fill.y { background: var(--bar-warn); }
        .m-fill.r { background: var(--bar-crit); }

        /* Star / pin button — centered with full item height by parent flex */
        .star-btn {
            -webkit-appearance: none; appearance: none;
            background: none; border: none; cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            padding: 0; margin: 0; width: 20px; flex-shrink: 0; opacity: 0;
            font-size: 12px; color: var(--fg); transition: opacity .15s, color .15s;
        }
        .m-item:hover .star-btn { opacity: 0.5; }
        .m-item:hover .star-btn:hover { opacity: 1; }
        .star-btn.pinned { opacity: 1 !important; color: #f5a623; }
        .bn-pin-dot { color: #f5a623; font-size: 10px; }

        .m-reset-inline {
            font-size: 10px; color: var(--muted);
            margin-top: 2px; padding-bottom: 2px;
            font-variant-numeric: tabular-nums;
        }

        /* Status bar toggle */
        .sb-t { width: 22px; height: 13px; position: relative; display: inline-block; flex-shrink: 0; }
        .sb-t input { display: none; }
        .sb-s {
            position: absolute; inset: 0;
            background: rgba(128,128,128,0.25);
            border-radius: 12px; cursor: pointer; transition: background .2s;
        }
        .sb-s::before {
            content: ''; position: absolute;
            width: 9px; height: 9px; bottom: 2px; left: 2px;
            background: var(--bg); border-radius: 50%; transition: transform .2s;
        }
        .sb-t input:checked + .sb-s { background: var(--accent); }
        .sb-t input:checked + .sb-s::before { transform: translateX(9px); }


        /* ─── Add Account ─── */
        .add-area { padding: 4px 6px; flex-shrink: 0; }
        .add-btn {
            width: 100%; padding: 6px 0;
            border: 1px dashed var(--border); border-radius: 4px;
            background: none; color: var(--muted);
            font-family: inherit; font-size: 12px; cursor: pointer;
            display: flex; align-items: center; justify-content: center; gap: 4px;
            transition: color .12s, border-color .12s, background .12s;
        }
        .add-btn:hover { color: var(--fg); border-color: var(--muted); background: var(--hover); }
        .add-btn svg { width: 12px; height: 12px; }

        /* ─── Footer ─── */
        .foot {
            padding: 6px 10px; border-top: 1px solid var(--border);
            font-size: 11px; color: var(--muted);
            display: flex; justify-content: space-between; align-items: center;
            flex-shrink: 0;
        }
        .foot .rlink { color: var(--muted); cursor: pointer; transition: color .12s; }
        .foot .rlink:hover { color: var(--fg); }

        /* Interval picker */
        .interval-pick {
            display: inline-flex; align-items: center; gap: 3px;
        }
        .interval-pick .iv-btn {
            background: none; border: 1px solid transparent;
            color: var(--muted); cursor: pointer;
            font-family: inherit; font-size: 10px;
            padding: 1px 5px; border-radius: 3px;
            transition: all .12s; font-variant-numeric: tabular-nums;
        }
        .interval-pick .iv-btn:hover { color: var(--fg); background: var(--hover); }
        .interval-pick .iv-btn.active {
            color: var(--fg);
            border-color: var(--border);
            background: var(--hover);
        }

        /* ─── States ─── */
        .loader {
            display: none;
            padding: 0 12px;
        }

        .init-shimmer {
            display: flex; flex-direction: column; gap: 10px;
            padding-top: 8px;
        }
        .init-shimmer .sh-strip {
            height: 32px; border-radius: 6px;
            background: linear-gradient(90deg, rgba(128,128,128,.08) 25%, rgba(128,128,128,.16) 50%, rgba(128,128,128,.08) 75%);
            background-size: 200% 100%;
            animation: shimmer 1.4s ease-in-out infinite;
        }
        .init-shimmer .sh-card {
            height: 96px; border-radius: 10px;
            background: linear-gradient(90deg, rgba(128,128,128,.06) 25%, rgba(128,128,128,.13) 50%, rgba(128,128,128,.06) 75%);
            background-size: 200% 100%;
            animation: shimmer 1.4s ease-in-out infinite;
            animation-delay: .15s;
        }
        .init-shimmer .sh-card-sm {
            height: 52px; border-radius: 10px;
            background: linear-gradient(90deg, rgba(128,128,128,.05) 25%, rgba(128,128,128,.11) 50%, rgba(128,128,128,.05) 75%);
            background-size: 200% 100%;
            animation: shimmer 1.4s ease-in-out infinite;
            animation-delay: .3s;
        }
        .init-label {
            text-align: center; font-size: 11px; color: var(--muted);
            padding: 6px 0 0; opacity: .7;
        }
        @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        @keyframes spin { to { transform: rotate(360deg); } }
        .err-msg { text-align: center; font-size: 12px; color: var(--error); padding: 0; }
        .err-msg:not(:empty) { padding: 12px; }
        .hidden { display: none !important; }

        .empty-state { text-align: center; padding: 28px 16px; color: var(--muted); }
        .empty-state .em-icon { font-size: 28px; margin-bottom: 10px; opacity: .35; }
        .empty-state .em-title { font-size: 13px; font-weight: 500; color: var(--fg); margin-bottom: 4px; }
        .empty-state .em-desc { font-size: 12px; line-height: 1.5; }

        .acct-err { padding: 4px 22px 8px; font-size: 11px; color: var(--error); }

        /* ─── Tab Bar ─── */
        .tab-bar {
            display: flex;
            border-bottom: 1px solid var(--border);
            background: rgba(128,128,128,0.03);
            flex-shrink: 0;
        }
        .tab-btn {
            flex: 1;
            background: none; border: none; border-bottom: 2px solid transparent;
            color: var(--muted); cursor: pointer;
            font-family: inherit; font-size: 11px; font-weight: 500;
            padding: 7px 6px 5px;
            display: flex; align-items: center; justify-content: center; gap: 5px;
            transition: color .15s, border-color .15s, background .15s;
        }
        .tab-btn svg { width: 13px; height: 13px; flex-shrink: 0; }
        .tab-btn:hover { color: var(--fg); background: var(--hover); }
        .tab-btn.active {
            color: var(--fg);
            border-bottom-color: var(--accent);
        }
        .tab-content { display: none; flex: 1; overflow-y: auto; flex-direction: column; }
        .tab-content.active { display: flex; }

        /* ─── Token Budget Tab ─── */
        .token-strip {
            padding: 6px 10px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            border-bottom: 1px solid var(--border);
            background: rgba(128,128,128,0.03);
            flex-shrink: 0;
        }
        .token-strip-label { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
        .token-tab { padding: 8px; }
        .token-empty { text-align: center; padding: 28px 16px; color: var(--muted); }
        .token-empty .em-icon { font-size: 28px; margin-bottom: 10px; opacity: .35; }
        .token-empty .em-title { font-size: 13px; font-weight: 500; color: var(--fg); margin-bottom: 4px; }

        /* Budget summary */
        .budget-strip {
            padding: 10px;
            border-radius: 6px;
            background: rgba(128,128,128,0.05);
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            gap: 12px;
        }

        /* Donut chart */
        .donut-wrap { position: relative; width: 64px; height: 64px; flex-shrink: 0; }
        .donut-wrap svg { width: 64px; height: 64px; transform: rotate(-90deg); }
        .donut-bg { fill: none; stroke: var(--bar-empty); stroke-width: 5; }
        .donut-fg { fill: none; stroke-width: 5; stroke-linecap: round; transition: stroke-dashoffset .6s ease; }
        .donut-fg.g { stroke: var(--bar-fill); }
        .donut-fg.y { stroke: var(--bar-warn); }
        .donut-fg.r { stroke: var(--bar-crit); }
        .donut-label {
            position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
            font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums;
        }

        .budget-info { flex: 1; min-width: 0; }
        .budget-title { font-size: 12px; font-weight: 600; margin-bottom: 3px; }
        .budget-detail { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; line-height: 1.5; }
        .budget-detail .over { color: var(--bar-crit); font-weight: 600; }

        /* Category cards */
        .cat-card {
            margin-bottom: 4px;
            border-radius: 5px;
            overflow: hidden;
        }
        .cat-hdr {
            display: flex; align-items: center;
            padding: 7px 8px; gap: 8px;
            cursor: pointer; user-select: none;
            border-radius: 5px;
            transition: background .12s;
        }
        .cat-hdr:hover { background: var(--hover); }
        .cat-icon { font-size: 13px; width: 18px; text-align: center; flex-shrink: 0; }
        .cat-name { font-size: 12px; font-weight: 500; flex: 1; min-width: 0; }
        .cat-tokens {
            font-size: 11px; color: var(--muted);
            font-variant-numeric: tabular-nums; flex-shrink: 0;
        }
        .cat-pct {
            font-size: 10px; font-weight: 600;
            padding: 1px 5px; border-radius: 3px;
            font-variant-numeric: tabular-nums; flex-shrink: 0;
        }
        .cat-pct.g { color: var(--success); background: rgba(78,201,176,.1); }
        .cat-pct.y { color: var(--bar-warn); background: rgba(204,167,0,.1); }
        .cat-pct.r { color: var(--bar-crit); background: rgba(244,135,113,.1); }
        .cat-chev {
            color: var(--muted); font-size: 12px;
            transition: transform .2s; flex-shrink: 0;
            width: 14px; text-align: center;
        }
        .cat-card.open .cat-chev { transform: rotate(90deg); }

        /* Items within category */
        .cat-items { max-height: 0; overflow: hidden; transition: max-height .25s ease; }
        .cat-card.open .cat-items { max-height: 600px; }
        .cat-item {
            display: flex; align-items: center;
            padding: 3px 8px 3px 26px; gap: 6px;
            font-size: 11px;
        }
        .cat-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .cat-item-tokens { color: var(--muted); font-variant-numeric: tabular-nums; flex-shrink: 0; }
        .cat-item-bar { width: 40px; height: 3px; border-radius: 2px; background: var(--bar-empty); overflow: hidden; flex-shrink: 0; }
        .cat-item-fill { height: 100%; border-radius: 2px; }
        .cat-item-fill.g { background: var(--bar-fill); }
        .cat-item-fill.y { background: var(--bar-warn); }
        .cat-item-fill.r { background: var(--bar-crit); }

        /* MCP sub-tools */
        .mcp-tools { padding-left: 14px; }
        .mcp-tool {
            display: flex; align-items: center;
            padding: 2px 8px 2px 26px; gap: 6px;
            font-size: 10px; color: var(--muted);
        }
        .mcp-tool-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .mcp-tool-tokens { font-variant-numeric: tabular-nums; flex-shrink: 0; }

        /* MCP server 2nd-level collapse */
        .mcp-server { margin-bottom: 1px; }
        .mcp-server-hdr {
            display: flex; align-items: center;
            padding: 4px 8px 4px 20px; gap: 6px;
            cursor: pointer; user-select: none;
            font-size: 11px; font-weight: 500;
            border-radius: 3px;
            transition: background .12s;
        }
        .mcp-server-hdr:hover { background: var(--hover); }
        .mcp-server-chev {
            color: var(--muted); font-size: 11px;
            transition: transform .2s; flex-shrink: 0;
            width: 12px; text-align: center;
        }
        .mcp-server.open .mcp-server-chev { transform: rotate(90deg); }
        .mcp-server .mcp-tools { max-height: 0; overflow: hidden; transition: max-height .25s ease; }
        .mcp-server.open .mcp-tools { max-height: 800px; }

        /* ─── Workspace Context Section ─── */
        .wc-section {
            margin-top: 10px;
            border-top: 1px solid var(--border);
        }
        .wc-section-hdr {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 7px 8px 5px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            color: var(--muted);
        }
        .wc-section-icon { font-size: 13px; }
        .wc-section-label { flex: 1; }
        .wc-section-badge {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 10px;
            background: rgba(128,128,128,0.12);
            color: var(--muted);
            border-radius: 3px;
            padding: 1px 5px;
        }
        .wc-content { padding: 0 0 6px; }
        .wc-empty { padding: 6px 10px; font-size: 11px; color: var(--muted); font-style: italic; }

        /* Workspace header strip */
        .wc-header {
            display: flex; align-items: center; gap: 6px;
            padding: 4px 8px 6px;
            font-size: 11px;
        }
        .wc-ws-name { font-weight: 500; color: var(--fg); flex: 1; }
        .wc-total { color: var(--muted); font-size: 10px; }

        /* Workspace groups (rules/skills/workflows) */
        .wc-group { border-radius: 4px; overflow: hidden; margin: 0 4px 3px; }
        .wc-group-hdr {
            display: flex; align-items: center; gap: 6px;
            padding: 5px 8px;
            cursor: pointer;
            user-select: none;
            border-radius: 4px;
            background: rgba(128,128,128,0.04);
        }
        .wc-group-hdr:hover { background: var(--hover); }
        .wc-group-icon { font-size: 12px; }
        .wc-group-title { flex: 1; font-size: 12px; font-weight: 500; }
        .wc-group-count {
            font-size: 10px; font-weight: 600;
            background: var(--badge-bg); color: var(--badge-fg);
            border-radius: 8px; padding: 0 5px; min-width: 18px;
            text-align: center;
        }
        .wc-group-tokens {
            font-size: 10px; color: var(--muted);
            font-family: var(--vscode-editor-font-family, monospace);
        }
        .wc-mode-badge {
            font-size: 9px; font-weight: 600;
            border-radius: 3px; padding: 1px 5px;
            text-transform: uppercase; letter-spacing: 0.05em;
            flex-shrink: 0;
        }
        .wc-mode-alwayson    { background: rgba(78,201,176,0.15); color: #4ec9b0; }
        .wc-mode-modeldecision { background: rgba(179,136,255,0.15); color: #b388ff; }
        .wc-mode-manual      { background: rgba(128,128,128,0.12); color: var(--muted); }
        .wc-mode-ondemand    { background: rgba(204,167,0,0.15); color: #cca700; }
        .wc-chev {
            color: var(--muted); font-size: 11px;
            transition: transform .2s; flex-shrink: 0;
        }
        .wc-group.open .wc-chev { transform: rotate(90deg); }
        .wc-items { max-height: 0; overflow: hidden; transition: max-height .25s ease; }
        .wc-group.open .wc-items { max-height: 1200px; }

        /* Individual workspace item rows */
        .wc-item {
            display: flex; align-items: center; gap: 6px;
            padding: 3px 8px 3px 22px;
            font-size: 11px;
        }
        .wc-item:hover { background: var(--hover); border-radius: 3px; }
        .wc-item-clickable { cursor: pointer; }
        .wc-item-clickable:hover .wc-item-name { color: var(--accent); text-decoration: underline; }
        .wc-item-name {
            flex: 1; color: var(--fg);
            font-family: var(--vscode-editor-font-family, monospace);
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .wc-item-tokens { color: var(--muted); font-size: 10px; flex-shrink: 0; font-family: var(--vscode-editor-font-family, monospace); }
    `;
}
