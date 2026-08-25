/**
 * Screen management (#TERMINAL UX / #0096 REDUCED MOTION):
 * - Default mode preserves scrollback: we print linearly and only rewrite the
 *   live status line region.
 * - Spinner renders as an animated glyph on TTY with color+unicode, and as
 *   plain textual progress otherwise. No fake percentages — real states only.
 */
import type { Stylizer } from "./theme.js";

const GLYPHS_UNICODE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GLYPHS_ASCII = ["|", "/", "-", "\\"];

export class ActivityIndicator {
  private frames: string[];
  private idx = 0;
  private timer?: NodeJS.Timeout;
  private lastLine = "";
  private active = false;

  constructor(
    private st: Stylizer,
    private opts: { unicode: boolean; tty: boolean; reducedMotion: boolean },
  ) {
    this.frames = this.opts.unicode ? GLYPHS_UNICODE : GLYPHS_ASCII;
  }

  start(label: string): void {
    this.active = true;
    if (!this.opts.tty || this.opts.reducedMotion) {
      this.writeLine(this.st.muted(label + " …"));
      return;
    }
    const tick = () => {
      if (!this.active) return;
      const frame = this.frames[this.idx++ % this.frames.length]!;
      this.rewriteLiveLine(`${this.st.accent(frame)} ${label}`);
      this.timer = setTimeout(tick, 90);
    };
    tick();
  }

  /** Update the label without fabricating progress. */
  label(text: string): void {
    if (!this.active) return;
    if (!this.opts.tty || this.opts.reducedMotion) return;
    this.rewriteLiveLine(`${this.st.accent(this.frames[this.idx % this.frames.length]!)} ${text}`);
  }

  stop(finalMessage?: string): void {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.timer);
    if (this.opts.tty && !this.opts.reducedMotion) {
      this.clearLiveLine();
    }
    if (finalMessage) this.writeLine(finalMessage);
  }

  private writeLine(s: string): void {
    process.stdout.write(s + "\n");
  }

  private rewriteLiveLine(s: string): void {
    this.lastLine = s;
    process.stdout.write(`\r\u001b[2K${s}`);
  }

  private clearLiveLine(): void {
    if (this.lastLine) process.stdout.write("\r\u001b[2K");
    this.lastLine = "";
  }
}
