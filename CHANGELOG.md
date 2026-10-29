# Changelog

All notable changes to **AG Multi-Account Switchboard** are documented here.

## [3.3.0] — Unreleased

> Compatibility release for **Antigravity 2.5.x and 2.6.x**. 2.5 renamed every install location and changed how the language server takes an account; 2.6 replaced the language server with one agent hub per window and moved account storage out of the IDE. Older builds stay supported: the install layout and the server generation are detected at runtime.

### Platform support for account switching

| Antigravity | macOS | Linux | Windows |
|---|---|---|---|
| 2.0.x / 2.5.x | tested | untested | untested |
| 2.6.x | tested | **not supported yet** | **not supported yet** |

On 2.6 the account lives in the OS credential store. Only the macOS Keychain is written today; on Linux (Secret Service) and Windows (Credential Manager) the hubs keep the previous account. Quotas, Usage Stats and Token Budget work on 2.6 regardless.

### Fixed — Account switching on 2.6 (agent hubs)

- **Switching did nothing on 2.6.** The hubs do not read the account from the IDE's shared state (USS) at all. They read a stored OAuth token — macOS Keychain item `gemini` / `antigravity`, with `~/.gemini/jetski-standalone-oauth-token` as fallback — and only when they start. A switch now writes both, and every window restarts its own hub onto the new account.
- **Hub restarts stay inside the IDE's crash budget.** A hub is restarted through its own `Restart` RPC; the IDE treats that as a crash and allows three recoveries per window per ten minutes. The extension uses at most two and falls back to restarting the window's extension host after that, which has no such limit.
- **Measured:** 4–6 s from click until every hub and every window's panel is on the new account (7 of 7 end-to-end checks, including two windows switching 1.5 s apart and a switch past the restart budget).

### Fixed — Account switching on 2.5 ([#10](https://github.com/erennyuksell/ag-multi-account-switchboard/issues/10))

- **Switches took 30–50 s or never landed.** Antigravity restarts a window's language server when the email in USS changes, and the new server reads the OAuth token at spawn. The extension now writes the token first and the email second, which triggers that restart immediately.
- **Restarted servers came back on an old account.** A new language server asks its window for the current token and gets the snapshot taken when the window opened, sometimes days earlier. The extension re-broadcasts the credentials after the restart, with a value that differs each round so the IDE forwards it as a live update.
- **"No models available" after a switch.** The extension used to overwrite the IDE's cached user record (which holds the model list) with a three-field stub. It now changes only the name and email in the existing record, so the model picker never empties.
- **A switch is confirmed only when every window's server is on the new account**, not the first one that answers.
- **Endpoint discovery missed servers** that do not advertise `--https_server_port`; listening sockets are now scanned. The confirmation poll is paced instead of flooding the server it waits on.

### Fixed — Account switching, all versions

- **A token stored under the wrong account is refused.** Before switching, the token's owner is checked with Google; a mismatch is reported instead of silently switching the IDE to someone else.
- **Switching to the account already in use** reports "Already on …" instead of running the whole flow and claiming a switch.
- **A switch superseded by a newer one** (same window or another window) stops quietly instead of waiting out its timeout and showing a warning.

### Fixed — Panel

