# AG Multi-Account Switchboard — Architecture Rules

## Project Overview

VS Code extension for the Antigravity IDE. Monitors AI model quotas across multiple Google accounts, provides token budget visibility, context window analysis, and usage analytics — all from a single sidebar panel.

**Stack:** TypeScript, VS Code Extension API, esbuild (webview bundling)

## Directory Structure

```
src/
├── extension.ts          # Activation entry point, registers providers & commands
├── constants.ts          # API endpoints, OAuth client IDs, platform paths
├── types.ts              # Shared type definitions (ServerInfo, AccountCard, etc.)
├── managers/
│   └── quotaManager.ts   # Central orchestrator — polls quotas, builds account cards, coordinates all services
├── providers/
│   ├── quotaViewProvider.ts   # Sidebar webview provider (3 tabs: Accounts, Token Budget, Usage Stats)
│   └── contextDetailPanel.ts  # Full-width editor panel for context window drill-down
├── services/
│   ├── accountSwitch.ts       # Account switching lifecycle (LS readiness gate, USS sync)
│   ├── serverDiscovery.ts     # PID-based LS discovery (Workspace LS vs Global LS)
│   ├── contextWindow.ts       # Context window metadata from Global LS
│   ├── contextDetailService.ts # Trajectory step parsing and markdown export
│   ├── liveStream.ts          # Real-time stream for context updates during inference
│   ├── rpcDirectClient.ts     # JSON-over-HTTP client for LS communication
│   ├── googleAuth.ts          # OAuth token management
│   ├── quotaApi.ts            # Google quota API calls
│   ├── tokenBase.ts           # Token storage and renewal
│   ├── statusBar.ts           # Status bar quota indicators
│   ├── litellmPricing.ts      # Per-model cost estimation
│   ├── emailResolver.ts       # Active account email resolution
│   └── usage/                 # Usage analytics aggregation, caching, rendering
├── shared/                    # Pure helper functions shared between extension host and webview
├── templates/                 # Webview HTML template builder
├── utils/                     # Logger, crypto, platform helpers
└── webview/
    ├── message-handler.ts     # Webview → extension message routing
    └── renderers/             # Tab-specific DOM renderers (accounts, tokens, usage, workspace)
```

## Critical Architecture Patterns

### Dual-LS Architecture
The extension communicates with TWO Language Server instances:
- **Workspace LS** — Has `--workspace_id` flag. Source for: quota, token budget, workspace context
- **Global LS** — No workspace flag. Source for: cascade trajectory, context window, stream updates

**Never mix them.** `serverDiscovery.ts` handles discovery via PID-based process scanning + `lsof` port resolution.

### Gate-Once-Pass-Down (Account Switching)
When switching accounts, the LS needs time to reconnect USS IPC. The Readiness Gate probes `GetUserStatus` until the LS confirms it's ready. Once the gate passes, subsequent operations reuse the validated endpoint — no redundant discovery.

### Webview Rendering
- Webview uses **vanilla JS/HTML** — no framework
- All rendering is done via string concatenation in `renderers/*.ts`
- State is passed from extension host via `postMessage` — renderers are pure functions
- CSS is in `src/webview/styles/` and bundled by `esbuild.webview.mjs`
- CSP is enforced with nonce-based script tags

### Usage Stats Pipeline
`usage/aggregator.ts` → scans conversation DB files on disk
`usage/cache.ts` → SQLite-level disk cache with process lock
`usage/index.ts` → orchestrates aggregation with incremental refresh

## Rules

1. **Never import vscode in shared/** — shared modules run in both extension host AND webview contexts
2. **Never use `fetch` in extension host** — use Node.js `http`/`https` modules (VS Code restricts fetch)
3. **Always use `createLogger`** — never raw `console.log`
4. **Token storage uses SecretStorage** — never store tokens in settings or plain files
5. **Platform-aware paths** — always check `process.platform` for macOS/Linux/Windows differences in `constants.ts`
6. **Webview renderers must preserve DOM state** — save open/collapsed states before innerHTML replacement and restore after
7. **Context window data comes from Global LS only** — never fetch it from Workspace LS
8. **Usage aggregation must acquire process lock** — prevents corruption from multiple extension instances
