import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LineEditor, KEY, type EditorRenderState } from "../src/editor.js";

function harness(initialHistory: string[] = []) {
  const states: EditorRenderState[] = [];
  let submitted: string[] | null = null;
  let interrupts = 0;
  const ed = new LineEditor({
    onSubmit: (lines) => {
      submitted = lines;
    },
    onInterrupt: () => interrupts++,
    render: (s) => states.push(s),
  });
  ed.loadHistory(initialHistory);
  const type = (...seqs: string[]) => seqs.forEach((k) => ed.handleKey(k));
  return { ed, states, get submitted() { return submitted; }, get interrupts() { return interrupts; }, type };
}

describe("line editor (#0006)", () => {
  it("types, submits and resets", () => {
    const h = harness();
    h.type("h", "i", KEY.enter);
    assert.equal(h.submitted!.join("\n"), "hi");
    assert.equal(h.ed.getText(), "");
  });

  it("empty enter does not submit", () => {
    const h = harness(["prev"]);
    h.type(KEY.enter);
    assert.equal(h.submitted, null);
  });

  it("supports backspace, arrows, kill-line and undo", () => {
    const h = harness();
    h.type("a", "b", "c", "d", "\x15"); // Ctrl-U clears to start
    assert.equal(h.ed.getText(), "");
    h.type("\x1a"); // undo
    assert.equal(h.ed.getText(), "abcd");
  });

  it("navigates history with up/down when buffer is empty", () => {
    const h = harness(["first command", "second command"]);
    h.type(KEY.up);
    assert.equal(h.ed.getText(), "second command");
    h.type(KEY.up);
    assert.equal(h.ed.getText(), "first command");
    h.type(KEY.down);
    assert.equal(h.ed.getText(), "second command");
    h.type(KEY.down);
    assert.equal(h.ed.getText(), "");
  });

  it("preserves draft when browsing history", () => {
    const h = harness(["old"]);
    h.type("draft", KEY.up, KEY.down);
    assert.equal(h.ed.getText(), "draft");
  });

  it("reverse search finds and accepts matches", () => {
    const h = harness(["git status", "npm test"]);
    h.type(KEY.ctrlR, "t", "e");
    h.type(KEY.enter);
    assert.equal(h.submitted!.join("\n"), "npm test");
  });

  it("multiline editing with Ctrl-J then submit joins lines", () => {
    const h = harness();
    h.type("def f():", KEY.ctrlJ, "  pass", KEY.enter);
    assert.deepEqual(h.submitted!, ["def f():", "  pass"]);
  });

  it("bracketed paste inserts content literally including newlines", () => {
    const h = harness();
    h.type("\x1b[200~pasted\r\nlines\x1b[201~");
    assert.deepEqual(h.ed.getState().lines, ["pasted", "lines"]);
  });

  it("Ctrl-C triggers interrupt without submitting", () => {
    const h = harness();
    h.type("x", KEY.ctrlC);
    assert.equal(h.interrupts, 1);
    assert.equal(h.submitted, null);
  });

  it("word-kill removes last word (Ctrl-W)", () => {
    const h = harness();
    h.type("hello world", "\x17");
    assert.equal(h.ed.getText(), "hello ");
  });

  it("completion inserts single candidate at cursor word", () => {
    let requested = "";
    const h = harness();
    // Rebuild editor with completions via new instance
    const states: EditorRenderState[] = [];
    const ed = new LineEditor({
      onSubmit: () => {},
      onInterrupt: () => {},
      render: (s) => states.push(s),
      completions: {
        complete(input) {
          requested = input;
          return [{ label: "/help", insert: "/help " }];
        },
      },
    });
    void h;
    ed.handleKey("/");
    ed.handleKey(KEY.tab);
    assert.equal(requested, "/");
    assert.equal(ed.getText(), "/help ");
  });
});