- **Other windows' panels lagged by a minute or more after a switch.** Every window heard the change at the same moment, the cross-window refresh lock let one through, and the rest waited for their next poll. Windows now draw the new account at once and refresh their local quota when their own server catches up.
- **Panels stayed empty after starting the IDE** in all but one window, for the same lock. A window's first load no longer waits on it.
- **"Connecting to Antigravity…" could sit for a minute on startup**, waiting for the slowest tracked account. Accounts render immediately; each account's refresh has a 12 s deadline and keeps its last reading if it overruns.
- **Old or missing readings looked like live data.** Cards show `LOADING` before the first fetch and `Xm AGO` when a refresh could not update them.
- **The ACTIVE badge followed the request, not the IDE.** It now follows the account the IDE is actually on; a pending switch shows `SWITCHING` on its target.
- **The model list in an account card could not be scrolled** ([#11](https://github.com/erennyuksell/ag-multi-account-switchboard/issues/11)). Expanded lists were capped at 900 px with the overflow hidden, which cut off the last models of a tracked account (13+ rows). They are now capped relative to the panel height and scroll. The same applied to Token Budget's skill, MCP tool and workspace lists.

### Fixed — Usage Stats and Token Budget

- **Install layout detection.** 2.5 moved data to `~/.gemini/antigravity-ide` and the app to `Antigravity IDE`; 2.6 kept the app name but moved data back to `~/.gemini/antigravity`. The app and the data directory are now resolved separately, from whichever install was written to most recently. Override with `AG_PANEL_PROFILE` if detection picks wrong.
- **Usage Stats stopped counting on 2.6** (measured: 2 calls shown for a day with 500). Changed conversations are detected by step count, and both former sources went blank on 2.6. The conversation list, titles and step counts are now read from 2.6's own index, `conversation_summaries.db`.
- **Token Budget's workspace section was empty on 2.6.** The hubs return nothing for the workspace rules/skills/workflows query; those are now read from `.agents/` and `.agent/` on disk when the server returns nothing.
- **Conversation Guard is off on 2.6.** It compared against an index 2.6 no longer maintains, so it reported conversations as missing and offered a fix that would rewrite a table 2.6 does not read.

### Changed — Quota view

- **Internal models are filtered out** (addresses [#7](https://github.com/erennyuksell/ag-multi-account-switchboard/pull/7)): `chat_<id>`, `tab_*`, and `-agent` / `-tiered` variants. A blocklist rather than an allowlist, so newly released models still appear.
- **Effort tiers collapse into one row** with an `L·M·H` chip when they share the same percentage and reset time; a tier that diverges gets its own row again.

### Added

- **Copy sign-in link** ([#8](https://github.com/erennyuksell/ag-multi-account-switchboard/issues/8)). Adding an account asks whether to open the default browser or copy the Google sign-in link, so it can be opened in a specific browser or Chrome profile. The wait for sign-in now shows a cancellable notification.
- **Remote SSH** ([#9](https://github.com/erennyuksell/ag-multi-account-switchboard/issues/9)): the extension is pinned to run on the local machine (`extensionKind: ui`), where the IDE's account data lives. Untested; local quota from a server on the remote host is not expected to appear.
- **`ag-switchboard.devControl`** (off by default): a file-based control channel used to test switching end to end without manual reloads.
- **Diagnostic logging of raw quota buckets** under `ag-switchboard.diagnosticMode`.

## [3.2.1] — 2026-05-04

> First 3.2.x marketplace release. Includes the 3.2.0 Conversation Guard release plus the Usage Stats accuracy fixes below.

### Fixed
- **Usage Stats duplicate counting** — Deduplicates model responses by stable `responseId` when Antigravity exposes the same usage telemetry through both generator metadata and trajectory steps.
- **Usage Stats total token semantics** — Total Tokens now consistently includes input, cache read, cache write, output, and reasoning tokens across sidebar KPIs, full dashboard cards, model totals, and conversation totals.
- **Usage Stats cache rebuild** — Bumped the disk cache schema to v2 so old fingerprint-based caches are discarded and rebuilt with response-aware entries.
- **Usage Stats refresh lifecycle** — The full Usage Statistics editor panel now receives refresh pushes from quota refreshes instead of staying stale until reopened.
- **Usage Stats monthly filters** — Monthly summaries use bounded date filtering and pure aggregation so switching ranges does not mutate cached totals.
- **Footer build number placement** — Build tags render in the footer build badge instead of drifting into the updated timestamp.
- **Quota 100% display bug** — Restored `projectId` parameter in `retrieveUserQuota` API call. Without it, Google returned generic empty buckets showing 100% for all models. (via [#3](https://github.com/erennyuksell/ag-multi-account-switchboard/pull/3) by [@ameenalasady](https://github.com/ameenalasady))

### Changed
- **Usage Stats entry preference** — When the same response appears in multiple local sources, generator metadata is preferred over step snapshots because it carries the canonical token accounting.
- **Model whitelist removed** — All models returned by the API are now displayed, not just hardcoded ones. Unknown model IDs are auto-humanized (`gemini-3.1-pro-high` → `Gemini 3.1 Pro (High)`). The old `MODEL_WHITELIST` is now `MODEL_DISPLAY_NAMES` — a cosmetic override map, not a filter.

## [3.2.0] — 2026-05-01

### Added
- **Conversation Guard** — Detects conversations that exist on disk (`.pb` files) but are missing from the sidebar index. Shows an expandable warning banner with conversation titles and dates, with a one-click fix that rebuilds the index.
- **Detached fix worker** — Index rebuild runs as a standalone Node.js process after AG quits, then auto-relaunches the IDE with the same workspace. Handles WAL checkpoint, backup, and cross-platform app discovery (macOS, Linux, Windows).
- **Protobuf codec** — Pure TypeScript varint encoder/decoder, field stripper, and entry builder. Shared between extension host and detached worker with zero external dependencies.
- **Title resolver** — Multi-source title extraction (LS trajectory → brain markdown → transcript log → date-based fallback). Filters generic auto-titles like "New Conversation".
- **Cross-platform path SSOT** — `agPaths.ts` centralizes all platform-specific filesystem paths (state DB, conversations dir, cert paths, LS binary name) for macOS/Linux/Windows.
- **`ag.fixConversations` command** — Command palette entry + footer wrench button for manual fix trigger.

### Changed
- **Constants refactor** — Platform paths and process detection patterns moved from `constants.ts` to `shared/agPaths.ts` (vscode-free, worker-safe).

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
