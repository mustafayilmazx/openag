import * as fs from "node:fs";

export const DEFAULT_HOOK_PORT = 27182;

interface PreInvocationResponse {
  rotated?: boolean;
  email?: string;
  percent?: number;
  model?: string;
  activeEmail?: string;
  error?: string;
}

export async function runHook(): Promise<void> {
  let rawInput = "";
  try {
    rawInput = fs.readFileSync(0, "utf-8");
  } catch { /* ignore empty stdin */ }

  const port = process.env.OPENAG_HOOK_PORT ? parseInt(process.env.OPENAG_HOOK_PORT, 10) : DEFAULT_HOOK_PORT;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/pre-invocation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rawInput || "{}",
      signal: AbortSignal.timeout(500),
    });

    if (res.ok) {
      // SAFETY: JSON response from local OpenAG extension HookServer
      const data = (await res.json()) as PreInvocationResponse;
      if (data.rotated && data.email) {
        const modelInfo = data.model ? ` for ${data.model}` : "";
        const quotaInfo = typeof data.percent === "number" ? ` (${data.percent}% remaining${modelInfo})` : "";
        const msg = `[OpenAG] Auto-rotated active account to ${data.email}${quotaInfo}`;

        const output = {
          injectSteps: [
            {
              ephemeralMessage: msg,
            },
          ],
        };
        process.stdout.write(`${JSON.stringify(output)}\n`);
        return;
      }
    }
  } catch {
    // Graceful fallback: extension is offline or unreachable in < 500ms
  }

  process.stdout.write("{}\n");
}

if (process.env.NODE_ENV !== "test") {
  void runHook();
}
