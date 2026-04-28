# Changelog

All notable changes to **AG Multi-Account Switchboard** are documented here.

## [3.1.1] — 2026-04-28

### Fixed
- **Cross-window state contamination** — Multiple IDE windows no longer overwrite each other's active conversation. Each window uses `workspaceState` for per-workspace cascade persistence.
- **Focus-gain listener bug** — Removed listener that could pick up stale cascade IDs from other windows' USS entries on alt-tab.
- **Disposable leak** — `topic.onDidChange()` subscriptions are now properly registered for disposal.
- **Boot poll snapshot inconsistency** — Boot polling now uses `readCascadeDiff()` to keep the internal snapshot in sync with runtime.
- **trajectorySummaries fallback persistence** — Fallback cascade assignment now writes to `workspaceState`.
- **Log severity** — Error conditions upgraded from `log.info()` to `log.warn()`.

### Changed
- **Quota API endpoint** — Migrated to `retrieveUserQuota` gRPC-transcoded endpoint with strict model whitelist.
- **USS event gating** — `onDidChange` events are only processed when `vscode.window.state.focused` is true.

## [3.1.0] — 2026-04-24

### Added
- **Cross-source pin matching** — Pinned models persist correctly across local/tracked accounts via host-side label map.
- **Host-managed quota polling** — Quota refresh via `setInterval`, ensuring data stays fresh regardless of sidebar visibility.
- **Cost per token in daily grid** — Heatmap cells show estimated cost alongside token counts.
- **Diagnostic logging harness** — DIAG-level logging with file sink for field debugging.
- **Build tag tracking** — Footer shows incremental build identifiers.

### Changed
- **Account card builder refactor** — Pure-function card builder module with zero side effects.
- **Anti-magic constants** — All UI thresholds, timeouts, and API URLs extracted to named constants.

## [3.0.0] — 2026-04-14

### Added
- **Context Window Detail** — Full editor panel with raw token breakdown.
- **Active Context sidebar** — Donut chart with category-colored stacked bar.
- **Export Markdown** — One-click conversation export.
- **LiveStream Watcher** — Real-time context window updates during model execution.
- **RPC Direct Client** — JSON-over-HTTP calls to local LS.
- **Reasoning tokens** — Tracks reasoning tokens alongside input/cache/output.
- **Monthly cost breakdown**, **Weekly pattern**, **Top conversations**.
- **Dual-LS Architecture** — Automatic discovery of Workspace LS + Global LS.
- **Server Discovery rewrite** — PID-based process scanning with `lsof` port resolution.
- **Account Switch Hardening** — LS Readiness Gate, Gate-Once-Pass-Down endpoint reuse.
- **Proactive Token Renewal** — Automatic access_token refresh before expiry.

## [2.3.0] — 2026-03-20

### Added
- **Usage Stats Dashboard** with sidebar compact view + full editor tab.
- 9 KPI cards, estimated cost per model, smart model merging.
- PostMessage architecture for detail panel DOM patching.

## [2.2.0] — 2026-03-10

### Added
- **Deep usage stats** — All-time token usage analytics with disk caching.
- **Bento grid layout**, **GitHub contribution grid**, **Progressive loading**.

## [2.1.0] — 2026-02-28

### Added
- **Branded init screen** with radar pulse animation.
- **Sticky layout** — Header and footer pinned.
- **Modular webview architecture** with esbuild bundling.

### Fixed
- Race condition in pending refresh queue.
