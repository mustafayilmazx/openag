import { describe, expect, mock, it } from "bun:test";
import type * as vscode from "vscode";

mock.module("vscode", () => ({
  EventEmitter: class<T = void> {
    private listeners: Array<(arg: T) => void> = [];
    public event = (fn: (arg: T) => void) => {
      this.listeners.push(fn);
      return { dispose: () => {} };
    };
    public fire = (val: T) => {
      for (const fn of this.listeners) fn(val);
    };
    public dispose = () => {
      this.listeners = [];
    };
  },
  commands: {
    executeCommand: () => Promise.resolve(),
  },
  env: {
    openExternal: () => Promise.resolve(true),
    clipboard: {
      writeText: () => Promise.resolve(),
    },
  },
  Uri: {
    parse: (url: string) => ({ toString: () => url }),
  },
}));

const { QuotaMonitor } = await import("../src/core/quota-monitor.js");
const { StatsManager } = await import("../src/core/stats-manager.js");
const { TokenManager } = await import("../src/core/token-manager.js");

function createMockExtensionContext(): vscode.ExtensionContext {
  const state = new Map<string, unknown>();
  const secrets = new Map<string, string>();

  return {
    globalState: {
      get: (key: string, def?: unknown) => state.get(key) ?? def,
      update: (key: string, val: unknown) => {
        state.set(key, val);
        return Promise.resolve();
      },
      keys: () => Array.from(state.keys()),
      setKeysForSync: () => {},
    },
    secrets: {
      get: (key: string) => Promise.resolve(secrets.get(key)),
      store: (key: string, val: string) => {
        secrets.set(key, val);
        return Promise.resolve();
      },
      delete: (key: string) => {
        secrets.delete(key);
        return Promise.resolve();
      },
      onDidChange: () => ({ dispose: () => {} }),
    },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

describe("Token Burn Rate & Quota Exhaustion Estimator", () => {
  it("calculates moving 15-minute token burn rate accurately", () => {
    const ctx = createMockExtensionContext();
    const sm = new StatsManager(ctx, () => {});

    // Empty stats initially
    const initialBurn = sm.getBurnRate(15);
    expect(initialBurn.tokensPerMin).toBe(0);
    expect(initialBurn.recentTurns).toBe(0);

    const now = Date.now();
    // Simulate 2 requests in the last 10 minutes totaling 45,000 tokens
    sm.recordTokens("2026-08-24", "Gemini 3.7 Flash", "conv_1", "Test 1", "", 10000, 2000, 8000, 2000, "Test 1", now - 5 * 60 * 1000, 2);
    sm.recordTokens("2026-08-24", "Gemini 3.7 Flash", "conv_1", "Test 2", "", 15000, 3000, 12000, 3000, "Test 2", now - 2 * 60 * 1000, 3);

    const burn = sm.getBurnRate(15);
    expect(burn.tokensPerMin).toBeGreaterThan(0);
    expect(burn.recentTurns).toBe(5);
  });

  it("calculates estimated minutes to exhaustion based on burn rate", async () => {
    const ctx = createMockExtensionContext();
    const tm = new TokenManager(ctx, () => {});
    await tm.initialize();

    await tm.addOrUpdateAccount({
      email: "active@example.com",
      accessToken: "token_1",
      refreshToken: "refresh_1",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      tier: "pro",
      status: "active",
      sortOrder: 0,
    });

    const qm = new QuotaMonitor(tm, () => {}, undefined, undefined, ctx);

    // Mock active account quota at 50%
    const now = Date.now();
    const resetTime = new Date(now + 60 * 60 * 1000).toISOString();
    // @ts-expect-error test private access
    qm.quotas.set("active@example.com", {
      email: "active@example.com",
      tier: "pro",
      families: [
        { key: "gemini", label: "Gemini", percent: 50, resetTime, limit5h: { percent: 50, resetTime } },
        { key: "claude", label: "Claude", percent: 50, resetTime, limit5h: { percent: 50, resetTime } },
      ],
      models: [],
      lastUpdated: now,
    });

    const estimate = qm.getExhaustionEstimate(25000, "Gemini 3.7 Flash");
    expect(estimate).not.toBeNull();
    expect(estimate?.estMinutesLeft).toBeGreaterThan(0);
    expect(estimate?.earliestResetMinutes).toBeGreaterThan(0);
  });
});
