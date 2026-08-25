/**
 * Terminal output sanitization (#0072 terminal escape defense).
 * Untrusted content (tool output, file contents, model text, web pages) must
 * never inject control sequences into the user's terminal: no ANSI/CSI/OSC,
 * no title manipulation, no hyperlinks, no cursor movement, no hidden chars.
 */

/** Strip every C0/C1 control char except \n and \t; strip all escape sequences. */
export function sanitizeForTerminal(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    const code = ch.codePointAt(0)!;
    if (ch === "\u001b" || ch === "\u009b") {
      i += skipEscapeSequence(input, i);
      continue;
    }
    if (code === 0x09 || code === 0x0a) {
      out += ch;
      i++;
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      i++; // drop other control characters silently
      continue;
    }
    // Zero-width / bidi override characters are dropped for bidi safety (#0211).
    if (
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      code === 0x2066 ||
      code === 0x2067 ||
      code === 0x2068 ||
      code === 0x2069 ||
      code === 0xfeff
    ) {
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function skipEscapeSequence(input: string, start: number): number {
  let i = start + 1;
  const c1 = input[i];
  if (c1 === "[" || c1 === "\u009b") {
    i++;
    // CSI: parameter bytes, intermediate bytes, final byte @ to ~
    while (i < input.length) {
      const c = input[i]!;
      const cp = c.codePointAt(0)!;
      if (cp >= 0x40 && cp <= 0x7e) return i - start + 1;
      if (cp < 0x20 || cp > 0x3f) return i - start + 1 > 2 ? i - start + 1 : i - start + 1;
      i++;
    }
    return i - start;
  }
  if (c1 === "]") {
    i++;
    // OSC terminated by BEL or ST (ESC \)
    while (i < input.length) {
      if (input[i] === "\u0007") return i - start + 1;
      if (input[i] === "\u001b" && input[i + 1] === "\\") return i - start + 2;
      i++;
    }
    return i - start;
  }
  // Other ESC sequences consume one or two more chars.
  if (c1 !== undefined) i++;
  if (c1 === "P" || c1 === "X" || c1 === "^" || c1 === "_") {
    while (i < input.length) {
      if (input[i] === "\u001b" && input[i + 1] === "\\") return i - start + 2;
      i++;
    }
  }
  return Math.min(i - start + 0, input.length - start) + (i - start === 1 ? 1 : 0);
}
