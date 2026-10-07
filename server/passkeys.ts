import crypto from 'node:crypto';
import { pool } from './db.js';
import { uuid } from './crypto.js';

export function getRpId(reqHost?: string): string {
  if (process.env.PUBLIC_ORIGIN) {
    try {
      const url = new URL(process.env.PUBLIC_ORIGIN);
      return url.hostname;
    } catch {}
  }
  if (reqHost) {
    return reqHost.split(':')[0];
  }
  return 'vrot.fun';
}

export async function createPasskeyChallenge(userId: string | null, type: 'register' | 'login'): Promise<string> {
  const challenge = crypto.randomBytes(32).toString('base64url');
  const id = uuid();
  await pool.query(
    `INSERT INTO auth_challenges (id, challenge, user_id, challenge_type, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '5 minutes')`,
    [id, challenge, userId, type]
  );
  return challenge;
}

export async function verifyPasskeyChallenge(challenge: string, type: 'register' | 'login', userId?: string | null): Promise<boolean> {
  const q = await pool.query(
    `DELETE FROM auth_challenges
     WHERE challenge = $1 AND challenge_type = $2 AND expires_at > now() ${userId ? 'AND (user_id = $3 OR user_id IS NULL)' : ''}
     RETURNING id`,
    userId ? [challenge, type, userId] : [challenge, type]
  );
  return (q.rowCount || 0) > 0;
}

// Minimal CBOR reader to extract authData from attestationObject
export function parseAttestationObject(attestationBase64Url: string): { authData: Buffer; credentialId?: string; publicKey?: Buffer } | null {
  try {
    const raw = Buffer.from(attestationBase64Url, 'base64url');
    // Look for 'authData' key in simple CBOR map
    const authDataKey = Buffer.from('authData');
    const idx = raw.indexOf(authDataKey);
    if (idx === -1) return null;
    const lenHeader = raw[idx + authDataKey.length];
    // In CBOR, byte string 0x58 (len 1 byte) or 0x59 (len 2 bytes)
    let authDataStart = idx + authDataKey.length + 1;
    let authDataLen = 0;
    if (lenHeader === 0x58) {
      authDataLen = raw[authDataStart];
      authDataStart += 1;
    } else if (lenHeader === 0x59) {
      authDataLen = raw.readUInt16BE(authDataStart);
      authDataStart += 2;
    } else if ((lenHeader & 0xe0) === 0x40) {
      authDataLen = lenHeader & 0x1f;
    } else {
      return null;
    }

    const authData = raw.subarray(authDataStart, authDataStart + authDataLen);
    if (authData.length < 37) return { authData };

    // authData layout: 32 bytes rpIdHash + 1 byte flags + 4 bytes signCount
    const flags = authData[32];
    const hasAttestedCredentialData = (flags & 0x40) !== 0;

    if (hasAttestedCredentialData && authData.length >= 55) {
      // 16 bytes aaguid + 2 bytes credIdLen
      const credIdLen = authData.readUInt16BE(53);
      const credId = authData.subarray(55, 55 + credIdLen).toString('base64url');
      const cosePubKey = authData.subarray(55 + credIdLen);
      return { authData, credentialId: credId, publicKey: cosePubKey };
    }

    return { authData };
  } catch (e) {
    console.error('Failed to parse attestationObject:', e);
    return null;
  }
}
