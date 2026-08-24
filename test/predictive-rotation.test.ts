import { describe, expect, mock, test } from "bun:test";
import type { Account, AccountQuota } from "../src/types.js";

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
}));

const { TokenManager } = await import("../src/core/token-manager.js");

function createMockContext(accounts: Account[], activeEmail = "") {
  const store = new Map<string, unknown>();
  const secrets = new Map<string, string>();

  store.set("openag.accounts.v1", accounts);
  store.set("openag.active_account.v1", activeEmail);
  store.set("openag.config.v1", { enabled: true });

  // SAFETY: Mock ExtensionContext for unit tests
  return {
    globalState: {
      get: <T>(key: string, def?: T): T => (store.has(key) ? (store.get(key) as T) : (def as T)),
      update: (key: string, val: Account[] | string | { enabled: boolean }) => {
        store.set(key, val);
        return Promise.resolve();
      },
    },
    secrets: {
      get: (key: string) => Promise.resolve(secrets.get(key) || null),
      store: (key: string, val: string) => {
        secrets.set(key, val);
        return Promise.resolve();
      },
      delete: (key: string) => {
        secrets.delete(key);
        return Promise.resolve();
      },
    },
  } as any;
}

describe("Predictive Rotation & Affinity Optimizer", () => {
  test("prioritizes account with imminent reset window before fresh bucket", async () => {
    const now = Date.now();
    const accA: Account = {
      id: "a",
      email: "a@test.com",
      tier: "pro",
      status: "active",
      sortOrder: 0,
      tokenExpiresAt: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    const accB: Account = {
      id: "b",
      email: "b@test.com",
      tier: "pro",
      status: "active",
      sortOrder: 1,
      tokenExpiresAt: 0,
      createdAt: 0,
      updatedAt: 0,
    };

    const ctx = createMockContext([accA, accB], "c@test.com");
    const tm = new TokenManager(ctx, () => {});
    await tm.initialize();

    // Account A has 25% but resets in 20 minutes (imminent bonus)
    // Account B has 80% but resets in 4 hours
    const quotas = {
      "a@test.com": {
        email: "a@test.com",
        tier: "pro",
        families: [{ key: "gemini", label: "Gemini", percent: 25, resetTime: new Date(now + 20 * 60 * 1000).toISOString() }],
        models: [],
        lastUpdated: now,
      },
      "b@test.com": {
        email: "b@test.com",
        tier: "pro",
        families: [{ key: "gemini", label: "Gemini", percent: 80, resetTime: new Date(now + 4 * 60 * 60 * 1000).toISOString() }],
        models: [],
        lastUpdated: now,
      },
    } satisfies Record<string, AccountQuota>;

    const selected = await tm.autoSelectHighestQuota(quotas, "test", "gemini-3.7-flash");
    expect(selected?.email).toBe("a@test.com");
    tm.dispose();
  });

  test("keeps active account if its reset window is imminent to drain quota before refill", async () => {
    const now = Date.now();
    const activeAcc: Account = {
      id: "active",
      email: "active@test.com",
      tier: "pro",
      status: "active",
      sortOrder: 0,
      tokenExpiresAt: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    const otherAcc: Account = {
      id: "other",
      email: "other@test.com",
      tier: "pro",
      status: "active",
      sortOrder: 1,
      tokenExpiresAt: 0,
      createdAt: 0,
      updatedAt: 0,
    };

    const ctx = createMockContext([activeAcc, otherAcc], "active@test.com");
    const tm = new TokenManager(ctx, () => {});
    await tm.initialize();

    // Active account has 20% and resets in 15 minutes
    // Other account has 90% and resets in 3 hours
    const quotas = {
      "active@test.com": {
        email: "active@test.com",
        tier: "pro",
        families: [{ key: "gemini", label: "Gemini", percent: 20, resetTime: new Date(now + 15 * 60 * 1000).toISOString() }],
        models: [],
        lastUpdated: now,
      },
      "other@test.com": {
        email: "other@test.com",
        tier: "pro",
        families: [{ key: "gemini", label: "Gemini", percent: 90, resetTime: new Date(now + 3 * 60 * 60 * 1000).toISOString() }],
        models: [],
        lastUpdated: now,
      },
    } satisfies Record<string, AccountQuota>;

    const selected = await tm.autoSelectHighestQuota(quotas, "normal_check", "gemini-3.7-flash");
    // Should NOT rotate away from active account because active is in drain window
    expect(selected).toBeNull();
    tm.dispose();
  });

  test("respects model affinity filtering for claude vs gemini", async () => {
    const now = Date.now();
    const claudeAcc: Account = {
      id: "claude_acc",
      email: "claude@test.com",
      tier: "ultra",
      status: "active",
      affinity: "claude",
      sortOrder: 0,
      tokenExpiresAt: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    const geminiAcc: Account = {
      id: "gemini_acc",
      email: "gemini@test.com",
      tier: "pro",
      status: "active",
      affinity: "gemini",
      sortOrder: 1,
      tokenExpiresAt: 0,
      createdAt: 0,
      updatedAt: 0,
    };

    const ctx = createMockContext([claudeAcc, geminiAcc], "gemini@test.com");
    const tm = new TokenManager(ctx, () => {});
    await tm.initialize();

    const quotas = {
      "claude@test.com": {
        email: "claude@test.com",
        tier: "ultra",
        families: [{ key: "claude", label: "Claude", percent: 90 }],
        models: [],
        lastUpdated: now,
      },
      "gemini@test.com": {
        email: "gemini@test.com",
        tier: "pro",
        families: [{ key: "gemini", label: "Gemini", percent: 95 }],
        models: [],
        lastUpdated: now,
      },
    } satisfies Record<string, AccountQuota>;

    // Active is gemini@test.com. For Claude model, must pick claudeAcc despite geminiAcc having higher quota
    const claudeSelection = await tm.autoSelectHighestQuota(quotas, "test", "claude-3-7-sonnet");
    expect(claudeSelection?.email).toBe("claude@test.com");

    // Now active is claude@test.com. For Gemini model, must switch to geminiAcc
    const geminiSelection = await tm.autoSelectHighestQuota(quotas, "test", "gemini-3.7-flash");
    expect(geminiSelection?.email).toBe("gemini@test.com");

    tm.dispose();
  });

  test("gating of reserve pool accounts until primary pool is exhausted", async () => {
    const now = Date.now();
    const primaryAcc: Account = {
      id: "pri",
      email: "primary@test.com",
      tier: "pro",
      status: "active",
      role: "primary",
      sortOrder: 0,
      tokenExpiresAt: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    const reserveAcc: Account = {
      id: "res",
      email: "reserve@test.com",
      tier: "pro",
      status: "active",
      role: "reserve",
      sortOrder: 1,
      tokenExpiresAt: 0,
      createdAt: 0,
      updatedAt: 0,
    };

    const ctx = createMockContext([primaryAcc, reserveAcc], "primary@test.com");
    const tm = new TokenManager(ctx, () => {});
    await tm.initialize();

    // 1. Primary has 40% (> 10%), reserve has 100% -> primary must be used
    const quotasHealthy = {
      "primary@test.com": {
        email: "primary@test.com",
        tier: "pro",
        families: [{ key: "gemini", label: "Gemini", percent: 40 }],
        models: [],
        lastUpdated: now,
      },
      "reserve@test.com": {
        email: "reserve@test.com",
        tier: "pro",
        families: [{ key: "gemini", label: "Gemini", percent: 100 }],
        models: [],
        lastUpdated: now,
      },
    } satisfies Record<string, AccountQuota>;

    const healthySelect = await tm.autoSelectHighestQuota(quotasHealthy, "test", "gemini-3.7-flash");
    expect(healthySelect).toBeNull(); // remains on primary

    // 2. Primary drops to 5% (<= 10%) -> reserve account is unlocked and activated
    const quotasExhausted = {
      "primary@test.com": {
        email: "primary@test.com",
        tier: "pro",
        families: [{ key: "gemini", label: "Gemini", percent: 5 }],
        models: [],
        lastUpdated: now,
      },
      "reserve@test.com": {
        email: "reserve@test.com",
        tier: "pro",
        families: [{ key: "gemini", label: "Gemini", percent: 100 }],
        models: [],
        lastUpdated: now,
      },
    } satisfies Record<string, AccountQuota>;

    const reserveSelect = await tm.autoSelectHighestQuota(quotasExhausted, "test", "gemini-3.7-flash");
    expect(reserveSelect?.email).toBe("reserve@test.com");

    tm.dispose();
  });

  test("prioritizes Pro and Ultra tier accounts before touching Free tier accounts", async () => {
    const now = Date.now();
    const accounts: Account[] = [
      {
        id: "acc_pro",
        email: "pro@test.com",
        tier: "pro",
        status: "active",
        sortOrder: 0,
        tokenExpiresAt: Math.floor(now / 1000) + 3600,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "acc_free",
        email: "free@test.com",
        tier: "free",
        status: "active",
        sortOrder: 1,
        tokenExpiresAt: Math.floor(now / 1000) + 3600,
        createdAt: now,
        updatedAt: now,
      },
    ];

    const ctx = createMockContext(accounts, "pro@test.com");
    const tm = new TokenManager(ctx, () => {});
    await tm.initialize();

    // 1. Pro has 40% quota, Free has 100% quota -> stays on Pro (Free is protected)
    const quotasProHealthy = {
      "pro@test.com": {
        email: "pro@test.com",
        tier: "pro",
        families: [{ key: "gemini", label: "Gemini", percent: 40 }],
        models: [],
        lastUpdated: now,
      },
      "free@test.com": {
        email: "free@test.com",
        tier: "free",
        families: [{ key: "gemini", label: "Gemini", percent: 100 }],
        models: [],
        lastUpdated: now,
      },
    } satisfies Record<string, AccountQuota>;

    const proSelect = await tm.autoSelectHighestQuota(quotasProHealthy, "test", "gemini-3.7-flash");
    expect(proSelect).toBeNull(); // remains on Pro account

    // 2. Pro drops to 5% (<= 10%) -> Free tier is now unlocked
    const quotasProExhausted = {
      "pro@test.com": {
        email: "pro@test.com",
        tier: "pro",
        families: [{ key: "gemini", label: "Gemini", percent: 5 }],
        models: [],
        lastUpdated: now,
      },
      "free@test.com": {
        email: "free@test.com",
        tier: "free",
        families: [{ key: "gemini", label: "Gemini", percent: 100 }],
        models: [],
        lastUpdated: now,
      },
    } satisfies Record<string, AccountQuota>;

    const freeSelect = await tm.autoSelectHighestQuota(quotasProExhausted, "test", "gemini-3.7-flash");
    expect(freeSelect?.email).toBe("free@test.com");

    tm.dispose();
  });

  test("Cache Optimized strategy stays on active account until quota drops below 15%", async () => {
    const now = Date.now();
    const accounts: Account[] = [
      {
        id: "acc_active",
        email: "active@test.com",
        tier: "pro",
        status: "active",
        sortOrder: 0,
        tokenExpiresAt: Math.floor(now / 1000) + 3600,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "acc_other",
        email: "other@test.com",
        tier: "pro",
        status: "active",
        sortOrder: 1,
        tokenExpiresAt: Math.floor(now / 1000) + 3600,
        createdAt: now,
        updatedAt: now,
      },
    ];

    const ctx = createMockContext(accounts, "active@test.com");
    const tm = new TokenManager(ctx, () => {});
    await tm.initialize();
    await tm.updateConfig({ rotationStrategy: "cache_optimized" });

    // Active has 30% quota, Other has 90% quota -> stays on active for cache residency
    const quotasHealthy = {
      "active@test.com": {
        email: "active@test.com",
        tier: "pro",
        families: [{ key: "gemini", label: "Gemini", percent: 30 }],
        models: [],
        lastUpdated: now,
      },
      "other@test.com": {
        email: "other@test.com",
        tier: "pro",
        families: [{ key: "gemini", label: "Gemini", percent: 90 }],
        models: [],
        lastUpdated: now,
      },
    } satisfies Record<string, AccountQuota>;

    const staySelect = await tm.autoSelectHighestQuota(quotasHealthy, "test", "gemini-3.7-flash");
    expect(staySelect).toBeNull(); // remains on active for cache warmness

    // Active drops to 12% (<= 15%) -> now rotates to higher quota account
    const quotasLow = {
      "active@test.com": {
        email: "active@test.com",
        tier: "pro",
        families: [{ key: "gemini", label: "Gemini", percent: 12 }],
        models: [],
        lastUpdated: now,
      },
      "other@test.com": {
        email: "other@test.com",
        tier: "pro",
        families: [{ key: "gemini", label: "Gemini", percent: 90 }],
        models: [],
        lastUpdated: now,
      },
    } satisfies Record<string, AccountQuota>;

    const switchSelect = await tm.autoSelectHighestQuota(quotasLow, "test", "gemini-3.7-flash");
    expect(switchSelect?.email).toBe("other@test.com");

    tm.dispose();
  });

  test("Round Robin strategy cycles sequentially through healthy accounts", async () => {
    const now = Date.now();
    const accounts: Account[] = [
      {
        id: "acc_1",
        email: "acc1@test.com",
        tier: "pro",
        status: "active",
        sortOrder: 0,
        tokenExpiresAt: Math.floor(now / 1000) + 3600,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "acc_2",
        email: "acc2@test.com",
        tier: "pro",
        status: "active",
        sortOrder: 1,
        tokenExpiresAt: Math.floor(now / 1000) + 3600,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "acc_3",
        email: "acc3@test.com",
        tier: "pro",
        status: "active",
        sortOrder: 2,
        tokenExpiresAt: Math.floor(now / 1000) + 3600,
        createdAt: now,
        updatedAt: now,
      },
    ];

    const ctx = createMockContext(accounts, "acc1@test.com");
    const tm = new TokenManager(ctx, () => {});
    await tm.initialize();
    await tm.updateConfig({ rotationStrategy: "round_robin" });

    const quotas = {
      "acc1@test.com": { email: "acc1@test.com", tier: "pro", families: [{ key: "gemini", label: "Gemini", percent: 80 }], models: [], lastUpdated: now },
      "acc2@test.com": { email: "acc2@test.com", tier: "pro", families: [{ key: "gemini", label: "Gemini", percent: 75 }], models: [], lastUpdated: now },
      "acc3@test.com": { email: "acc3@test.com", tier: "pro", families: [{ key: "gemini", label: "Gemini", percent: 70 }], models: [], lastUpdated: now },
    } satisfies Record<string, AccountQuota>;

    // From acc1, round robin cycles to acc2
    const next1 = await tm.autoSelectHighestQuota(quotas, "test", "gemini-3.7-flash");
    expect(next1?.email).toBe("acc2@test.com");

    tm.dispose();
  });

  test("Round Robin respects Tier Priority by excluding Free accounts when Pro accounts have quota", async () => {
    const now = Date.now();
    const accounts: Account[] = [
      {
        id: "acc_pro1",
        email: "pro1@test.com",
        tier: "pro",
        status: "active",
        sortOrder: 0,
        tokenExpiresAt: Math.floor(now / 1000) + 3600,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "acc_free",
        email: "free@test.com",
        tier: "free",
        status: "active",
        sortOrder: 1,
        tokenExpiresAt: Math.floor(now / 1000) + 3600,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "acc_pro2",
        email: "pro2@test.com",
        tier: "pro",
        status: "active",
        sortOrder: 2,
        tokenExpiresAt: Math.floor(now / 1000) + 3600,
        createdAt: now,
        updatedAt: now,
      },
    ];

    const ctx = createMockContext(accounts, "pro1@test.com");
    const tm = new TokenManager(ctx, () => {});
    await tm.initialize();
    await tm.updateConfig({ rotationStrategy: "round_robin" });

    const quotas = {
      "pro1@test.com": { email: "pro1@test.com", tier: "pro", families: [{ key: "gemini", label: "Gemini", percent: 60 }], models: [], lastUpdated: now },
      "free@test.com": { email: "free@test.com", tier: "free", families: [{ key: "gemini", label: "Gemini", percent: 100 }], models: [], lastUpdated: now },
      "pro2@test.com": { email: "pro2@test.com", tier: "pro", families: [{ key: "gemini", label: "Gemini", percent: 80 }], models: [], lastUpdated: now },
    } satisfies Record<string, AccountQuota>;

    // Round Robin should cycle from pro1 directly to pro2, skipping free@test.com
    const next = await tm.autoSelectHighestQuota(quotas, "test", "gemini-3.7-flash");
    expect(next?.email).toBe("pro2@test.com");

    tm.dispose();
  });

  test("Round Robin respects Timing Priority by staying on active account if reset is within 30 minutes", async () => {
    const now = Date.now();
    const accounts: Account[] = [
      {
        id: "acc_active",
        email: "active@test.com",
        tier: "pro",
        status: "active",
        sortOrder: 0,
        tokenExpiresAt: Math.floor(now / 1000) + 3600,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "acc_next",
        email: "next@test.com",
        tier: "pro",
        status: "active",
        sortOrder: 1,
        tokenExpiresAt: Math.floor(now / 1000) + 3600,
        createdAt: now,
        updatedAt: now,
      },
    ];

    const ctx = createMockContext(accounts, "active@test.com");
    const tm = new TokenManager(ctx, () => {});
    await tm.initialize();
    await tm.updateConfig({ rotationStrategy: "round_robin" });

    const quotas = {
      "active@test.com": {
        email: "active@test.com",
        tier: "pro",
        families: [{ key: "gemini", label: "Gemini", percent: 35, limit5h: { percent: 35, resetTime: new Date(now + 20 * 60000).toISOString() } }],
        models: [],
        lastUpdated: now,
      },
      "next@test.com": {
        email: "next@test.com",
        tier: "pro",
        families: [{ key: "gemini", label: "Gemini", percent: 90 }],
        models: [],
        lastUpdated: now,
      },
    } satisfies Record<string, AccountQuota>;

    // Active account resets in 20 minutes with 35% quota -> Timing Priority holds active account
    const select = await tm.autoSelectHighestQuota(quotas, "test", "gemini-3.7-flash");
    expect(select).toBeNull();

    tm.dispose();
  });
});



