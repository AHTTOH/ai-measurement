import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';

/** 비밀번호·PIN 해시: scrypt. 형식 scrypt$N$r$p$salt$hash (base64url) */
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

function scryptAsync(secret: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, KEY_LENGTH, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(secret, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [algorithm, n, r, p, salt, hash] = stored.split('$');
  if (algorithm !== 'scrypt' || n === undefined || r === undefined || p === undefined || salt === undefined || hash === undefined) {
    return false;
  }
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scryptAsync(secret, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 존재하지 않는 계정에도 같은 시간을 쓰게 하는 더미 해시 */
let dummyHashPromise: Promise<string> | undefined;
export function dummySecretHash(): Promise<string> {
  dummyHashPromise ??= hashSecret(randomBytes(16).toString('hex'));
  return dummyHashPromise;
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomDigits(length: number): string {
  return Array.from({ length }, () => String(randomInt(0, 10))).join('');
}
