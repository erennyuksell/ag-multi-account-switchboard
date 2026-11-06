import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import {
    CLIENT_ID, CLIENT_SECRET, TOKEN_URL, AUTH_URL,
    USERINFO_URL, OAUTH_SCOPES, OAUTH_CALLBACK_TIMEOUT_MS,
} from '../constants';
import { getOAuthSuccessHtml } from '../templates/oauthSuccess';
import { createLogger } from '../utils/logger';

/** Timeout for Google API HTTP requests (userinfo, token exchange) */
const GOOGLE_API_TIMEOUT_MS = 10_000;
import { collectBody } from '../utils/http';

const log = createLogger('GoogleAuth');

export type OAuthLaunchMode = 'open' | 'copy';

async function pickLaunchMode(): Promise<OAuthLaunchMode | undefined> {
    const picked = await vscode.window.showQuickPick([
        { label: '$(link-external) Open in default browser', mode: 'open' as const },
        {
            label: '$(clippy) Copy sign-in link',
            description: 'paste it into a specific browser or profile',
            mode: 'copy' as const,
        },
    ], { title: 'Add Google account', placeHolder: 'How do you want to sign in?' });
    return picked?.mode;
}

export class GoogleAuthService {
    /** Sign-in URL of the most recent flow (dev control channel only). */
    lastAuthUrl = '';


    /** Exchange an authorization code for access + refresh tokens */
    async exchangeCode(code: string, redirectUri: string): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
        const body = new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
        }).toString();

        return this.postForm(TOKEN_URL, body);
    }

    /** Refresh an expired access token using the stored refresh token */
    async refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
        const body = new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
        }).toString();

        return this.postForm(TOKEN_URL, body);
    }

    /** Fetch Google user profile (email, name) */
    async fetchUserInfo(accessToken: string): Promise<{ email: string; name: string }> {
        return new Promise((resolve, reject) => {
            const req = https.get(USERINFO_URL, {
                headers: { Authorization: `Bearer ${accessToken}` },
                timeout: GOOGLE_API_TIMEOUT_MS,
            }, async (res) => {
                try {
                    const { status, body } = await collectBody(res);
                    if (status === 200) {
                        resolve(JSON.parse(body));
                    } else {
                        reject(new Error(`UserInfo failed: HTTP ${status}`));
                    }
                } catch (e) { reject(e); }
            });
            req.on('error', reject);
        });
    }

    /**
     * Full OAuth2 flow: open browser → local callback server → capture tokens.
     * Returns the raw token response and user info, or null on cancel/timeout.
     */
    async startOAuthFlow(opts: { mode?: OAuthLaunchMode } = {}): Promise<{
        tokens: { access_token: string; refresh_token: string; expires_in: number };
        userInfo: { email: string; name: string };
    } | null> {
        // Opening the default browser picks whichever browser and profile the
        // OS considers default. People who keep each Google account in its own
        // Chrome profile need the link instead, to open it in the right one
        // (issue #8). The callback server below is the same either way.
        const mode = opts.mode ?? await pickLaunchMode();
        if (!mode) return null;

        return new Promise((resolve) => {
            const port = 19876 + Math.floor(Math.random() * 100);
            const redirectUri = `http://127.0.0.1:${port}/callback`;
            const state = crypto.randomBytes(16).toString('hex');

            const authUrl = `${AUTH_URL}?` + new URLSearchParams({
                client_id: CLIENT_ID,
                redirect_uri: redirectUri,
                response_type: 'code',
                scope: OAUTH_SCOPES.join(' '),
                access_type: 'offline',
                prompt: 'consent',
                state,
            }).toString();

            let server: http.Server | null = null;
            let settled = false;
            let endWait: () => void = () => { /* set once the wait UI is up */ };
            const finish = (value: Parameters<typeof resolve>[0]) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                server?.close();
                endWait();
                resolve(value);
            };
            const timeout = setTimeout(() => finish(null), OAUTH_CALLBACK_TIMEOUT_MS);

            server = http.createServer(async (req, res) => {
                if (!req.url?.startsWith('/callback')) {
                    res.writeHead(404);
                    res.end();
                    return;
                }

                const parsed = new URL(req.url!, 'http://localhost');
                const code = parsed.searchParams.get('code') ?? '';
                const returnedState = parsed.searchParams.get('state') ?? '';

                if (!code || returnedState !== state) {
                    res.writeHead(400);
                    res.end('Invalid callback. Please try again.');
                    finish(null);
                    return;
                }

                try {
                    const tokens = await this.exchangeCode(code, redirectUri);
                    const userInfo = await this.fetchUserInfo(tokens.access_token);

                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(getOAuthSuccessHtml(userInfo.email));
                    finish({ tokens, userInfo });
                } catch (err: any) {
                    log.error('OAuth error:', err);
                    res.writeHead(500);
                    res.end('Authentication failed: ' + err.message);
                    finish(null);
                }
            });

            server.listen(port, '127.0.0.1', async () => {
                if (mode === 'copy') {
                    await vscode.env.clipboard.writeText(authUrl);
                } else {
                    vscode.env.openExternal(vscode.Uri.parse(authUrl));
                }
                this.lastAuthUrl = authUrl;
                // One notification that stays up while we wait, with a way out.
                // Before, a closed browser tab left the flow hanging until the
                // timeout with nothing on screen to cancel it.
                void vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: mode === 'copy'
                        ? 'Sign-in link copied. Paste it into the browser profile of the account to add.'
                        : 'Browser opened for Google sign-in. Complete it to add the account.',
                    cancellable: true,
                }, (_progress, token) => new Promise<void>(done => {
                    endWait = done;
                    if (settled) return done();
                    token.onCancellationRequested(() => finish(null));
                }));
            });

            server.on('error', (err) => {
                log.error('Callback server error:', err);
                finish(null);
            });
        });
    }

    // --- Private ---

    private postForm(endpoint: string, body: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const parsed = new URL(endpoint);
            const req = https.request({
                hostname: parsed.hostname,
                path: parsed.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(body),
                },
                timeout: GOOGLE_API_TIMEOUT_MS,
            }, async (res) => {
                try {
                    const { status, body: data } = await collectBody(res);
                    if (status === 200) {
                        resolve(JSON.parse(data));
                    } else {
                        reject(new Error(`Token request failed: HTTP ${status} — ${data.substring(0, 200)}`));
                    }
                } catch (e) { reject(e); }
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }
}

