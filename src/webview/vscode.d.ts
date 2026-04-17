/**
 * VS Code Webview API type declarations.
 * These types are available globally inside the webview context.
 */

interface VsCodeApi {
    postMessage(message: unknown): void;
    getState(): Record<string, unknown> | undefined;
    setState(state: Record<string, unknown>): void;
}

declare function acquireVsCodeApi(): VsCodeApi;
