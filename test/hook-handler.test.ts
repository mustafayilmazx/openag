import { describe, expect, test } from "bun:test";
import { HookServer } from "../src/core/hook-server.js";
import type { QuotaMonitor } from "../src/core/quota-monitor.js";
import type { TokenManager } from "../src/core/token-manager.js";

describe("Antigravity Hook Server & PreInvocation Bridge", () => {
  test("starts loopback server, responds to health check, and processes pre-invocation queries", async () => {
    let autoRotateCalledWith = "";

    const mockTokenManager = {
      getActiveEmail: () => "primary@example.com",
      autoSelectHighestQuota: async (_quotas: unknown, _reason: string, targetModel: string) => {
        autoRotateCalledWith = targetModel;
        if (targetModel.includes("claude")) {
          return { email: "claude-pro@example.com" };
        }
        return null;
      },
      getEffectiveQuota: () => ({ percent: 92, resetTs: Infinity }),
    };

    const mockQuotaMonitor = {
      getAllQuotas: () => ({}),
    };

    const server = new HookServer(
      mockTokenManager as unknown as TokenManager,
      mockQuotaMonitor as unknown as QuotaMonitor,
      () => {},
    );
    const port = await server.start(0);

    expect(port).toBeGreaterThan(0);
    expect(server.getPort()).toBe(port);

    // 1. Health check
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    expect(healthRes.status).toBe(200);
    const healthData = (await healthRes.json()) as { status: string; activeAccount: string };
    expect(healthData.status).toBe("ok");
    expect(healthData.activeAccount).toBe("primary@example.com");

    // 2. Pre-invocation when not rotating
    const preResNoRotate = await fetch(`http://127.0.0.1:${port}/pre-invocation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelName: "gemini-2.5-pro", invocationNum: 1 }),
    });
    expect(preResNoRotate.status).toBe(200);
    const noRotateData = (await preResNoRotate.json()) as { rotated: boolean; activeEmail: string };
    expect(noRotateData.rotated).toBe(false);
    expect(noRotateData.activeEmail).toBe("primary@example.com");
    expect(autoRotateCalledWith).toBe("gemini-2.5-pro");

    // 3. Pre-invocation when rotating
    const preResRotate = await fetch(`http://127.0.0.1:${port}/pre-invocation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelName: "claude-3.7-sonnet", invocationNum: 2 }),
    });
    expect(preResRotate.status).toBe(200);
    const rotateData = (await preResRotate.json()) as { rotated: boolean; email?: string; percent?: number };
    expect(rotateData.rotated).toBe(true);
    expect(rotateData.email).toBe("claude-pro@example.com");
    expect(rotateData.percent).toBe(92);

    server.dispose();
  });
});
