/**
 * EmailResolver — resolves the active IDE account email.
 * Extracted from QuotaManager to follow Single Responsibility Principle.
 *
 * Strategy: USS API (in-memory) → sqlite3 DB fallback → empty string.
 */

import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { USSApi } from '../types';
import { extractStringField } from '../utils/protobuf';
import { STATE_DB_PATH } from '../constants';
import { createLogger } from '../utils/logger';
import { getUSS } from '../utils/uss';

const execAsync = promisify(exec);
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
            const sql = "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus';";
            const { stdout } = await execAsync(`sqlite3 "${STATE_DB_PATH}" "${sql}"`, {
                timeout: 5000,
            });
            const result = stdout.trim();
            if (result) {
                try {
                    const parsed = JSON.parse(result);
                    return parsed.email || '';
                } catch {
                    log.warn('Invalid JSON in antigravityAuthStatus');
                }
            }
        } catch (e: any) {
            log.warn('DB email read failed:', e?.message);
        }

        return '';
    }
}
