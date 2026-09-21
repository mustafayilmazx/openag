import type { Account, AccountQuota, RotationStrategy } from "../../types.js";

// ANSI Color and Styling Helpers
export const C = {
  reset: "\x1b[0m",
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  italic: (s: string) => `\x1b[3m${s}\x1b[23m`,
  underline: (s: string) => `\x1b[4m${s}\x1b[24m`,
  inverse: (s: string) => `\x1b[7m${s}\x1b[27m`,

  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[39m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[39m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
  white: (s: string) => `\x1b[37m${s}\x1b[39m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[39m`,

  bgBlue: (s: string) => `\x1b[44m${s}\x1b[49m`,
  bgCyan: (s: string) => `\x1b[46m${s}\x1b[49m`,
  bgGreen: (s: string) => `\x1b[42m${s}\x1b[49m`,
  bgYellow: (s: string) => `\x1b[43m${s}\x1b[49m`,
  bgRed: (s: string) => `\x1b[41m${s}\x1b[49m`,
  bgGray: (s: string) => `\x1b[100m${s}\x1b[49m`,
};

export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

export function pad(str: string, targetLen: number, align: "left" | "right" = "left"): string {
  const visibleLen = stripAnsi(str).length;
  if (visibleLen >= targetLen) return str;
  const padding = " ".repeat(targetLen - visibleLen);
  return align === "left" ? str + padding : padding + str;
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

export function formatResetTime(isoString?: string): string {
  if (!isoString) return "";
  const diffMs = Date.parse(isoString) - Date.now();
  if (diffMs <= 0 || Number.isNaN(diffMs)) return "";

  const totalMin = Math.round(diffMs / 60000);
  if (totalMin < 60) return `${totalMin}m`;

  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

export function makeMeter(percent: number, width = 10, resetTime?: string): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;

  const barChars = "█".repeat(filled) + "░".repeat(empty);
  let coloredBar: string;

  if (clamped >= 50) {
    coloredBar = C.green(barChars);
  } else if (clamped >= 20) {
    coloredBar = C.yellow(barChars);
  } else {
    coloredBar = C.red(barChars);
  }

  const pctStr = `${clamped}%`.padStart(4);
  const resetStr = resetTime ? ` ${C.gray(formatResetTime(resetTime))}` : "";
  return `[${coloredBar}] ${pctStr}${resetStr}`;
}

export interface RenderState {
  accounts: Account[];
  quotas: Record<string, AccountQuota>;
  selectedIndex: number;
  activeEmail: string;
  strategy: RotationStrategy;
  logLines: string[];
  statusMessage?: string;
  width: number;
  height: number;
}

export function renderDashboard(state: RenderState): string {
  const lines: string[] = [];
  const W = Math.max(80, state.width);

  // 1. Header Box
  const title = ` ${C.bold(C.cyan("OpenAG"))} ${C.dim("v1.4.0")} - Universal AI Quota Manager `;
  const borderTop = "┌─" + "─".repeat(Math.max(0, W - 4)) + "┐";
  lines.push(C.cyan(borderTop));

  const activeBadge = state.activeEmail
    ? `${C.bold(C.white(state.activeEmail))} ${C.bgGreen(" ACTIVE ")}`
    : C.yellow("No Active Account");
  const stratBadge = `Strategy: ${C.bold(C.magenta(state.strategy.toUpperCase()))}`;
  const syncBadge = `Desktop: ${C.green("SYNCED")} | IDE: ${C.green("ONLINE")}`;

  const headerContent = `│ ${title} | ${activeBadge} | ${stratBadge} | ${syncBadge}`;
  const headerPadded = pad(headerContent, W - 1) + "│";
  lines.push(headerPadded);

  const divider = "├─" + "─".repeat(Math.max(0, W - 4)) + "┤";
  lines.push(C.cyan(divider));

  // 2. Table Column Headers
  const colSel = "  ";
  const colAcc = pad(C.bold("Account / Email"), 28);
  const colRole = pad(C.bold("Role / Affinity"), 18);
  const colTier = pad(C.bold("Tier"), 7);
  const colGemini5h = pad(C.bold("Gemini (5h)"), 22);
  const colGeminiWk = pad(C.bold("Gemini (7d)"), 22);
  const colClaudeWk = pad(C.bold("Claude (7d)"), 20);
  const colStatus = pad(C.bold("Status"), 10);

  const colHeaderLine = `│ ${colSel}${colAcc} ${colRole} ${colTier} ${colGemini5h} ${colGeminiWk} ${colClaudeWk} ${colStatus}`;
  lines.push(pad(colHeaderLine, W - 1) + "│");
  lines.push(C.cyan("├─" + "─".repeat(Math.max(0, W - 4)) + "┤"));

  // 3. Accounts Rows
  if (state.accounts.length === 0) {
    const emptyMsg = C.gray("No accounts configured yet. Press [a] to add your first Google account.");
    lines.push(pad(`│   ${emptyMsg}`, W - 1) + "│");
  } else {
    state.accounts.forEach((acc, idx) => {
      const isSelected = idx === state.selectedIndex;
      const isActive = acc.email.toLowerCase() === state.activeEmail.toLowerCase();
      const isDisabled = acc.status === "disabled";

      const selMarker = isSelected ? C.bold(C.cyan("► ")) : "  ";
      const emailDisplay = acc.alias ? `${acc.alias} (${acc.email.split("@")[0]})` : acc.email;
      const emailFormatted = isDisabled
        ? C.gray(truncate(emailDisplay, 26))
        : isActive
          ? C.bold(C.green(truncate(emailDisplay, 26)))
          : truncate(emailDisplay, 26);

      const q = state.quotas[acc.email.toLowerCase()];
      const gFam = q?.families?.find((f) => f.key === "gemini");
      const cFam = q?.families?.find((f) => f.key === "claude");

      const gem5h = gFam?.limit5h?.percent ?? gFam?.percent ?? 100;
      const gemWk = gFam?.limitWeekly?.percent ?? 100;
      const claWk = cFam?.limitWeekly?.percent ?? cFam?.percent ?? 100;

      const meterGem5h = makeMeter(gem5h, 8, gFam?.limit5h?.resetTime);
      const meterGemWk = makeMeter(gemWk, 8, gFam?.limitWeekly?.resetTime);
      const meterClaWk = makeMeter(claWk, 8, cFam?.limitWeekly?.resetTime);

      const roleBadge = `${(acc.role || "primary").toUpperCase()}/${(acc.affinity || "all").toUpperCase()}`;
      const roleFormatted = (acc.role === "reserve") ? C.gray(roleBadge) : C.blue(roleBadge);
      const tierFormatted = C.bold(acc.tier ? acc.tier.toUpperCase() : "PRO");

      let statusBadge = C.gray("IDLE");
      if (isDisabled) statusBadge = C.red("DISABLED");
      else if (isActive) statusBadge = C.bgGreen(" ACTIVE ");

      const rowStr = `│ ${selMarker}${pad(emailFormatted, 28)} ${pad(roleFormatted, 18)} ${pad(tierFormatted, 7)} ${pad(meterGem5h, 22)} ${pad(meterGemWk, 22)} ${pad(meterClaWk, 20)} ${pad(statusBadge, 10)}`;

      lines.push(pad(rowStr, W - 1) + "│");
    });
  }

  lines.push(C.cyan(divider));

  // 4. Activity Logs (Last 6 entries)
  lines.push(`│ ${C.bold(C.cyan("Live Activity & Event Stream"))}:`);
  const recentLogs = state.logLines.slice(-6);
  if (recentLogs.length === 0) {
    lines.push(pad(`│   ${C.gray("Engine idle. Ready for requests.")}`, W - 1) + "│");
  } else {
    for (const log of recentLogs) {
      lines.push(pad(`│   ${C.gray(truncate(log, W - 6))}`, W - 1) + "│");
    }
  }

  lines.push(C.cyan(divider));

  // 5. Hotkeys & Controls Bar
  const row1 = `${C.bold("[↑/↓]")} Select  ${C.bold("[Space/Enter]")} Activate  ${C.bold("[a]")} Add Account  ${C.bold("[t]")} Toggle Enabled  ${C.bold("[r]")} Refresh Quotas`;
  const row2 = `${C.bold("[m]")} Affinity  ${C.bold("[p]")} Role Pool      ${C.bold("[s]")} Strategy     ${C.bold("[x]")} Remove Account  ${C.bold("[q]")} Quit`;

  lines.push(pad(`│ ${row1}`, W - 1) + "│");
  lines.push(pad(`│ ${row2}`, W - 1) + "│");

  const borderBottom = "└─" + "─".repeat(Math.max(0, W - 4)) + "┘";
  lines.push(C.cyan(borderBottom));

  if (state.statusMessage) {
    lines.push(C.bold(C.yellow(` ℹ ${state.statusMessage}`)));
  }

  return lines.join("\n");
}
