#!/usr/bin/env node
import { CliEngine } from "./engine.js";
import { C, makeMeter, pad, truncate } from "./tui/render.js";
import { TuiApp } from "./tui/app.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || "tui";

  const engine = new CliEngine();

  switch (command) {
    case "tui":
    case "dashboard": {
      const app = new TuiApp(engine);
      await app.start();
      break;
    }

    case "status": {
      await engine.init({ startServices: false });
      await engine.refreshQuotas();
      const accounts = engine.accounts;
      const quotas = engine.getAllQuotas();
      const active = engine.activeEmail;

      process.stdout.write(`\n${C.bold(C.cyan("OpenAG"))} Status — Active: ${active ? C.bold(C.green(active)) : C.yellow("None")} (Strategy: ${engine.config.rotationStrategy})\n`);
      process.stdout.write("─".repeat(100) + "\n");

      if (accounts.length === 0) {
        process.stdout.write("No accounts found. Run `openag login` to add an account.\n\n");
        process.exit(0);
      }

      process.stdout.write(
        `${pad("Account", 30)} ${pad("Tier", 8)} ${pad("Gemini (5h)", 22)} ${pad("Gemini (7d)", 22)} ${pad("Claude (7d)", 20)}\n`
      );
      process.stdout.write("─".repeat(100) + "\n");

      for (const acc of accounts) {
        const isActive = acc.email.toLowerCase() === active.toLowerCase();
        const emailStr = (isActive ? C.bold(C.green("► ")) : "  ") + truncate(acc.email, 27);

        const q = quotas[acc.email.toLowerCase()];
        const gFam = q?.families?.find((f) => f.key === "gemini");
        const cFam = q?.families?.find((f) => f.key === "claude");

        const gem5h = gFam?.limit5h?.percent ?? gFam?.percent ?? 100;
        const gemWk = gFam?.limitWeekly?.percent ?? 100;
        const claWk = cFam?.limitWeekly?.percent ?? cFam?.percent ?? 100;

        const meterGem5h = makeMeter(gem5h, 8, gFam?.limit5h?.resetTime);
        const meterGemWk = makeMeter(gemWk, 8, gFam?.limitWeekly?.resetTime);
        const meterClaWk = makeMeter(claWk, 8, cFam?.limitWeekly?.resetTime);

        process.stdout.write(
          `${pad(emailStr, 30)} ${pad(acc.tier.toUpperCase(), 8)} ${pad(meterGem5h, 22)} ${pad(meterGemWk, 22)} ${pad(meterClaWk, 20)}\n`
        );
      }
      process.stdout.write("─".repeat(100) + "\n\n");
      engine.dispose();
      process.exit(0);
      break;
    }

    case "switch": {
      const targetEmail = args[1];
      if (!targetEmail) {
        process.stderr.write("Usage: openag switch <email>\n");
        process.exit(1);
      }
      await engine.init({ startServices: false });
      const res = await engine.selectAccount(targetEmail);
      if (res) {
        process.stdout.write(`✓ Active account switched to: ${res.email}\n`);
        process.stdout.write(`✓ Synced to Windows Credential Manager (gemini:antigravity) & IDE\n`);
      } else {
        process.stderr.write(`Account "${targetEmail}" not found in pool or is disabled.\n`);
        process.exit(1);
      }
      engine.dispose();
      process.exit(0);
      break;
    }

    case "login":
    case "add": {
      await engine.init({ startServices: false });
      process.stdout.write("Opening browser for Google authentication...\n");
      const acc = await engine.addAccountViaOAuth();
      if (acc) {
        process.stdout.write(`✓ Successfully added and activated: ${acc.email}\n`);
      } else {
        process.stderr.write("Login cancelled or failed.\n");
        process.exit(1);
      }
      engine.dispose();
      process.exit(0);
      break;
    }

    case "sync": {
      await engine.init({ startServices: false });
      const ok = await engine.syncActiveToKeyring();
      if (ok) {
        process.stdout.write(`✓ Synced active account to Windows Credential Manager (gemini:antigravity)\n`);
      } else {
        process.stderr.write("Sync failed. Check if an active account is configured.\n");
        process.exit(1);
      }
      engine.dispose();
      process.exit(0);
      break;
    }

    case "daemon": {
      engine.autoRotationActive = true;
      await engine.init({ startServices: true });
      process.stdout.write(`OpenAG Daemon running in background on port ${engine.config.hookPort}...\n`);
      process.stdout.write("Auto-rotation: ENABLED | Press Ctrl+C to exit.\n");

      const shutdown = () => {
        process.stdout.write("\nShutting down OpenAG daemon...\n");
        engine.dispose();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      // Keep alive
      await new Promise(() => {});
      break;
    }

    case "help":
    case "--help":
    case "-h":
    default: {
      process.stdout.write(`
${C.bold(C.cyan("OpenAG"))} — Universal AI Quota Manager for Antigravity & Antigravity IDE

${C.bold("USAGE:")}
  openag                     Launch interactive Terminal UI (TUI) dashboard
  openag status              Display current accounts, tiers, and quotas
  openag switch <email>      Switch active account and sync to OS Keyring & IDE
  openag login               Add a new Google account via browser OAuth
  openag sync                Force sync active account to Windows Credential Manager
  openag daemon              Run headless background rotation & hook daemon
  openag help                Show this help message

${C.bold("TUI HOTKEYS:")}
  [↑/↓] Navigate accounts    [Space/Enter] Activate account
  [a] Add account via OAuth  [t] Toggle enabled in pool
  [m] Cycle model affinity   [p] Cycle role (Primary / Reserve)
  [s] Cycle strategy         [r] Refresh quotas now
  [x] Remove account         [q] Quit dashboard
\n`);
      process.exit(0);
    }
  }
}

void main().catch((err: unknown) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});
