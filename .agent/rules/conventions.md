# Coding Conventions

## TypeScript

- Strict mode enabled (`tsconfig.extension.json`)
- Use `interface` over `type` for object shapes in `types.ts`
- All service classes use constructor injection where possible
- Use `readonly` for properties that shouldn't change after construction
- Prefer `const` assertions for literal objects

## Error Handling

- Services should catch and log errors internally — never let unhandled rejections crash the extension
- Use `createLogger('ServiceName')` for scoped logging
- Network errors (LS communication) should fail gracefully with fallback UI states

## Webview

- No external dependencies in webview code — everything is vanilla JS
- String concatenation for HTML building (no template literals with complex logic)
- All user-facing numbers go through `fmtNum`, `fmtBig`, or `fmtK` helpers
- Percentages use `pctClass` or `dotClass` for color coding
- Every interactive element needs a `data-action` attribute for the message handler

## Build

- Extension host: `tsc` via `tsconfig.extension.json`
- Webview: `esbuild.webview.mjs` bundles JS and copies CSS
- Package: `vsce package` creates the VSIX
- Publish: `ovsx publish` to Open VSX Registry

## Git

- Commit format: `type: description` (feat, fix, chore, refactor, release)
- Push to `main` branch directly (single maintainer workflow)
