/**
 * Terminal diff renderer (#0032): unified-diff style with line numbers,
 * hunk headers, paging hooks and width safety. Pure function over text so it
 * is snapshot-testable at any column count (#0194).
 */
import type { Stylizer } from "./theme.js";
import { displayWidth, truncateToWidth } from "./width.js";

export interface DiffLine {
  kind: "context" | "add" | "del" | "hunk" | "meta";
  oldNo?: number;
  newNo?: number;
  text: string;
}

/** Compute a line-based diff (LCS) between two texts. */
export function computeDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.length ? oldText.split("\n") : [];
  const b = newText.length ? newText.split("\n") : [];
  // Trim common prefix/suffix for LCS efficiency.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  // LCS table sized guard: fall back to replace-all when enormous.
  const MAX_CELLS = 4_000_000;
  const rows: DiffLine[] = [];
  if (midA.length * midB.length > MAX_CELLS) {
    rows.push(hunkLine(start + 1, start + 1));
    for (const t of midA) rows.push({ kind: "del", oldNo: undefined, newNo: undefined, text: t });
    for (const t of midB) rows.push({ kind: "add", text: t });
    return finalize(rows, a, b, start, endA, endB);
  }

  const m = midA.length;
  const n = midB.length;
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = midA[i] === midB[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  const dels: string[] = [];
  const adds: string[] = [];
  const flush = () => {
    for (const t of dels) rows.push({ kind: "del", text: t });
    for (const t of adds) rows.push({ kind: "add", text: t });
    dels.length = 0;
    adds.length = 0;
  };
  while (i < m && j < n) {
    if (midA[i] === midB[j]) {
      flush();
      rows.push({ kind: "context", text: midA[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      dels.push(midA[i]!);
      i++;
    } else {
      adds.push(midB[j]!);
      j++;
    }
  }
  while (i < m) {
    dels.push(midA[i]!);
    i++;
  }
  while (j < n) {
    adds.push(midB[j]!);
    j++;
  }
  flush();
  void hunkLine;
  return finalize(rows, a, b, start, endA, endB);
}

function hunkLine(oldStart: number, newStart: number): DiffLine {
  return { kind: "hunk", text: `@@ -${oldStart} +${newStart} @@` };
}

function finalize(rows: DiffLine[], a: string[], b: string[], start: number, endA: number, endB: number): DiffLine[] {
  const out: DiffLine[] = [];
  // Prefix context
  for (let k = 0; k < start; k++) out.push({ kind: "context", oldNo: k + 1, newNo: k + 1, text: a[k]! });
  // Middle rows with sequential numbering continuing after the prefix.
  let oldNo = start;
  let newNo = start;
  let pendingHunk = false;
  for (const r of rows) {
    const isChange = r.kind !== "context";
    if (isChange && !pendingHunk) {
      out.push(hunkLine(oldNo + 1, newNo + 1));
      pendingHunk = true;
    }
    if (!isChange) pendingHunk = false;
    if (r.kind === "del") r.oldNo = ++oldNo;
    else if (r.kind === "add") r.newNo = ++newNo;
    else {
      r.oldNo = ++oldNo;
      r.newNo = ++newNo;
    }
    out.push(r);
  }
  // Suffix context
  while (oldNo < endA && newNo < endB) {
    out.push({ kind: "context", oldNo: oldNo + 1, newNo: newNo + 1, text: a[oldNo]! });
    oldNo++;
    newNo++;
  }
  return out;
}

export interface RenderOptions {
  maxWidth: number;
  contextLines?: number;
}

export function renderDiff(lines: DiffLine[], st: Stylizer, opts: RenderOptions): string[] {
  const width = Math.max(20, opts.maxWidth);
  const gutterW = String(Math.max(...lines.map((l) => l.oldNo ?? l.newNo ?? 0))).length;
  const bodyW = width - (gutterW * 2 + 4);
  const show = collapseContext(lines, opts.contextLines ?? 3);
  const out: string[] = [];
  for (const l of show) {
    const marker =
      l.kind === "add" ? "+" : l.kind === "del" ? "-" : l.kind === "hunk" ? "@" : " ";
    const styledMarker =
      l.kind === "add" ? st.success(marker) : l.kind === "del" ? st.error(marker) : l.kind === "hunk" ? st.accent(marker) : st.muted(marker);
    const body = truncateToWidth(l.text, bodyW);
    const nums =
      l.kind === "hunk"
        ? st.muted(" ".repeat(gutterW * 2))
        : `${String(l.oldNo ?? "").padStart(gutterW)} ${String(l.newNo ?? "").padStart(gutterW)}`;
    out.push(`${st.muted(nums)} ${styledMarker} ${l.kind === "add" ? st.success(body) : l.kind === "del" ? st.error(body) : body}`);
    if (displayWidth(body) > bodyW) out.push(st.muted("    … line truncated to fit terminal width"));
  }
  return out;
}

function collapseContext(lines: DiffLine[], ctx: number): DiffLine[] {
  if (ctx < 0) return lines;
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind !== "context") {
      for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++) keep[k] = true;
    }
  });
  const out: DiffLine[] = [];
  let skipping = false;
  lines.forEach((l, i) => {
    if (keep[i]) {
      out.push(l);
      skipping = false;
    } else if (!skipping) {
      out.push({ kind: "meta", text: "⋯ unchanged" });
      skipping = true;
    }
  });
  return out;
}
