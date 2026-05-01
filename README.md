# AG Multi-Account Switchboard

**The missing control panel for Antigravity IDE — switch accounts instantly, monitor AI quotas in real time, drill into token budgets, and track usage costs across every conversation you've ever had.**

<table align="center">
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/erennyuksell/ag-multi-account-switchboard/main/assets/preview.png" alt="Accounts" width="400"/><br/><sub><b>Accounts</b></sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/erennyuksell/ag-multi-account-switchboard/main/assets/token-budget.png" alt="Token Budget" width="176"/><br/><sub><b>Token Budget</b></sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/erennyuksell/ag-multi-account-switchboard/main/assets/usage-sidebar.png" alt="Usage Stats" width="177"/><br/><sub><b>Usage Stats</b></sub></td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/erennyuksell/ag-multi-account-switchboard/main/assets/context-detail.png" alt="Context Detail" width="280"/><br/><sub><b>Context Detail</b></sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/erennyuksell/ag-multi-account-switchboard/main/assets/usage-panel-1.png" alt="Dashboard Top" width="282"/><br/><sub><b>Dashboard Top</b></sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/erennyuksell/ag-multi-account-switchboard/main/assets/usage-panel-2.png" alt="Dashboard Bottom" width="282"/><br/><sub><b>Dashboard Bottom</b></sub></td>
  </tr>
</table>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey?logo=apple"/>
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue"/>
  <img alt="Version" src="https://img.shields.io/badge/version-3.2.1-green"/>
</p>

> **🖥️ Platform Support** — macOS is fully tested. Linux and Windows paths are included based on standard Antigravity installation locations and have not been validated yet.

---

## ✨ Features at a Glance

The panel has **three tabs** in the sidebar — Accounts, Token Budget, and Usage Stats — plus a full-width **Context Window Detail** editor panel accessible via "See All →".

---

### 📊 Accounts — Live Quota Dashboard

Monitor all your AI model quotas at a glance. Each account shows color-coded progress bars, usage percentages, and reset timers — updated automatically on a configurable schedule (30s / 1m / 2m / 5m).

- **Multi-account tracking** — Unlimited Google accounts monitored simultaneously
- **One-click switching** — Instantly switch your active IDE account from the panel, no menus or dialogs
- **Pinned model** — Star your most-used model to always show it in the collapsed account header
- **Status bar toggles** — Choose which quotas appear in the IDE status bar
- **AI Credits & Plan Info** — See your tier (Ultra, Premium, Free), AI credits, prompt credits, and flow credits
- **Auto-sync** — Detects external account switches from the IDE's profile menu within ~1 second
- **Proactive token renewal** — Automatic access_token refresh before expiry, preventing 401s during long sessions

---

### 🔑 Token Budget — Context Window Intelligence

See exactly what's consuming your context window — live, per-category, with drill-down to individual items.

<p align="center">
  <img src="https://raw.githubusercontent.com/erennyuksell/ag-multi-account-switchboard/main/assets/token-budget.png" alt="Token Budget Panel" width="380"/>
</p>

**Context Budget** — Donut chart showing customization token usage (MCP Tools, Rules, Workflows, Skills) with collapsible category breakdowns. MCP servers expand to show per-tool token costs.

**Active Context** — Real-time view of the current conversation's context window:

- Donut chart with used/total tokens and percentage
- Category-colored stacked bar (System Prompt, Tools, MCP, User Input, Model Response, File Reads, etc.)
- Per-category breakdown with item counts, token values, and percentages
- Completion config badges: Max Output, Temperature, TopK, TopP
- **"See All →"** button opens the full Context Window Detail panel

**Workspace Context** — All `.agent/` items loaded in the current session: rules, skills, and workflows with trigger modes (`always-on`, `model-decision`, `manual`) and estimated token footprints. Click any item to open it in the editor.

---

### 🔍 Context Window Detail — Full Editor Panel

A dedicated editor tab for deep context window analysis. Click **"See All →"** from the sidebar to open.

<p align="center">
  <img src="https://raw.githubusercontent.com/erennyuksell/ag-multi-account-switchboard/main/assets/context-detail.png" alt="Context Window Detail" width="700"/>
</p>

- **Collapsible tree view** — Every token group (System Prompt, Tools, MCP Tools, Chat Messages) with children and sub-children, each showing token count and percentage
- **Step preview** — Click any chat step (User Input, Model Response, Command, Code Edit, MCP Tool call) to preview its content inline
- **Filter toolbar** — Quick filters for All, User, Model, Tools, Files
- **Expand / Collapse All** — Toggle the entire tree in one click
- **Export Markdown** — One-click conversation export with Copy to Clipboard and Save As options
- **Live updates** — Auto-refreshes during active model execution via LiveStream watcher
- **🔥 badges** — Heaviest token consumers are flagged for quick identification

---

### 🛡️ Conversation Guard — Lost Conversation Recovery

Antigravity can silently lose conversations from the sidebar after crashes or multi-window usage. The Conversation Guard detects these orphaned conversations by comparing `.pb` files on disk against the sidebar index, and offers a one-click fix.

- **Automatic detection** — Runs 15 seconds after startup, comparing disk state vs. sidebar index
- **Expandable warning banner** — Shows exactly which conversations are missing, with resolved titles and dates
- **One-click fix** — Spawns a detached worker that rebuilds the sidebar index after AG quits, then auto-relaunches the IDE
- **Title resolution** — Recovers conversation titles from LS trajectory data, brain markdown files, or transcript logs
- **Safe** — Creates a backup before modifying the index. Existing metadata (titles, timestamps) is preserved.

---

### 📈 Usage Stats — Deep Token Analytics

Track token usage and estimated costs across **every** Antigravity conversation you've ever had. Data is cached to disk for instant load.

