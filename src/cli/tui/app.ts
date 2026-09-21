import type { RotationStrategy } from "../../types.js";
import type { CliEngine } from "../engine.js";
import { renderDashboard } from "./render.js";
import { TerminalScreen, type KeyEvent } from "./screen.js";

export class TuiApp {
  private readonly screen = new TerminalScreen();
  private selectedIndex = 0;
  private statusMessage = "";
  private statusTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;

  constructor(private readonly engine: CliEngine) {}

  public async start(): Promise<void> {
    this.engine.autoRotationActive = true;
    await this.engine.init({ startServices: true });

    this.engine.onUpdate = () => {
      this.clampSelection();
      this.draw();
    };

    this.engine.onLog = () => {
      this.draw();
    };

    this.screen.init(
      (key) => this.handleKey(key),
      () => this.draw(),
    );

    // 1-second refresh loop to tick countdown timers
    this.tickTimer = setInterval(() => {
      this.draw();
    }, 1000);

    this.draw();
  }

  private setStatus(msg: string, durationMs = 3000): void {
    this.statusMessage = msg;
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => {
      this.statusMessage = "";
      this.draw();
    }, durationMs);
    this.draw();
  }

  private clampSelection(): void {
    const max = Math.max(0, this.engine.accounts.length - 1);
    if (this.selectedIndex > max) this.selectedIndex = max;
    if (this.selectedIndex < 0) this.selectedIndex = 0;
  }

  private draw(): void {
    this.clampSelection();
    const { width, height } = this.screen.dimensions;
    const output = renderDashboard({
      accounts: this.engine.accounts,
      quotas: this.engine.getAllQuotas(),
      selectedIndex: this.selectedIndex,
      activeEmail: this.engine.activeEmail,
      strategy: this.engine.config.rotationStrategy,
      logLines: this.engine.logHistory,
      statusMessage: this.statusMessage,
      width,
      height,
    });
    this.screen.render(output);
  }

  private async handleKey(key: KeyEvent): Promise<void> {
    const accs = this.engine.accounts;
    const selected = accs[this.selectedIndex];

    switch (key.name) {
      case "up":
      case "k":
        if (this.selectedIndex > 0) {
          this.selectedIndex--;
          this.draw();
        }
        break;

      case "down":
      case "j":
        if (this.selectedIndex < accs.length - 1) {
          this.selectedIndex++;
          this.draw();
        }
        break;

      case "space":
      case "return":
      case "enter":
        if (selected) {
          await this.engine.selectAccount(selected.email);
          this.setStatus(`Activated account: ${selected.email}`);
        }
        break;

      case "a":
        this.setStatus("Opening browser for Google login...");
        void this.engine.addAccountViaOAuth().then((acc) => {
          if (acc) this.setStatus(`Added account: ${acc.email}`);
        });
        break;

      case "t":
        if (selected) {
          await this.engine.toggleAccount(selected.email);
          this.setStatus(`Toggled ${selected.email} (${selected.status})`);
        }
        break;

      case "m":
        if (selected) {
          await this.engine.cycleAffinity(selected.email);
          this.setStatus(`Affinity for ${selected.email}: ${selected.affinity?.toUpperCase()}`);
        }
        break;

      case "p":
        if (selected) {
          await this.engine.cycleRole(selected.email);
          this.setStatus(`Role pool for ${selected.email}: ${selected.role?.toUpperCase()}`);
        }
        break;

      case "s": {
        const strats: RotationStrategy[] = ["auto_highest", "cache_optimized", "round_robin"];
        const curIdx = strats.indexOf(this.engine.config.rotationStrategy);
        const nextStrat = strats[(curIdx + 1) % strats.length]!;
        await this.engine.setStrategy(nextStrat);
        this.setStatus(`Strategy: ${nextStrat}`);
        break;
      }

      case "r":
        this.setStatus("Refreshing quotas across all accounts...");
        void this.engine.refreshQuotas();
        break;

      case "x":
        if (selected) {
          const removedEmail = selected.email;
          await this.engine.removeAccount(removedEmail);
          this.setStatus(`Removed account: ${removedEmail}`);
        }
        break;

      case "q":
      case "escape":
        this.stop();
        process.exit(0);
        break;
    }
  }

  public stop(): void {
    this.engine.autoRotationActive = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.screen.restore();
    this.engine.dispose();
  }
}
