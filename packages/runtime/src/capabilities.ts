/**
 * Terminal & platform capability detection (#0089).
 * Detect; never assume. Everything degrades to a plain, safe fallback.
 */
import { env, stdout } from "node:process";

export interface TerminalCapabilities {
  interactive: boolean;
  isTTY: boolean;
  colorDepth: 0 | 4 | 8 | 24;
  colorEnabled: boolean;
  unicode: boolean;
  mouse: boolean;
  bracketedPaste: boolean;
  ciEnvironment: boolean;
  tmux: boolean;
  screen: boolean;
  ssh: boolean;
  dumb: boolean;
  platform: NodeJS.Platform;
  columns: number;
  rows: number;
}

export function detectCapabilities(): TerminalCapabilities {
  const isTTY = Boolean(stdout.isTTY);
  const term = env.TERM ?? "";
  const ciEnv =
    env.CI === "true" ||
    env.CI === "1" ||
    env.GITHUB_ACTIONS === "true" ||
    env.GITLAB_CI === "true" ||
    env.JENKINS_URL !== undefined ||
    env.TRAVIS === "true";
  const tmux = Boolean(env.TMUX);
  const screen = Boolean(env.STY) || term.startsWith("screen");
  const ssh = Boolean(env.SSH_TTY || env.SSH_CONNECTION);
  const dumb = term === "dumb" || !term;

  let colorDepth: 0 | 4 | 8 | 24 = 0;
  if (!isTTY || env.NO_COLOR) colorDepth = 0;
  else if (/truecolor|24bit/i.test(env.COLORTERM ?? "")) colorDepth = 24;
  else if (/256color/.test(term)) colorDepth = 8;
  else if (isTTY && !dumb) colorDepth = 4;

  return {
    interactive: isTTY && !ciEnv && !dumb,
    isTTY,
    colorDepth,
    colorEnabled: colorDepth > 0,
    // Unicode: assume UTF-8 on modern systems except Windows pre-Terminal or POSIX locale.
    unicode: !dumb && !(process.platform === "win32" && /^(?:POSIX|C)(\..*)?$/.test(env.LC_ALL ?? env.LANG ?? "")),
    mouse: false, // never required; optional enhancement only (#0098)
    bracketedPaste: isTTY && !dumb,
    ciEnvironment: ciEnv,
    tmux,
    screen,
    ssh,
    dumb,
    platform: process.platform,
    columns: clampInt(stdout.columns ?? 80, 20, 1000),
    rows: clampInt(stdout.rows ?? 24, 5, 500),
  };
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.floor(v)));
}