**Sidebar (compact dashboard):**

<p align="center">
  <img src="https://raw.githubusercontent.com/erennyuksell/ag-multi-account-switchboard/main/assets/usage-sidebar.png" alt="Usage Stats Sidebar" width="380"/>
</p>

- Hero KPIs: Total Tokens + Estimated Cost
- Token breakdown chips: Input, Cache, Output, Reasoning
- Time range selector (24h / 7d / 30d / All Time)
- Activity heatmap (GitHub contribution style) or hourly pattern (24h mode)
- Top models with stacked token bars
- Monthly cost breakdown with Input/Cache/Output bars

**Full dashboard (editor tab) — click "Open Full Dashboard →":**

<p align="center">
  <img src="https://raw.githubusercontent.com/erennyuksell/ag-multi-account-switchboard/main/assets/usage-panel-1.png" alt="Usage Stats Full Dashboard — Top" width="700"/>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/erennyuksell/ag-multi-account-switchboard/main/assets/usage-panel-2.png" alt="Usage Stats Full Dashboard — Bottom" width="700"/>
</p>

- 9 KPI cards: Input, Cache, Output, Total, API Calls, Est. Cost, Days Active, Avg/Call, Cache Rate
- Model distribution with per-model token breakdowns
- Activity contribution grid with peak day indicator
- Weekly pattern (Mon–Sun) with weekday/weekend split
- Monthly stacked bar chart with yearly cost totals
- Estimated API cost table per model (Input, Cache, Output, Reasoning, Total)
- Top conversations ranked by cost

---

## 🏗️ Architecture

The extension communicates with **two local Language Server instances** that the Antigravity IDE runs:

| Component | Source | Data |
|-----------|--------|------|
| **Workspace LS** | `--workspace_id` process | Quota, token budget, workspace context |
| **Global LS** | No workspace_id | Cascade trajectory, context window, stream updates |

Server discovery uses PID-based process scanning with `lsof` port resolution (macOS/Linux) or `PowerShell`/`netstat` (Windows). Workspace isolation via `--workspace_id` filtering prevents wrong-LS contamination.

For account switching, the extension uses a **Readiness Gate** (Kubernetes-style probe) to ensure the LS has reconnected its USS IPC channel before sending `registerGdmUser`, preventing silent stale-credential issues.

---

## 🚀 Getting Started

### Requirements

- **Antigravity IDE** (reads data from the local Language Server)
- A Google account with Antigravity access
- macOS, Linux, or Windows

### Installation

1. Install from the **Open VSX Registry** or **Antigravity Extension Marketplace**
2. The **Antigravity** icon appears in the Activity Bar
3. Click it to open the panel — your active account loads automatically

### Adding Accounts

| Button | Action |
|--------|--------|
| **`+`** | Add account via Google OAuth |
| **`🔑`** | Add account by pasting a refresh token |

---

## 📋 Quick Reference

### Panel Controls

| Symbol | Meaning |
|--------|---------|
| 🟢 Green dot | Quota > 50% remaining |
| 🟡 Yellow dot | Quota 20–50% remaining |
| 🔴 Red dot | Quota < 20% remaining |
| ★ Gold star | Pinned model — shown in collapsed header |
| ☆ Outline star | Click to pin this model |
| ● Blue toggle | Model visible in status bar |

### Commands

| Command | Description |
|---------|-------------|
| `AG Switchboard: Refresh Quota` | Manually trigger a quota refresh |
| `AG Switchboard: Add Account` | Add via Google OAuth |
| `AG Switchboard: Add Account via Token` | Add by pasting a refresh token |
| `AG Switchboard: Remove Account` | Remove a tracked account |
| `AG Switchboard: Open Usage Statistics` | Open the full usage dashboard |
| `AG Switchboard: Fix Missing Conversations` | Detect and fix orphaned conversations |

### Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| Refresh interval | Set via header buttons (30s / 1m / 2m / 5m) | `1m` |
| Pinned model | Click ☆ on any model row | none |
| Status bar models | Toggle ● switch on each model | off |
| `ag-switchboard.modelPricing` | Per-model pricing for cost estimation (per 1M tokens) | Built-in defaults |

---

## 🔒 Privacy & Security

- **OAuth tokens** stored in VS Code's encrypted `SecretStorage` (macOS Keychain / Windows Credential Store / Linux libsecret)
- Quota data fetched directly from Google's Antigravity API using your own credentials
- Token budget, context window, and workspace context read from the **local** Language Server — no network requests leave your machine
- Usage stats aggregated from local conversation data on disk
- **No telemetry. No external servers. All data stays local.**

---

## 🐛 Troubleshooting

| Issue | Fix |
|-------|-----|
| **"Request timed out"** on a tracked account | Remove and re-add the account to refresh OAuth tokens |
| **"Server Not Found"** | Ensure the Antigravity Language Server is running. Tracked account quotas work independently |
| **Account switch not reflected** | The panel watches for changes automatically. If delayed, click ↺ |
| **Context window empty** | The Dual-LS discovery may need a moment. Click Refresh or wait for auto-sync |
| **Windows: token budget not showing** | Ensure LS is running. The extension uses PowerShell for process discovery |
| **Missing conversations** | The Conversation Guard auto-detects this. Click "Fix Now" in the warning banner, or run `AG Switchboard: Fix Missing Conversations` from the command palette |

---

## 📝 Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full release history.

---

## 📄 License

MIT © [Eren](https://github.com/erennyuksell) — see [LICENSE](LICENSE) for details.

---

<p align="center">
  Built for the Antigravity IDE ecosystem.<br/>
  Made with ☕ by <a href="https://github.com/erennyuksell">Eren</a>
</p>
