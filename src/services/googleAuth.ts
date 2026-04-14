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
import { collectBody } from '../utils/http';

const log = createLogger('GoogleAuth');

export class GoogleAuthService {

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
                timeout: 10000,
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
    async startOAuthFlow(): Promise<{
        tokens: { access_token: string; refresh_token: string; expires_in: number };
        userInfo: { email: string; name: string };
    } | null> {
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
            const timeout = setTimeout(() => {
                server?.close();
                resolve(null);
            }, OAUTH_CALLBACK_TIMEOUT_MS);

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
                    clearTimeout(timeout);
                    server?.close();
                    resolve(null);
                    return;
                }

                try {
                    const tokens = await this.exchangeCode(code, redirectUri);
                    const userInfo = await this.fetchUserInfo(tokens.access_token);

                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(getOAuthSuccessHtml(userInfo.email));

                    clearTimeout(timeout);
                    server?.close();
                    resolve({ tokens, userInfo });
                } catch (err: any) {
                    log.error('OAuth error:', err);
                    res.writeHead(500);
                    res.end('Authentication failed: ' + err.message);
                    clearTimeout(timeout);
                    server?.close();
                    resolve(null);
                }
            });

            server.listen(port, '127.0.0.1', () => {
                vscode.env.openExternal(vscode.Uri.parse(authUrl));
                vscode.window.showInformationMessage(
                    'Browser opened for Google login. Complete the sign-in to add your account.'
                );
            });

            server.on('error', (err) => {
                log.error('Callback server error:', err);
                clearTimeout(timeout);
                resolve(null);
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
                timeout: 10000,
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

