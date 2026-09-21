import type { Account } from "../types.js";

export function resolveModelFamily(modelName?: string): "gemini" | "claude" | "other" {
  if (!modelName) return "other";
  const lower = modelName.toLowerCase();
  if (
    lower.includes("claude") ||
    lower.includes("sonnet") ||
    lower.includes("opus") ||
    lower.includes("haiku") ||
    lower.includes("gpt") ||
    lower.includes("oss")
  ) {
    return "claude";
  }
  if (lower.includes("gemini")) {
    return "gemini";
  }
  return "other";
}

export const DRAIN_WINDOW_MS = 30 * 60 * 1000;
export const IMMINENT_RESET_MS = 45 * 60 * 1000;

export function matchesModelAffinity(account: Account, modelFamily: "gemini" | "claude" | "other"): boolean {
  if (!account.affinity || account.affinity === "all" || modelFamily === "other") return true;
  return account.affinity === modelFamily;
}
