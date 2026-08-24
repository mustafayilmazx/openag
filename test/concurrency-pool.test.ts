import { describe, expect, test } from "bun:test";
import { runWithConcurrency } from "../src/core/quota-monitor.js";

describe("runWithConcurrency bounded worker pool", () => {
  test("processes items within specified concurrency limit", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    let activeWorkers = 0;
    let maxObservedActive = 0;

    const results = await runWithConcurrency(items, 3, async (item) => {
      activeWorkers++;
      maxObservedActive = Math.max(maxObservedActive, activeWorkers);
      await new Promise((r) => setTimeout(r, 20));
      activeWorkers--;
      return item * 2;
    });

    expect(maxObservedActive).toBeLessThanOrEqual(3);
    expect(results.length).toBe(items.length);
    for (let i = 0; i < items.length; i++) {
      const res = results[i];
      expect(res?.status).toBe("fulfilled");
      if (res?.status === "fulfilled") {
        expect(res.value).toBe(items[i]! * 2);
      }
    }
  });

  test("handles rejected promises gracefully without terminating remaining tasks", async () => {
    const items = [10, 20, 30, 40];

    const results = await runWithConcurrency(items, 2, async (item) => {
      if (item === 20) {
        throw new Error("Deliberate failure on 20");
      }
      return item + 1;
    });

    expect(results.length).toBe(4);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("rejected");
    expect(results[2]?.status).toBe("fulfilled");
    expect(results[3]?.status).toBe("fulfilled");
  });

  test("handles empty items array cleanly", async () => {
    const results = await runWithConcurrency([], 4, async () => "value");
    expect(results).toEqual([]);
  });
});
