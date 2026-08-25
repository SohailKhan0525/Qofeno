import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickTheme, Stylizer, stripAnsi } from "../src/theme.js";
import { displayWidth, wrapText, truncateToWidth, fitCell } from "../src/width.js";
import { computeDiff, renderDiff } from "../src/diff.js";
import { renderMarkdown } from "../src/markdown.js";

function st(noColor = true): Stylizer {
  return new Stylizer({ theme: pickTheme("dark"), colorEnabled: !noColor, unicode: true });
}

describe("width engine (#0091)", () => {
  it("measures ASCII, CJK and emoji correctly", () => {
    assert.equal(displayWidth("hello"), 5);
    assert.equal(displayWidth("こんにちは"), 10);
    assert.equal(displayWidth("👍"), 2);
    assert.equal(displayWidth("café"), 4);
  });
  it("wraps without losing characters", () => {
    const lines = wrapText("The quick brown fox jumps over the lazy dog repeatedly", 12);
    assert.ok(lines.every((l) => displayWidth(l) <= 12));
    const joined = lines.join(" ").replace(/\s+/g, " ").trim();
    assert.equal(joined, "The quick brown fox jumps over the lazy dog repeatedly");
  });
  it("hard-breaks long unbroken words", () => {
    const lines = wrapText("a".repeat(30), 10);
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => l.length <= 10));
  });
  it("truncates with ellipsis at width", () => {
    const t = truncateToWidth("abcdefghij", 6);
    assert.equal(displayWidth(t), 6);
    assert.ok(t.endsWith("…"));
  });
  it("fitCell produces exact-width cells", () => {
    for (const w of [1, 5, 20]) {
      assert.equal(displayWidth(fitCell("abc", w)), w);
    }
  });
});

describe("theme + stylizer", () => {
  it("NO_COLOR path emits no escape sequences", () => {
    const s = st(true);
    assert.equal(stripAnsi(s.success("x")), "x");
    assert.equal(s.success("x").includes("\u001b"), false);
  });
  it("color path emits escapes when enabled", () => {
    const s = new Stylizer({ theme: pickTheme("dark"), colorEnabled: true, unicode: false });
    assert.ok(s.error("boom").includes("[31m"));
    // Non-color signals exist too (glyphs differ per status)
    assert.notEqual(s.statusOk(), s.statusError());
  });
});

describe("diff engine (#0032)", () => {
  const before = ["line one", "line two", "line three"].join("\n");
  const after = ["line one", "line two changed", "line three", "line four added"].join("\n");

  it("computes add/delete/context lines", () => {
    const d = computeDiff(before, after);
    assert.ok(d.some((l) => l.kind === "del" && l.text === "line two"));
    assert.ok(d.some((l) => l.kind === "add" && l.text === "line two changed"));
    assert.ok(d.some((l) => l.kind === "add" && l.text === "line four added"));
    assert.ok(d.some((l) => l.kind === "context" && l.text === "line one"));
  });
  it("renders within width budget at narrow columns", () => {
    const d = computeDiff(before, after);
    for (const cols of [40, 60, 80, 120]) {
      const out = renderDiff(d, st(), { maxWidth: cols });
      for (const line of out) assert.ok(stripAnsi(line).length <= cols, `overflow at ${cols}: ${line}`);
    }
  });
  it("identical inputs produce context only", () => {
    const d = computeDiff(before, before);
    assert.ok(d.every((l) => l.kind !== "add" && l.kind !== "del"));
  });
});

describe("markdown renderer (#0008)", () => {
  it("renders headings/lists/code safely", () => {
    const src = "# Title\n\n- item **bold** `code`\n\n```js\nlet x = 1;\n```\n";
    const out = renderMarkdown(src, st(), 80);
    assert.ok(out.some((l) => l.includes("Title")));
    assert.ok(out.some((l) => /[-•]/.test(l) && l.includes("item")));
    assert.ok(out.some((l) => l.includes("let x = 1;")));
    assert.equal(out.join("\n").includes("\u001b]0;"), false);
  });
  it("neutralizes injected escape sequences from model output", () => {
    const evil = "hello \u001b[2J\u001b[Hworld\u001b]0;pwned\u0007";
    const out = renderMarkdown(evil, st(), 80).join("\n");
    assert.equal(out.includes("\u001b"), false);
    assert.match(out, /helloworld|hello\s*world/);
  });
  it("respects width on long paragraphs", () => {
    const para = "word ".repeat(60).trim();
    const out = renderMarkdown(para, st(), 40);
    assert.ok(out.every((l) => stripAnsi(l).length <= 40));
  });
});
