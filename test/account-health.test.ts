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

describe("Account Metadata & Health Management", () => {
  it("updates account alias, affinity, and role via updateAccountMeta", async () => {
    const ctx = createMockExtensionContext();
    const tm = new TokenManager(ctx, () => {});
    await tm.initialize();

    await tm.addOrUpdateAccount({
      email: "test@example.com",
      accessToken: "token_1",
      refreshToken: "refresh_1",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      tier: "pro",
      status: "active",
      sortOrder: 0,
    });

    const updated = await tm.updateAccountMeta("test@example.com", {
      alias: "Work Ultra",
      affinity: "claude",
      role: "reserve",
    });

    expect(updated).not.toBeNull();
    expect(updated?.alias).toBe("Work Ultra");
    expect(updated?.affinity).toBe("claude");
    expect(updated?.role).toBe("reserve");

    const reloaded = tm.getAccounts().find((a) => a.email === "test@example.com");
    expect(reloaded?.alias).toBe("Work Ultra");
    expect(reloaded?.affinity).toBe("claude");
    expect(reloaded?.role).toBe("reserve");
  });

  it("sets health status to expired on invalid_grant during refresh", async () => {
    const ctx = createMockExtensionContext();
    const tm = new TokenManager(ctx, () => {});
    await tm.initialize();

    const acc = await tm.addOrUpdateAccount({
      email: "expired@example.com",
      accessToken: "token_old",
      refreshToken: "refresh_bad",
      tokenExpiresAt: 0,
      tier: "pro",
      status: "active",
      sortOrder: 0,
    });

    tm.refreshOAuthToken = () => Promise.reject(new Error("invalid_grant: Token has been revoked"));

    expect(tm.forceRefreshToken(acc)).rejects.toThrow("invalid_grant");

    const refreshedAcc = tm.getAccounts().find((a) => a.email === "expired@example.com");
    expect(refreshedAcc?.health).toBe("expired");
  });

  it("sets health status to tos_required on Terms of Service failure", async () => {
    const ctx = createMockExtensionContext();
    const tm = new TokenManager(ctx, () => {});
    await tm.initialize();

    const acc = await tm.addOrUpdateAccount({
      email: "tos@example.com",
      accessToken: "token_old",
      refreshToken: "refresh_tos",
      tokenExpiresAt: 0,
      tier: "pro",
      status: "active",
      sortOrder: 0,
    });

    tm.refreshOAuthToken = () => Promise.reject(new Error("GCP TOS acceptance required"));

    expect(tm.forceRefreshToken(acc)).rejects.toThrow("TOS");

    const refreshedAcc = tm.getAccounts().find((a) => a.email === "tos@example.com");
    expect(refreshedAcc?.health).toBe("tos_required");
  });
});
