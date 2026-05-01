/**
 * EmailResolver — resolves the active IDE account email.
 * Extracted from QuotaManager to follow Single Responsibility Principle.
 *
 * Strategy: USS API (in-memory) → state.vscdb fallback → empty string.
 */

import * as vscode from 'vscode';
import { USSApi } from '../types';
import { extractStringField } from '../utils/protobuf';
import { createLogger } from '../utils/logger';
import { getUSS } from '../utils/uss';

const log = createLogger('EmailResolver');

export class EmailResolver {
    /** Read active IDE email from USS API or antigravityAuthStatus */
    async getActiveEmail(): Promise<string> {
        try {
            // Try USS API first (in-memory, most accurate)
            const uss = getUSS();
            if (uss?.UserStatus?.getUserStatus) {
                const statusBinary = await uss.UserStatus.getUserStatus();
                if (statusBinary) {
                    const bytes = typeof statusBinary === 'string'
                        ? Buffer.from(statusBinary, 'base64')
                        : Buffer.from(statusBinary);
                    const email = extractStringField(bytes, 7);
                    if (email) return email;
                }
            }
        } catch (e: any) {
            log.warn('USS email read failed:', e?.message);
        }

        try {
            // Fallback: read from antigravityAuthStatus in state.vscdb
            const { dbGet } = require('../shared/db');
            const result = await dbGet('antigravityAuthStatus');
            if (result) {
                try {
                    const parsed = JSON.parse(result);
                    return parsed.email || '';
                } catch { /* expected: protobuf extraction may fail for unknown format */
                    log.warn('Invalid JSON in antigravityAuthStatus');
                }
            }
        } catch (e: any) {
            log.warn('DB email read failed:', e?.message);
        }

        return '';
    }
}

