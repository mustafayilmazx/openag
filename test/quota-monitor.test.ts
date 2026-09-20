import { describe, expect, test } from "bun:test";
import { QuotaMonitor, ENDPOINT_DAILY, ENDPOINT_PROD } from "../src/core/quota-monitor.js";
import type { Account } from "../src/types.js";

describe("QuotaMonitor endpoint routing and parsing", () => {
  const fakeAccount: Account = {
    id: "acc-1",
    email: "test@gmail.com",
    tokenExpiresAt: Date.now() + 3600000,
    tier: "pro",
    status: "active",
    sortOrder: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isGcpTos: false,
  };

  test("routes to ENDPOINT_DAILY for consumer accounts (isGcpTos = false)", async () => {
    const requestedUrls: string[] = [];
    const origFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requestedUrls.push(url);

      if (url.includes("fetchAvailableModels")) {
        return new Response(JSON.stringify({ models: {} }), { status: 200 });
      }
      if (url.includes("loadCodeAssist")) {
        return new Response(JSON.stringify({ paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } }), { status: 200 });
      }
      if (url.includes("retrieveUserQuotaSummary")) {
        return new Response(
          JSON.stringify({
            groups: [
              {
                displayName: "Gemini Models",
                buckets: [
                  { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.59 },
                  { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.71 },
                ],
              },
              {
                displayName: "Claude and GPT models",
                buckets: [
                  { bucketId: "3p-weekly", window: "weekly", remainingFraction: 1.0 },
                  { bucketId: "3p-5h", window: "5h", remainingFraction: 1.0 },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const fakeTokenMgr = {
        isExtensionEnabled: () => true,
        isRotationEnabled: () => false,
        getAccounts: () => [fakeAccount],
        getActiveAccount: () => fakeAccount,
        getValidAccessToken: async () => "mock-token",
        updateAccountTier: async () => {},
      };

      const monitor = new QuotaMonitor(fakeTokenMgr as never, () => {});
      const q = await monitor.fetchAccountQuota(fakeAccount);

      expect(q).not.toBeNull();
      expect(q?.email).toBe("test@gmail.com");

      // Verify all requests used ENDPOINT_DAILY
      expect(requestedUrls.some((u) => u.startsWith(ENDPOINT_DAILY))).toBe(true);
      expect(requestedUrls.some((u) => u.startsWith(ENDPOINT_PROD))).toBe(false);

      // Verify Gemini weekly and 5h parsing
      const gemini = q?.families.find((f) => f.key === "gemini");
      expect(gemini).toBeDefined();
      expect(gemini?.limitWeekly?.percent).toBe(59);
      expect(gemini?.limit5h?.percent).toBe(71);

      // Verify Claude weekly and 5h parsing
      const claude = q?.families.find((f) => f.key === "claude");
      expect(claude).toBeDefined();
      expect(claude?.limitWeekly?.percent).toBe(100);
      expect(claude?.limit5h?.percent).toBe(100);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("routes to ENDPOINT_PROD for enterprise accounts (isGcpTos = true)", async () => {
    const requestedUrls: string[] = [];
    const origFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    try {
      const gcpAccount: Account = { ...fakeAccount, isGcpTos: true };
      const fakeTokenMgr = {
        isExtensionEnabled: () => true,
        isRotationEnabled: () => false,
        getAccounts: () => [gcpAccount],
        getActiveAccount: () => gcpAccount,
        getValidAccessToken: async () => "mock-token",
        updateAccountTier: async () => {},
      };

      const monitor = new QuotaMonitor(fakeTokenMgr as never, () => {});
      await monitor.fetchAccountQuota(gcpAccount);

      expect(requestedUrls.some((u) => u.startsWith(ENDPOINT_PROD))).toBe(true);
      expect(requestedUrls.some((u) => u.startsWith(ENDPOINT_DAILY))).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("falls back to secondary endpoint if primary fails", async () => {
    const requestedUrls: string[] = [];
    const origFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.startsWith(ENDPOINT_DAILY)) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(JSON.stringify({ groups: [] }), { status: 200 });
    }) as typeof fetch;

    try {
      const fakeTokenMgr = {
        isExtensionEnabled: () => true,
        isRotationEnabled: () => false,
        getAccounts: () => [fakeAccount],
        getActiveAccount: () => fakeAccount,
        getValidAccessToken: async () => "mock-token",
        updateAccountTier: async () => {},
      };

      const monitor = new QuotaMonitor(fakeTokenMgr as never, () => {});
      await monitor.fetchAccountQuota(fakeAccount);

      // Should have attempted daily, failed 404, then fallen back to prod
      expect(requestedUrls.some((u) => u.startsWith(ENDPOINT_DAILY))).toBe(true);
      expect(requestedUrls.some((u) => u.startsWith(ENDPOINT_PROD))).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
