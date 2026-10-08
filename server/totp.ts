import crypto from 'node:crypto';
import { sha256 } from './crypto.js';

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(bytes = 20): string {
  const buf = crypto.randomBytes(bytes);
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += B32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = B32_ALPHABET.indexOf(clean[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function getTotpToken(secret: string, timeStep = 30, time = Date.now()): string {
  const key = base32Decode(secret);
  const counter = Math.floor(time / (timeStep * 1000));
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % 1_000_000;
  return String(code).padStart(6, '0');
}

import QRCode from 'qrcode';

export async function generateQrDataUrl(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 2, scale: 6 });
}

export function verifyTotpToken(secret: string, token: string, window = 2): boolean {
  if (!token) return false;
  const clean = token.replace(/[\s-]+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const now = Date.now();
  for (let i = -window; i <= window; i++) {
    const testTime = now + i * 30_000;
    if (getTotpToken(secret, 30, testTime) === clean) {
      return true;
    }
  }
  return false;
}

export function generateBackupCodes(count = 8): { rawCodes: string[]; hashedCodes: string[] } {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const rawCodes: string[] = [];
  const hashedCodes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = crypto.randomBytes(8);
    let code = '';
    for (let j = 0; j < 8; j++) {
      code += chars[bytes[j] % chars.length];
    }
    rawCodes.push(code);
    hashedCodes.push(sha256(code.toUpperCase()));
  }
  return { rawCodes, hashedCodes };
}

export function verifyBackupCode(code: string, hashedCodes: string[]): { valid: boolean; remaining: string[] } {
  const hash = sha256(code.trim().toUpperCase());
  const idx = hashedCodes.indexOf(hash);
  if (idx !== -1) {
    const remaining = [...hashedCodes];
    remaining.splice(idx, 1);
    return { valid: true, remaining };
  }
  return { valid: false, remaining: hashedCodes };
}

export function getTotpUri(username: string, secret: string, issuer = 'VROT'): string {
  const encUser = encodeURIComponent(username);
  const encIssuer = encodeURIComponent(issuer);
  return `otpauth://totp/${encIssuer}:${encUser}?secret=${secret}&issuer=${encIssuer}&algorithm=SHA1&digits=6&period=30`;
}
