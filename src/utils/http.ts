import type { IncomingMessage } from 'http';

/**
 * Accumulates an HTTP response body as a UTF-8 string.
 * Returns { status, body } so the caller can decide how to handle non-2xx codes.
 * Never throws on its own — rejects only on socket errors.
 */
export function collectBody(res: IncomingMessage): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        let body = '';
        res.on('data', (chunk: string | Buffer) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        res.on('error', reject);
    });
}

/**
 * Accumulates an HTTP response body as a raw Buffer.
 * Returns { status, body } so the caller can decide how to handle non-2xx codes.
 * Never throws on its own — rejects only on socket errors.
 */
export function collectBuffer(res: IncomingMessage): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on('error', reject);
    });
}
