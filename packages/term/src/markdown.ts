/**
 * Terminal markdown renderer (#0008 MESSAGE RENDERER): headings, lists,
 * fenced code blocks, inline code, bold/italic, links shown as text <url>.
 * Output is plain-safe: no raw ANSI from the source ever passes through.
 */
import type { Stylizer } from "./theme.js";
import { sanitizeForTerminal } from "@agent-qofeno/security";
import { wrapText } from "./width.js";

export function renderMarkdown(source: string, st: Stylizer, width: number): string[] {
  const clean = sanitizeForTerminal(source);
  const out: string[] = [];
  const lines = clean.split("\n");
  let inCode = false;
  let codeLang = "";
  let codeBuf: string[] = [];

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCode) {
        out.push(...renderCodeBlock(codeBuf, codeLang, st, width));
        codeBuf = [];
        inCode = false;
      } else {
        inCode = true;
        codeLang = line.replace(/^\s*```/, "").trim();
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    out.push(...renderTextLine(line, st, width));
  }
  if (inCode && codeBuf.length) out.push(...renderCodeBlock(codeBuf, codeLang, st, width));
  return out;
}

function renderTextLine(line: string, st: Stylizer, width: number): string[] {
  // Headings
  const h = /^(#{1,4})\s+(.*)$/.exec(line);
  if (h) {
    const level = h[1]!.length;
    const text = inline(h[2]!, st);
    const prefix = level <= 2 ? "" : "  ";
    return [st.boldOn(prefix + text), ...(level === 1 ? [st.muted("─".repeat(Math.min(width, Math.max(8, text.length))))] : [])];
  }
  // Blockquote
  const q = /^>\s?(.*)$/.exec(line);
  if (q) return wrapText(`${st.muted("│ ")}${inline(q[1]!, st)}`, width);
  // Unordered list
  const ul = /^\s*[-*]\s+(.*)$/.exec(line);
  if (ul) return wrapText(`${st.bullet()} ${inline(ul[1]!, st)}`, width).map((l, i) => (i === 0 ? l : `  ${l}`));
  // Ordered list
  const ol = /^\s*(\d+)\.\s+(.*)$/.exec(line);
  if (ol) return wrapText(`${st.muted(`${ol[1]}.`)} ${inline(ol[2]!, st)}`, width).map((l, i) => (i === 0 ? l : `   ${l}`));
  // Horizontal rule
  if (/^\s*---+\s*$/.test(line)) return [st.muted("─".repeat(Math.min(width, 40)))];
  if (line.trim() === "") return [""];
  return wrapText(inline(line, st), width);
}

/** Inline formatting: bold **x**, italic *x*, code \`x\`, links [t](u) → t (u). */
export function inline(text: string, st: Stylizer): string {
  let s = escapeAnsi(text);
  s = s.replace(/`([^`]+)`/g, (_m, code) => st.accent(code));
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, b) => st.boldOn(b));
  s = s.replace(/(^|\W)\*([^*\s][^*]*)\*/g, (_m, pre, it) => `${pre}${it}`);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, u) => `${t} ${st.muted(`(${u})`)}`);
  return s;
}

function renderCodeBlock(code: string[], lang: string, st: Stylizer, width: number): string[] {
  const out: string[] = [];
  if (lang) out.push(st.muted(`┌─ ${lang} ${"─".repeat(Math.max(0, Math.min(width - 6 - lang.length, 20)))}`));
  for (const line of code.slice(0, 400)) {
    for (const wrapped of wrapText(line || " ", width - 4)) {
      out.push(`  ${st.primary(wrapped)}`);
    }
  }
  if (lang) out.push(st.muted("└" + "─".repeat(Math.min(width - 2, 30))));
  return out;
}

function escapeAnsi(text: string): string {
  return sanitizeForTerminal(text);
}
