import * as crypto from "node:crypto";
import { AuthError, OpenAGErrorCode, type Account, type DecryptedPoolData, type EncryptedPoolExport, type OAuthTokens } from "../types.js";

const PBKDF2_ITERATIONS = 600000;
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;

interface SerializedPoolEnvelope {
  version: number;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LEN, "sha256");
}

export function exportPool(
  accounts: Account[],
  secrets: Record<string, OAuthTokens>,
  passphrase: string,
): string {
  if (!passphrase || passphrase.length === 0) {
    throw new AuthError("Passphrase cannot be empty", OpenAGErrorCode.AUTH_INVALID_PASSPHRASE);
  }

  // SAFETY: sanitized accounts strip volatile access tokens but preserve Account entity fields
  const sanitizedAccounts = accounts.map(({ accessToken: _a, refreshToken: _r, ...rest }) => rest) as Account[];
  const payload: DecryptedPoolData = {
    accounts: sanitizedAccounts,
    secrets,
    exportedAt: Date.now(),
  };

  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);

  let plaintext: Buffer | null = Buffer.from(JSON.stringify(payload), "utf8");
  let ciphertext: Buffer;
  let tag: Buffer;

  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    tag = cipher.getAuthTag();
  } finally {
    key.fill(0);
    if (plaintext) {
      plaintext.fill(0);
      plaintext = null;
    }
  }

  const envelope: EncryptedPoolExport = {
    version: 1,
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    createdAt: Date.now(),
  };

  return JSON.stringify(envelope, null, 2);
}

export function importPool(serializedJson: string, passphrase: string): DecryptedPoolData {
  if (!passphrase || passphrase.length === 0) {
    throw new AuthError("Passphrase cannot be empty", OpenAGErrorCode.AUTH_INVALID_PASSPHRASE);
  }

  let envelope: SerializedPoolEnvelope;
  try {
    // SAFETY: parsing user-provided JSON export bundle
    envelope = JSON.parse(serializedJson.trim()) as SerializedPoolEnvelope;
  } catch (parseErr) {
    throw new AuthError("Invalid pool export file: malformed JSON", OpenAGErrorCode.AUTH_CORRUPTED_POOL, parseErr);
  }

  if (
    envelope.version !== 1 ||
    !envelope.salt ||
    !envelope.iv ||
    !envelope.tag ||
    !envelope.ciphertext
  ) {
    throw new AuthError("Invalid pool export envelope format", OpenAGErrorCode.AUTH_CORRUPTED_POOL);
  }

  const salt = Buffer.from(envelope.salt, "hex");
  const iv = Buffer.from(envelope.iv, "hex");
  const tag = Buffer.from(envelope.tag, "hex");
  const ciphertext = Buffer.from(envelope.ciphertext, "hex");

  if (salt.length !== SALT_LEN || iv.length !== IV_LEN || tag.length !== 16) {
    throw new AuthError("Corrupted encryption parameters in pool export file", OpenAGErrorCode.AUTH_CORRUPTED_POOL);
  }

  const key = deriveKey(passphrase, salt);
  let decrypted: Buffer | null = null;

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (decErr) {
    throw new AuthError("Decryption failed: incorrect passphrase or corrupted data", OpenAGErrorCode.AUTH_INVALID_PASSPHRASE, decErr);
  } finally {
    key.fill(0);
  }

  let data: DecryptedPoolData;
  try {
    // SAFETY: parsing decrypted JSON payload
    data = JSON.parse(decrypted.toString("utf8")) as DecryptedPoolData;
  } catch (jsonErr) {
    throw new AuthError("Decrypted payload contains invalid JSON", OpenAGErrorCode.AUTH_CORRUPTED_POOL, jsonErr);
  } finally {
    decrypted.fill(0);
    decrypted = null;
  }

  if (!Array.isArray(data.accounts) || !data.secrets) {
    throw new AuthError("Decrypted pool data is missing required account or secret fields", OpenAGErrorCode.AUTH_CORRUPTED_POOL);
  }

  for (const acc of data.accounts) {
    if (!acc.email) {
      throw new AuthError("Invalid account data in decrypted pool", OpenAGErrorCode.AUTH_CORRUPTED_POOL);
    }
  }

  return data;
}
