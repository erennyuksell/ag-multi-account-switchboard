/**
 * USS (UnifiedStateSync) API accessor — SSOT.
 *
 * Previously duplicated with 3 different patterns:
 * - accountSwitch.ts: typed getUSS() helper
 * - emailResolver.ts: inline (vscode as any).antigravityUnifiedStateSync
 * - extension.ts: inline (vscode as any).antigravityUnifiedStateSync
 *
 * Now all callers import from here.
 */

import * as vscode from 'vscode';
import { USSApi } from '../types';

/** Typed accessor for the IDE's antigravityUnifiedStateSync API */
export function getUSS(): USSApi | null {
    return (vscode as any).antigravityUnifiedStateSync ?? null;
}
