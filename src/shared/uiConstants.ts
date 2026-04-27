/**
 * UI Constants — Pure values safe for both extension host AND webview bundles.
 * NO Node APIs, NO vscode imports. This file is the SSOT for values
 * shared across the webview ↔ extension boundary.
 */

// ─── UI Percentage Thresholds ───

/** Quota remaining: green ≥ this, yellow below */
export const QUOTA_HEALTHY_PCT = 50;
/** Quota remaining: yellow ≥ this, red below */
export const QUOTA_WARN_PCT = 20;
/** Usage: red ≥ this */
export const USAGE_HIGH_PCT = 80;
/** Usage: yellow ≥ this */
export const USAGE_MEDIUM_PCT = 50;
/** Context window percentage threshold for "warning" state */
export const CTX_WARNING_PCT = 75;
/** Context window percentage threshold for "critical/error" state */
export const CTX_CRITICAL_PCT = 90;

// ─── Rendering Defaults ───

/** Default cascade list render limit */
export const CASCADE_LIST_LIMIT = 20;
/** Default max cascade title length */
export const CASCADE_TITLE_MAX_LEN = 45;
/** Enriched cascade list render limit */
export const CASCADE_ENRICHED_LIMIT = 30;
/** Enriched cascade max title length */
export const CASCADE_ENRICHED_TITLE_MAX_LEN = 55;
/** Hours in a day for chart bucketing */
export const HOURS_IN_DAY = 24;
