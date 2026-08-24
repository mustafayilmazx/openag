import { describe, expect, test } from "bun:test";
import {
  formatKeyringPayload,
  KEYRING_TARGET,
  parseKeyringPayload,
} from "../src/core/native-keyring.js";

describe("NativeKeyring OS Credential Bridge", () => {
  test("formats valid JSON payload for gemini:antigravity target", () => {
    const payload = formatKeyringPayload("mock_access_token_123", "mock_refresh_token_456", 1700000000);
    expect(payload.token.access_token).toBe("mock_access_token_123");
    expect(payload.token.refresh_token).toBe("mock_refresh_token_456");
    expect(payload.token.token_type).toBe("Bearer");
    expect(payload.token.expiry).toBe(new Date(1700000000 * 1000).toISOString());
    expect(payload.auth_method).toBe("consumer");
  });

  test("parses valid JSON keyring payload correctly", () => {
    const raw = JSON.stringify({
      token: {
        access_token: "test_access",
        token_type: "Bearer",
        refresh_token: "test_refresh",
        expiry: "2026-08-25T02:00:00.000Z",
      },
      auth_method: "consumer",
    });

    const parsed = parseKeyringPayload(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.token?.access_token).toBe("test_access");
    expect(parsed?.token?.refresh_token).toBe("test_refresh");
  });

  test("returns null for malformed or non-token JSON string", () => {
    expect(parseKeyringPayload("")).toBeNull();
    expect(parseKeyringPayload("invalid json string")).toBeNull();
    expect(parseKeyringPayload(JSON.stringify({ some: "other object" }))).toBeNull();
  });

  test("uses standard gemini:antigravity target identifier", () => {
    expect(KEYRING_TARGET).toBe("gemini:antigravity");
  });
});
