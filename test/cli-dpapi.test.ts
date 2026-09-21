import { describe, expect, test } from "bun:test";
import { Dpapi } from "../src/cli/dpapi.js";

describe("Dpapi token encryption", () => {
  test("encrypts and decrypts string asynchronously", async () => {
    const original = "my-secret-oauth-refresh-token-12345";
    const protectedText = await Dpapi.protect(original);
    expect(protectedText).not.toBe(original);
    expect(protectedText.startsWith("DPAPI:") || protectedText.startsWith("FALLBACK_GCM:")).toBe(true);

    const decrypted = await Dpapi.unprotect(protectedText);
    expect(decrypted).toBe(original);
  }, 15000);

  test("encrypts and decrypts string synchronously", () => {
    const original = "sync-secret-payload-abcde";
    const protectedText = Dpapi.protectSync(original);
    expect(protectedText).not.toBe(original);

    const decrypted = Dpapi.unprotectSync(protectedText);
    expect(decrypted).toBe(original);
  }, 15000);
});
