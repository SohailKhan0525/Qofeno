/**
 * Width-aware text layout (#0091 UNICODE ENGINE, #0251 low-bandwidth/narrow).
 * Correct display width for CJK/wide chars and emoji; wrapping that never
 * loses characters.
 */
import { stripAnsi } from "./theme.js";

export function displayWidth(text: string): number {
  const bare = stripAnsi(text);
  let w = 0;
  for (const ch of bare) {
    const cp = ch.codePointAt(0)!;
    w += charWidth(cp);
  }
  return w;
}

export function charWidth(cp: number): number {
  if (cp === 0) return 0;
  // Combining marks
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f)) return 0;
  // Wide ranges (CJK, Hangul, fullwidth forms, emoji blocks)
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff)
  ) {
    return 2;
  }
  return 1;
}

/** Truncate with ellipsis, preserving ANSI-styled prefixes when possible. */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  const bare = stripAnsi(text);
  if (displayWidth(bare) <= maxWidth) return bare;
  if (maxWidth === 1) {
    const first = [...bare][0] ?? "";
    return charWidth(first.codePointAt(0)!) > 1 ? "" : first;
  }
  let out = "";
  let w = 0;
  const limit = maxWidth - 1;
  for (const ch of bare) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > limit) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

/** Wrap plain text to width; hard-breaks long words. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine === "") {
      lines.push("");
      continue;
    }
    let current = "";
    let currentW = 0;
    for (const word of rawLine.split(/(\s+)/)) {
      const wordW = displayWidth(word);
      if (currentW + wordW <= width) {
        current += word;
        currentW += wordW;
        continue;
      }
      if (word.trim() === "") {
        // whitespace overflow: drop trailing spaces
        continue;
      }
      if (current) {
        lines.push(current.replace(/\s+$/, ""));
        current = "";
        currentW = 0;
      }
      if (wordW > width) {
        // hard break
        for (const ch of word) {
          const cw = charWidth(ch.codePointAt(0)!);
          if (currentW + cw > width) {
            lines.push(current);
            current = ch;
            currentW = cw;
          } else {
            current += ch;
            currentW += cw;
          }
        }
      } else {
        current = word;
        currentW = wordW;
      }
    }
    if (current || rawLine === "") lines.push(current);
  }
  return lines.length ? lines : [""];
}

/** Pad/truncate a cell to an exact display width. */
export function fitCell(text: string, width: number): string {
  const w = displayWidth(text);
  if (w > width) return truncateToWidth(text, width);
  return text + " ".repeat(width - w);
}
