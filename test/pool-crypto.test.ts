import { describe, expect, test } from "bun:test";
import { exportPool, importPool } from "../src/core/pool-crypto.js";
import { type Account, AuthError, type OAuthTokens, OpenAGErrorCode } from "../src/types.js";

describe("PoolCrypto Engine", () => {
  const sampleAccounts = [
    {
      id: "acc_1",
      email: "alpha@example.com",
      tier: "pro",
      status: "active",
      sortOrder: 0,
      affinity: "claude",
      role: "primary",
      tokenExpiresAt: 1700000000,
      createdAt: 1690000000,
      updatedAt: 1690000000,
    },
    {
      id: "acc_2",
      email: "beta@example.com",
      tier: "ultra",
      status: "active",
      sortOrder: 1,
      affinity: "gemini",
      role: "reserve",
      tokenExpiresAt: 1700000000,
      createdAt: 1690000000,
      updatedAt: 1690000000,
    },
  ] satisfies Account[];

  const sampleSecrets = {
    "alpha@example.com": {
      accessToken: "ya29.alpha-secret-token",
      refreshToken: "1//refresh-token-alpha",
      expiryDateSeconds: 1700000000,
    },
    "beta@example.com": {
      accessToken: "ya29.beta-secret-token",
      refreshToken: "1//refresh-token-beta",
      expiryDateSeconds: 1700000000,
    },
  } satisfies Record<string, OAuthTokens>;

  test("successfully encrypts and decrypts account pool with correct passphrase", () => {
    const passphrase = "MySecretMasterPassword123!";
    const encryptedJson = exportPool(sampleAccounts, sampleSecrets, passphrase);

    expect(encryptedJson.length).toBeGreaterThan(0);
    // SAFETY: parsing test JSON export envelope
    const envelope = JSON.parse(encryptedJson) as { version: number; salt: string; iv: string; tag: string; ciphertext: string };
    expect(envelope.version).toBe(1);
    expect(envelope.salt.length).toBe(32); // 16 bytes hex
    expect(envelope.iv.length).toBe(24);   // 12 bytes hex
    expect(envelope.tag.length).toBe(32);  // 16 bytes hex

    const decrypted = importPool(encryptedJson, passphrase);
    expect(decrypted.accounts.length).toBe(2);
    expect(decrypted.accounts[0]?.email).toBe("alpha@example.com");
    expect(decrypted.accounts[0]?.affinity).toBe("claude");
    expect(decrypted.accounts[1]?.email).toBe("beta@example.com");
    expect(decrypted.accounts[1]?.role).toBe("reserve");

    expect(decrypted.secrets["alpha@example.com"]?.accessToken).toBe("ya29.alpha-secret-token");
    expect(decrypted.secrets["beta@example.com"]?.refreshToken).toBe("1//refresh-token-beta");
  });

  test("fails decryption with incorrect passphrase and throws typed AuthError", () => {
    const encryptedJson = exportPool(sampleAccounts, sampleSecrets, "correct-passphrase");
    try {
      importPool(encryptedJson, "wrong-passphrase");
      expect().fail("Should have thrown");
    } catch (err: unknown) {
      expect(err instanceof AuthError).toBe(true);
      expect((err as AuthError).code).toBe(OpenAGErrorCode.AUTH_INVALID_PASSPHRASE);
    }
  });

  test("rejects empty passphrase on export and import with AUTH_INVALID_PASSPHRASE", () => {
    try {
      exportPool(sampleAccounts, sampleSecrets, "");
      expect().fail("Should have thrown");
    } catch (err: unknown) {
      expect(err instanceof AuthError).toBe(true);
      expect((err as AuthError).code).toBe(OpenAGErrorCode.AUTH_INVALID_PASSPHRASE);
    }

    try {
      importPool("{}", "");
      expect().fail("Should have thrown");
    } catch (err: unknown) {
      expect(err instanceof AuthError).toBe(true);
      expect((err as AuthError).code).toBe(OpenAGErrorCode.AUTH_INVALID_PASSPHRASE);
    }
  });

  test("rejects tampered ciphertext", () => {
    const encryptedJson = exportPool(sampleAccounts, sampleSecrets, "password");
    // SAFETY: parsing test JSON export envelope to tamper
    const envelope = JSON.parse(encryptedJson) as { ciphertext: string };
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -4)}dead`;
    const tampered = JSON.stringify(envelope);

    try {
      importPool(tampered, "password");
      expect().fail("Should have thrown");
    } catch (err: unknown) {
      expect(err instanceof AuthError).toBe(true);
      expect((err as AuthError).code).toBe(OpenAGErrorCode.AUTH_INVALID_PASSPHRASE);
    }
  });

  test("rejects malformed JSON envelope with AUTH_CORRUPTED_POOL", () => {
    try {
      importPool("not a json string", "password");
      expect().fail("Should have thrown");
    } catch (err: unknown) {
      expect(err instanceof AuthError).toBe(true);
      expect((err as AuthError).code).toBe(OpenAGErrorCode.AUTH_CORRUPTED_POOL);
    }
  });
});
