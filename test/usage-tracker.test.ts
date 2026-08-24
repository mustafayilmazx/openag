import { describe, expect, mock, test } from "bun:test";

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
}));

const { UsageTracker, extractUriFromText, normalizePath } = await import("../src/core/usage-tracker.js");

describe("UsageTracker", () => {
  test("getModelContextLimit returns correct context limits", () => {
    const tracker = new UsageTracker();
    expect(tracker.getModelContextLimit("gemini-3.7-flash")).toBe(1048576);
    expect(tracker.getModelContextLimit("gemini-2.5-pro")).toBe(1048576);
    expect(tracker.getModelContextLimit("claude-3-7-sonnet")).toBe(200000);
    expect(tracker.getModelContextLimit("gpt-oss-128k")).toBe(128000);
    expect(tracker.getModelContextLimit("gpt-4o")).toBe(128000);
    tracker.dispose();
  });

  test("normalizePath canonicalizes Windows, WSL, Linux, and macOS paths", () => {
    // Windows local paths and URIs
    expect(normalizePath("C:\\Users\\lyst\\Documents\\Git\\OpenAG")).toBe("c:/users/lyst/documents/git/openag");
    expect(normalizePath("file:///c:/Users/lyst/Documents/Git/OpenAG")).toBe("c:/users/lyst/documents/git/openag");
    expect(normalizePath("file:///c%3A/Users/lyst/Documents/Git/OpenAG")).toBe("c:/users/lyst/documents/git/openag");

    // WSL remote workspace URIs
    expect(normalizePath("vscode-remote://wsl%2Bubuntu/home/lyst/projects/openag")).toBe("home/lyst/projects/openag");
    expect(normalizePath("vscode-remote://wsl+Debian/home/lyst/projects/openag")).toBe("home/lyst/projects/openag");
    expect(normalizePath("file://wsl$/Ubuntu/home/lyst/projects/openag")).toBe("home/lyst/projects/openag");
    expect(normalizePath("file://wsl.localhost/Ubuntu/home/lyst/projects/openag")).toBe("home/lyst/projects/openag");
    expect(normalizePath("\\home\\lyst\\projects\\openag")).toBe("home/lyst/projects/openag");

    // Linux native paths and URIs
    expect(normalizePath("file:///home/lyst/projects/openag")).toBe("home/lyst/projects/openag");
    expect(normalizePath("/home/lyst/projects/openag")).toBe("home/lyst/projects/openag");

    // macOS native paths and URIs
    expect(normalizePath("file:///Users/lyst/Projects/OpenAG")).toBe("users/lyst/projects/openag");
    expect(normalizePath("/Users/lyst/Projects/OpenAG")).toBe("users/lyst/projects/openag");

    // Remote-SSH and Dev Containers
    expect(normalizePath("vscode-remote://ssh-remote%2Bmyserver/home/lyst/projects/openag")).toBe("home/lyst/projects/openag");
    expect(normalizePath("vscode-remote://dev-container%2Bhex/workspaces/openag")).toBe("workspaces/openag");

    // Edge cases
    expect(normalizePath("")).toBe("");
  });

  test("extractUriFromText extracts and normalizes Windows, WSL, and Linux URIs from trajectory metadata", () => {
    // Windows file URI
    const winBlob = "\n\x1a.file:///c:/Users/lyst/Documents/Git/OpenAG\x12polystree/openag";
    expect(extractUriFromText(winBlob)).toBe("c:/users/lyst/documents/git/openag");

    // WSL vscode-remote URI
    const wslBlob = "\n\x1a.vscode-remote://wsl%2Bubuntu/home/lyst/projects/openag\x12polystree/openag";
    expect(extractUriFromText(wslBlob)).toBe("home/lyst/projects/openag");

    // WSL UNC URI
    const wslUncBlob = "\n\x1a.file://wsl$/Ubuntu/home/lyst/projects/openag\x12polystree/openag";
    expect(extractUriFromText(wslUncBlob)).toBe("home/lyst/projects/openag");

    // Linux file URI
    const linuxBlob = "\n\x1a.file:///home/lyst/projects/openag\x12polystree/openag";
    expect(extractUriFromText(linuxBlob)).toBe("home/lyst/projects/openag");

    // macOS file URI
    const macBlob = "\n\x1a.file:///Users/lyst/Projects/OpenAG\x12polystree/openag";
    expect(extractUriFromText(macBlob)).toBe("users/lyst/projects/openag");

    // Non-URI text
    expect(extractUriFromText("plain text without uri")).toBeNull();
  });

  test("decodeBase64Url correctly decodes base64url encoded JWT payloads with RFC 7515 characters", async () => {
    const { decodeBase64Url, USSBridge } = await import("../src/core/uss-bridge.js");
    const jsonStr = JSON.stringify({ email: "user-test_name@example.com" });
    const base64url = Buffer.from(jsonStr, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const decoded = decodeBase64Url(base64url).toString("utf8");
    expect(decoded).toBe(jsonStr);

    const email = await USSBridge.getEmailFromToken(`header.${base64url}.signature`);
    expect(email).toBe("user-test_name@example.com");
  });

  test("withSqliteDb cleanly handles non-existent or invalid sqlite databases without throwing", async () => {
    const { withSqliteDb } = await import("../src/core/sqlite-utils.js");
    const result = withSqliteDb("/nonexistent/fake-db.db", () => "executed");
    expect(result).toBeNull();
  });
});
