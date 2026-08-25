/**
 * Theme system (#TERMINAL VISUAL LANGUAGE). Color reinforces hierarchy only;
 * meaning never depends on color alone. NO_COLOR and TERM=dumb disable all
 * styling; themes: dark (default), light, high-contrast, monochrome.
 */
export type ThemeName = "dark" | "light" | "high-contrast" | "monochrome";

export interface Theme {
  name: ThemeName;
  primary: string;
  secondary: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  muted: string;
}

const THEMES: Record<ThemeName, Theme> = {
  dark: { name: "dark", primary: "36", secondary: "90", accent: "35", success: "32", warning: "33", error: "31", muted: "90" },
  light: { name: "light", primary: "34", secondary: "90", accent: "35", success: "32", warning: "33;1", error: "31;1", muted: "90" },
  "high-contrast": { name: "high-contrast", primary: "97", secondary: "37;1", accent: "95;1", success: "92;1", warning: "93;1", error: "91;1", muted: "37" },
  monochrome: { name: "monochrome", primary: "0", secondary: "2", accent: "1", success: "0", warning: "1", error: "7", muted: "2" },
};

export interface StyleContext {
  theme: Theme;
  colorEnabled: boolean;
  unicode: boolean;
}

export function pickTheme(name?: string): Theme {
  switch ((name ?? "").toLowerCase()) {
    case "light":
      return THEMES.light;
    case "high-contrast":
    case "highcontrast":
      return THEMES["high-contrast"];
    case "monochrome":
    case "mono":
      return THEMES.monochrome;
    default:
      return THEMES.dark;
  }
}

function wrap(enabled: boolean, codes: string, text: string): string {
  if (!enabled || codes === "0") return text;
  if (codes === "2") return dim(text);
  if (codes === "1") return bold(text);
  if (codes === "7") return reverse(text);
  return `\u001b[${codes}m${text}\u001b[0m`;
}

function bold(text: string): string {
  return `${text}`;
}
function dim(text: string): string {
  return `${text}`;
}
function reverse(text: string): string {
  return `[${text}]`;
}

/** Style facade bound to a StyleContext; all renderers take one. */
export class Stylizer {
  constructor(private ctx: StyleContext) {}

  private c(code: string, text: string): string {
    return this.ctx.colorEnabled ? `\u001b[${code}m${text}\u001b[0m` : text;
  }

  primary(t: string): string {
    return this.c(this.ctx.theme.primary, t);
  }
  accent(t: string): string {
    return this.c(this.ctx.theme.accent, t);
  }
  success(t: string): string {
    return this.c(this.ctx.theme.success, t);
  }
  warning(t: string): string {
    return this.c(this.ctx.theme.warning, t);
  }
  error(t: string): string {
    return this.c(this.ctx.theme.error, t);
  }
  muted(t: string): string {
    return this.c(this.ctx.theme.muted, t);
  }
  boldOn(t: string): string {
    return this.c("1", t);
  }

  /** Status glyphs carry symbols + text so color is never the only signal (#0094). */
  statusOk(): string {
    return this.success(this.ctx.unicode ? "✓" : "[ok]");
  }
  statusWarn(): string {
    return this.warning(this.ctx.unicode ? "!" : "[warn]");
  }
  statusError(): string {
    return this.error(this.ctx.unicode ? "✗" : "[fail]");
  }
  bullet(): string {
    return this.muted(this.ctx.unicode ? "•" : "-");
  }
}

/**
 * Strip ANSI sequences — used for width math and snapshot tests.
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}
