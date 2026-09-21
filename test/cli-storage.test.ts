import { describe, expect, test, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CliStorage, DEFAULT_CONFIG } from "../src/cli/storage.js";

describe("CliStorage persistence and vault", () => {
  const tmpDir = path.join(os.tmpdir(), `openag-test-${Date.now()}`);

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("loads default config and empty accounts when directory is fresh", async () => {
    const storage = new CliStorage(tmpDir);
    const data = await storage.load();

    expect(data.accounts).toEqual([]);
    expect(data.secrets).toEqual({});
    expect(data.config.rotationStrategy).toBe("auto_highest");
    expect(data.config.hookPort).toBe(27182);
  });

  test("saves accounts, config, and encrypted vault, then reloads accurately", async () => {
    const storage = new CliStorage(tmpDir);
    const testData = {
      accounts: [
        {
          id: "acc-1",
          email: "mustafa@gmail.com",
          tier: "pro" as const,
          status: "active" as const,
          sortOrder: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          tokenExpiresAt: 1234567,
        },
      ],
      secrets: {
        "mustafa@gmail.com": {
          accessToken: "ya29.test-access-token",
          refreshToken: "1//test-refresh-token",
          expiryDateSeconds: 1234567,
          tokenType: "Bearer",
        },
      },
      config: {
        ...DEFAULT_CONFIG,
        activeEmail: "mustafa@gmail.com",
        rotationStrategy: "cache_optimized" as const,
      },
    };

    await storage.save(testData);

    // Verify vault.bin is encrypted (does not contain plaintext tokens)
    const vaultRaw = fs.readFileSync(path.join(tmpDir, "vault.bin"), "utf8");
    expect(vaultRaw.includes("ya29.test-access-token")).toBe(false);
    expect(vaultRaw.includes("1//test-refresh-token")).toBe(false);

    // Verify loading decrypts correctly
    const reloaded = await storage.load();
    expect(reloaded.accounts.length).toBe(1);
    expect(reloaded.accounts[0]?.email).toBe("mustafa@gmail.com");
    expect(reloaded.config.rotationStrategy).toBe("cache_optimized");
    expect(reloaded.secrets["mustafa@gmail.com"]?.accessToken).toBe("ya29.test-access-token");
  });
});
