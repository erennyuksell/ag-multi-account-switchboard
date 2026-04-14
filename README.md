# AG Multi-Account Switchboard

**Switch between Antigravity accounts instantly. Monitor AI quotas, token budgets, and reset timers — all in one sidebar panel.**

<p align="center">
  <img src="https://raw.githubusercontent.com/erennyuksell/ag-multi-account-switchboard/main/assets/preview.png" alt="AG Multi-Account Switchboard Preview" width="400"/>
</p>

---

## ✨ Features

### 📊 Live Quota Dashboard

Monitor all your AI model quotas at a glance with color-coded progress bars, usage percentages, and reset timers — all updated automatically.

### 👥 Multi-Account Support

Track up to unlimited Google accounts simultaneously. Switch between accounts without leaving the IDE. Each account shows its own model quota breakdown.

### ⚡ One-Click Account Switching

Instantly switch your active Antigravity account directly from the panel — no menus, no dialogs.

### ⭐ Pinned Model

Star your preferred model to always show it in the collapsed header view — your most important quota, always visible.

### 🎛️ Status Bar Integration

Toggle individual models on/off in the status bar. Configure exactly which quotas appear at a glance.

### 🔑 Token Budget Monitoring

Track your token consumption alongside quota usage for complete AI spend visibility.

### 🔋 AI Credits & Plan Info

See your current plan tier (Ultra, Premium, Free), available AI credits, prompt credits, and flow credits — in context, not buried in a settings page.

### 🔄 Auto-Refresh

Configurable refresh intervals (30s, 1m, 5m, 10m, 30m). Automatic detection of external account switches — the panel stays in sync even when you change accounts via the IDE's profile menu.

---

## 🚀 Getting Started

### Requirements

- **macOS only** — Windows and Linux support is planned
- **Antigravity IDE** (the panel reads quota data from the local Antigravity server)
- For tracked accounts: a Google account with Antigravity access

### Installation

1. Install from the **Antigravity Extension Marketplace**
2. The **Antigravity** icon appears in the Activity Bar
3. Click it to open the Quota panel — your active account loads automatically

### Adding Accounts

Click **`+`** in the panel header to add a tracked account via Google OAuth, or use **`🔑`** to add by refresh token.

---

## 📋 Usage

### Panel Layout

```
┌─────────────────────────────────────────┐
│  ● 4 accounts · 1h 30m reset    ↺  🔑  +│  ← header (collapsed summary)
├─────────────────────────────────────────┤
│  your@account.com  [ACTIVE] [Ultra]    │
│  Claude Opus 4.6 · 60% · 4h 36m    ˅  │  ← expand/collapse
│  CR 24.849  P 500/50K  F 100/150K      │
│                                         │
│  ★ Claude Opus 4.6 (Thinking)   60% ●  │
│  ████████████░░░░░░░░░░░░░░░░░░         │
│  Reset 4h 36m                           │
│                                         │
│  Claude Sonnet 4.6 (Thinking)   60% ○  │
│  ...                                    │
└─────────────────────────────────────────┘
```

| Symbol          | Meaning                                  |
| --------------- | ---------------------------------------- |
| 🟢 Green dot    | Quota > 50% remaining                    |
| 🟡 Yellow dot   | Quota 20–50% remaining                   |
| 🔴 Red dot      | Quota < 20% remaining                    |
| ★ Star (gold)   | Pinned model — shown in collapsed header |
| ☆ Star (hover)  | Click to pin this model                  |
| ● Toggle (blue) | Model visible in status bar              |

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

| Setting           | Description                                                                  | Default |
| ----------------- | ---------------------------------------------------------------------------- | ------- |
| Refresh interval  | Set via the interval buttons in the panel header (30s / 1m / 5m / 10m / 30m) | `60s`   |
| Pinned model      | Click ☆ star on any model row to pin it                                      | none    |
| Status bar models | Toggle ● switch on each model row                                            | off     |

All preferences (pinned models, selected status bar models, refresh interval) are persisted across restarts.

---

## 🔒 Privacy & Security

- **OAuth tokens** are stored in VS Code's encrypted `SecretStorage` — never in plain text.
- Quota data is fetched directly from Google's Antigravity API using your own credentials.
- No telemetry. No external servers. All data stays local.

---

## 🐛 Known Issues & Troubleshooting

**"Request timed out" on a tracked account**

> The extension automatically retries on multiple API endpoints. If an account consistently shows timeout errors, try removing and re-adding it to refresh the OAuth tokens.

**Panel shows "Server Not Found"**

> The active account quota requires the local Antigravity server to be running. Tracked account quotas are fetched independently and will still work.

**Account switch not reflected in the panel**

> The panel watches for external account changes automatically. If it doesn't update within ~1 second, click the refresh button (↺).

---

## 📄 License

MIT © [Eren](https://github.com/erennyuksell) — see [LICENSE](LICENSE) for details.

---

<p align="center">
  Built for the Antigravity IDE ecosystem.<br/>
  Made with ☕ by <a href="https://github.com/erennyuksell">Eren</a>
</p>
