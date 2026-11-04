/**
 * Antigravity 2.6+ hub keyring access.
 *
 * The hub authenticates from the OS keyring item (`service=gemini`,
 * `username=antigravity`), not from USS. A running hub re-reads that item
 * when `GetAuthStatus` is called, so writing it is what actually switches
 * the hub's account — no restart needed.
 *
 * Linux uses libsecret's `secret-tool`. macOS/Windows have no verified
 * writer here, so callers keep the legacy USS-only behavior.
 */

import { execFile } from 'child_process';

export interface HubKeyringToken {
    email: string;
    accessToken: string;
    refreshToken: string;
    expiryTimestamp: number;
}

/** Persist the token JSON the hub expects. Returns false when unavailable. */
export function writeHubKeyringToken(token: HubKeyringToken): Promise<boolean> {
    if (process.platform !== 'linux') return Promise.resolve(false);

    const payload = JSON.stringify({
        token: {
            access_token: token.accessToken,
            token_type: 'Bearer',
            refresh_token: token.refreshToken,
            expiry: new Date(token.expiryTimestamp * 1000).toISOString(),
            expires_in: Math.max(0, token.expiryTimestamp - Math.floor(Date.now() / 1000)),
        },
        auth_method: 'consumer',
        id_token_email: token.email,
    });

    return new Promise(resolve => {
        const child = execFile(
            'secret-tool',
            [
                'store', '--label', "Password for 'antigravity' on 'gemini'",
                'service', 'gemini', 'username', 'antigravity',
            ],
            { timeout: 5_000 },
            err => resolve(!err),
        );
        // Secret goes through stdin, never argv.
        child.stdin?.end(payload);
    });
}
