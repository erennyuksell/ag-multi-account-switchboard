import * as crypto from 'crypto';

/** Short, non-reversible label for a token so logs can be compared safely. */
export function tokenFingerprint(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex').slice(0, 8);
}
