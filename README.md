# AG Multi-Account Switchboard

**Switch between Antigravity accounts instantly. Monitor AI quotas, token budgets, workspace context — all in one sidebar panel.**

<p align="center">
  <img src="https://raw.githubusercontent.com/erennyuksell/ag-multi-account-switchboard/main/assets/preview.png" alt="AG Multi-Account Switchboard Preview" width="400"/>
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey?logo=apple"/>
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue"/>
  <img alt="Version" src="https://img.shields.io/badge/version-2.0.6-green"/>
</p>

> **🖥️ Platform Support** — macOS is fully tested. Linux and Windows paths are included based on standard Antigravity installation locations and have not been validated yet.

---

## ✨ Features

### 📊 Live Quota Dashboard

Monitor all your AI model quotas at a glance with color-coded progress bars, usage percentages, and reset timers — updated automatically on a configurable schedule.

### 👥 Multi-Account Support

Track unlimited Google accounts simultaneously. Switch between accounts without leaving the IDE. Each account shows its own model quota breakdown.

### ⚡ One-Click Account Switching

Instantly switch your active Antigravity account directly from the panel — no menus, no dialogs.

### ⭐ Pinned Model

Star your preferred model to always show it in the collapsed account header — your most important quota, always visible at a glance.

### 🎛️ Status Bar Integration

Toggle individual models on/off in the status bar. Configure exactly which quotas appear at a glance without opening the panel.

### 🔑 Token Budget Monitoring

See your current token budget usage and workspace context items (rules, skills, workflows) with estimated token costs — directly from the local Antigravity Language Server.

### 🗂️ Workspace Context Panel

View all active `.agent/` context items (rules, skills, workflows) loaded into your current session, their trigger mode (`always-on`, `model-decision`, `manual`), and their estimated token footprint.

### 🔋 AI Credits & Plan Info

See your current plan tier (Ultra, Premium, Free), available AI credits, prompt credits, and flow credits — in context, not buried in a settings page.

### 🔄 Auto-Refresh

Configurable refresh intervals (30s, 1m, 2m, 5m). Automatic detection of external account switches — the panel stays in sync even when you change accounts via the IDE's profile menu.

---

## 🚀 Getting Started

### Requirements

- **Antigravity IDE** (the panel reads quota data from the local Antigravity language server)
- A Google account with Antigravity access for tracked accounts
- macOS, Linux, or Windows

### Installation

1. Install from the **Open VSX Registry** or **Antigravity Extension Marketplace**
2. The **Antigravity** icon appears in the Activity Bar
3. Click it to open the panel — your active account loads automatically

### Adding Tracked Accounts

Click **`+`** in the panel header to add an account via Google OAuth, or click **`🔑`** to add one by pasting a refresh token directly.

---

## 📋 Usage

### Panel Layout

```
┌─────────────────────────────────────────┐
│  ● 4 accounts · 1h 30m reset    ↺  🔑  +│  ← header (collapsed summary)
├─────────────────────────────────────────┤
│  your@account.com  [ACTIVE] [Ultra]     │
│  Claude Opus 4.6 · 60% · 4h 36m    ˅   │  ← expand/collapse
│  CR 24.849  P 500/50K  F 100/150K       │
│                                         │
│  ★ Claude Opus 4.6 (Thinking)   60% ●  │
│  ████████████░░░░░░░░░░░░░░░░░░          │
│  Reset 4h 36m                           │
│                                         │
│  Claude Sonnet 4.6 (Thinking)   60% ○  │
│  ...                                    │
└─────────────────────────────────────────┘
```

| Symbol          | Meaning                                   |
| --------------- | ----------------------------------------- |
| 🟢 Green dot    | Quota > 50% remaining                     |
| 🟡 Yellow dot   | Quota 20–50% remaining                    |
| 🔴 Red dot      | Quota < 20% remaining                     |
| ★ Star (gold)   | Pinned model — shown in collapsed header  |
| ☆ Star (hover)  | Click to pin this model                   |
| ● Toggle (blue) | Model visible in status bar               |

### Commands

| Command                               | Description                            |
| ------------------------------------- | -------------------------------------- |
| `Antigravity: Refresh Quota`          | Manually trigger a quota refresh       |
| `Antigravity: Add Tracked Account`    | Add a new account via Google OAuth     |
| `Antigravity: Add Account via Token`  | Add account by pasting a refresh token |
| `Antigravity: Remove Tracked Account` | Remove a tracked account               |

### Keyboard / Status Bar

Click the status bar item `$(pulse) Antigravity Quota` to trigger an instant refresh.

---

## ⚙️ Configuration

| Setting           | Description                                                                 | Default |
| ----------------- | --------------------------------------------------------------------------- | ------- |
| Refresh interval  | Set via the interval buttons in the panel header (30s / 1m / 2m / 5m)      | `1m`    |
| Pinned model      | Click ☆ star on any model row to pin it                                     | none    |
| Status bar models | Toggle ● switch on each model row                                           | off     |

All preferences (pinned models, selected status bar models, refresh interval) are persisted across IDE restarts.

---

## 🔒 Privacy & Security

- **OAuth tokens** are stored in VS Code's encrypted `SecretStorage` (macOS Keychain / Windows Credential Store / Linux libsecret) — never in plain text.
- Quota data is fetched directly from Google's Antigravity API using your own credentials.
- Token budget and workspace context are read from the local Antigravity Language Server process — no network requests leave your machine for this data.
- No telemetry. No external servers. All data stays local.

---

## 🐛 Known Issues & Troubleshooting

**"Request timed out" on a tracked account**

> The extension automatically retries on multiple API endpoints. If an account consistently shows timeout errors, try removing and re-adding it to refresh the OAuth tokens.

**Panel shows "Server Not Found"**

> Active account quota and token budget data require the local Antigravity Language Server to be running. Tracked account quotas are fetched independently and will still work without the local server.

**Account switch not reflected in the panel**

> The panel watches for external account changes automatically. If it doesn't update within ~1 second, click the refresh button (↺).

**Windows: token budget or workspace context not showing**

> Ensure the Antigravity Language Server is running. On Windows, the extension uses PowerShell for process discovery (wmic fallback for older systems). No additional tools need to be installed.

---

## 📄 License

MIT © [Eren](https://github.com/erennyuksell) — see [LICENSE](LICENSE) for details.

---

<p align="center">
  Built for the Antigravity IDE ecosystem.<br/>
  Made with ☕ by <a href="https://github.com/erennyuksell">Eren</a>
</p>
