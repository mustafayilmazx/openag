import * as readline from "node:readline";

export interface KeyEvent {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
}

export class TerminalScreen {
  private isAltScreen = false;
  private onKeyCallback?: (key: KeyEvent) => void;
  private onResizeCallback?: (cols: number, rows: number) => void;

  public init(
    onKey: (key: KeyEvent) => void,
    onResize: (cols: number, rows: number) => void,
  ): void {
    this.onKeyCallback = onKey;
    this.onResizeCallback = onResize;

    if (process.stdout.isTTY) {
      process.stdout.write("\x1b[?1049h"); // Alternate screen buffer
      process.stdout.write("\x1b[?25l");   // Hide cursor
      this.isAltScreen = true;
    }

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      readline.emitKeypressEvents(process.stdin);

      process.stdin.on("keypress", (_str: string, key: readline.Key) => {
        if (!key) return;
        if (key.ctrl && key.name === "c") {
          this.restore();
          process.exit(0);
        }
        this.onKeyCallback?.({
          name: key.name || "",
          ctrl: key.ctrl,
          shift: key.shift,
        });
      });
    }

    process.stdout.on("resize", () => {
      this.onResizeCallback?.(process.stdout.columns || 80, process.stdout.rows || 24);
    });

    const exitHandler = () => this.restore();
    process.on("exit", exitHandler);
    process.on("SIGINT", () => { exitHandler(); process.exit(0); });
    process.on("SIGTERM", () => { exitHandler(); process.exit(0); });
  }

  public get dimensions(): { width: number; height: number } {
    return {
      width: process.stdout.columns || 100,
      height: process.stdout.rows || 30,
    };
  }

  public render(content: string): void {
    if (!this.isAltScreen) return;
    // Move to top-left (1;1) and write content
    process.stdout.write(`\x1b[H${content}`);
  }

  public restore(): void {
    if (this.isAltScreen) {
      process.stdout.write("\x1b[?25h");   // Show cursor
      process.stdout.write("\x1b[?1049l"); // Restore primary screen buffer
      this.isAltScreen = false;
    }
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
      process.stdin.pause();
    }
  }
}
