import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { canonicalJson, contentHash, sha256Hex } from "./domain/canonical.js";

export { canonicalJson, contentHash, sha256Hex };

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>;

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Operator-managed server key (ACCESSLEASE_SECRET_KEY, 32 bytes base64) held outside the database.
 * It MACs CSRF tokens, derives deterministic credential secrets, and encrypts secrets at rest (AES-256-GCM).
 */
export class ServerKey {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("ACCESSLEASE_SECRET_KEY must decode to exactly 32 bytes");
    this.key = key;
  }

  static fromBase64(value: string | undefined): ServerKey {
    if (!value) throw new Error("ACCESSLEASE_SECRET_KEY is required (base64 of 32 random bytes; see .env.example)");
    return new ServerKey(Buffer.from(value, "base64"));
  }

  static generate(): ServerKey {
    return new ServerKey(randomBytes(32));
  }

  mac(purpose: string, value: string): string {
    return createHmac("sha256", this.key).update(`${purpose}\n${value}`).digest("base64url");
  }

  /** Deterministic secret for (purpose, value): a retry derives the same secret without storing it first. */
  derive(purpose: string, value: string, length = 32): string {
    return this.mac(`derive:${purpose}`, value).slice(0, length);
  }

  private subkey(purpose: string): Buffer {
    return createHmac("sha256", this.key).update(`enc\n${purpose}`).digest();
  }

  /** AES-256-GCM; output `v1.<iv>.<tag>.<ciphertext>` (base64url). `purpose` is authenticated as AAD. */
  encrypt(purpose: string, plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.subkey(purpose), iv);
    cipher.setAAD(Buffer.from(purpose));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
  }

  decrypt(purpose: string, token: string): string {
    const [version, iv, tag, body] = token.split(".");
    if (version !== "v1" || !iv || !tag || !body) throw new Error("malformed ciphertext");
    const decipher = createDecipheriv("aes-256-gcm", this.subkey(purpose), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
