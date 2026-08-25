/**
 * Input composer (#0006 INPUT COMPOSER): a multiline terminal editor with
 * cursor/word navigation, history with reverse search, completion hooks,
 * bracketed paste and undo/redo. Pure state machine + pluggable renderer so
 * behavior is fully testable without a TTY.
 */

export interface EditorRenderState {
  lines: string[];
  row: number;
  col: number;
  /** Set while Ctrl-R history search is active. */
  searchQuery?: string;
  searchMatch?: string;
  statusHint?: string;
}

export interface CompletionItem {
  label: string;
  detail?: string;
  insert: string;
}

export interface CompletionProvider {
  complete(input: string, cursorCol: number): CompletionItem[];
}

export interface EditorOptions {
  onSubmit(lines: string[]): void;
  onInterrupt(): void;
  render(state: EditorRenderState): void;
  completions?: CompletionProvider;
  historyFile?: string;
  maxHistory?: number;
}

interface UndoEntry {
  lines: string[];
  row: number;
  col: number;
}

export const KEY = {
  enter: "\r",
  ctrlJ: "\n",
  ctrlC: "\x03",
  ctrlD: "\x04",
  backspace: "\x7f",
  tab: "\t",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  delete: "\x1b[3~",
  altEnter: "\x1b\r",
  ctrlR: "\x12",
} as const;

export class LineEditor {
  private lines: string[] = [""];
  private row = 0;
  private col = 0;
  private history: string[] = [];
  private historyIdx: number | null = null;
  private draftBeforeHistory: string[] | null = null;
  private searchMode = false;
  private searchQuery = "";
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private pasteBuffer = "";
  private browsingHistory = false;

  constructor(private opts: EditorOptions) {}

  loadHistory(entries: string[]): void {
    this.history = entries.slice(-(this.opts.maxHistory ?? 500));
  }

  dumpHistory(): string[] {
    return [...this.history];
  }

  getState(): EditorRenderState {
    return {
      lines: [...this.lines],
      row: this.row,
      col: this.col,
      ...(this.searchMode ? { searchQuery: this.searchQuery, searchMatch: this.history[this.historyIdx ?? this.history.length - 1] } : {}),
      statusHint: this.searchMode ? `search: ${this.searchQuery}` : undefined,
    };
  }

  setText(text: string): void {
    this.pushUndo();
    this.lines = text.split("\n");
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row]!.length;
    this.emit();
  }

  getText(): string {
    return this.lines.join("\n");
  }

  reset(): void {
    this.lines = [""];
    this.row = 0;
    this.col = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.historyIdx = null;
    this.draftBeforeHistory = null;
  }

  /** Feed a decoded key sequence (one logical keypress). */
  handleKey(seq: string): void {
    if (this.searchMode) {
      this.handleSearchKey(seq);
      return;
    }
    switch (seq) {
      case KEY.enter:
        this.submit();
        return;
      case KEY.ctrlJ:
      case KEY.altEnter:
        this.breakLine();
        return;
      case KEY.ctrlC:
        this.opts.onInterrupt();
        return;
      case KEY.ctrlD:
        if (this.lines.length === 1 && this.lines[0] === "" && !this.pasteBuffer) {
          this.opts.onInterrupt();
        } else {
          this.deleteForward();
        }
        return;
      case KEY.backspace:
        this.backspace();
        return;
      case KEY.delete:
        this.deleteForward();
        return;
      case KEY.left:
        this.moveCol(-1);
        return;
      case KEY.right:
        this.moveCol(1);
        return;
      case KEY.up:
        this.moveRow(-1);
        return;
      case KEY.down:
        this.moveRow(1);
        return;
      case KEY.home:
        this.col = 0;
        break;
      case KEY.end:
        this.col = this.currentLine().length;
        break;
      case KEY.tab:
        this.runCompletion();
        return;
      case "\x01":
        this.col = 0;
        break; // Ctrl-A
      case "\x05":
        this.col = this.currentLine().length;
        break; // Ctrl-E
      case "\x02":
        this.moveCol(-1);
        return; // Ctrl-B
      case "\x06":
        this.moveCol(1);
        return; // Ctrl-F
      case "\x0b":
        this.killToEnd();
        return; // Ctrl-K
      case "\x15":
        this.killToStart();
        return; // Ctrl-U
      case "\x17":
        this.killWordBack();
        return; // Ctrl-W
      case "\x1a":
        this.undo();
        return; // Ctrl-Z
      case "\x19":
        this.redo();
        return; // Ctrl-Y (redo here)
      case KEY.ctrlR:
        this.searchMode = true;
        this.searchQuery = "";
        this.historyIdx = null;
        break;
      default:
        if (seq.startsWith("\x1b[200~")) {
          // Bracketed paste open; content arrives until close marker.
          this.pasteBuffer = seq.slice(6);
          this.flushPasteIfClosed("");
          break;
        }
        if (this.pasteBuffer || seq.includes("\x1b[201~")) {
          this.pasteBuffer += seq;
          this.flushPasteIfClosed(seq);
          break;
        }
        if (/^[\x20-\x7e\u00a0-\uffff]/.test(seq)) {
          this.insertText(seq);
        }
        break;
    }
    this.emit();
  }

  private flushPasteIfClosed(_seq: string): void {
    const closeIdx = this.pasteBuffer.indexOf("\x1b[201~");
    if (closeIdx >= 0) {
      const payload = this.pasteBuffer.slice(0, closeIdx);
      this.pasteBuffer = "";
      this.insertText(payload.replace(/\r\n|\r/g, "\n"));
      this.emit();
    } else if (this.pasteBuffer.length > 100_000) {
      // Unclosed oversized paste: treat as literal to avoid unbounded buffering (#0122-style caps).
      this.insertText(this.pasteBuffer.replace(/\r/g, "\n"));
      this.pasteBuffer = "";
      this.emit();
    }
  }

  private handleSearchKey(seq: string): void {
    if (seq === KEY.enter) {
      this.acceptSearch();
      return;
    }
    if (seq === KEY.ctrlC) {
      this.cancelSearch();
      this.opts.onInterrupt();
      return;
    }
    if (seq === KEY.backspace) {
      this.searchQuery = this.searchQuery.slice(0, -1);
    } else if (/^[\x20-\x7e]/.test(seq)) {
      this.searchQuery += seq;
    } else if (seq === KEY.ctrlR) {
      this.historyIdx = this.historyIdx === null ? this.history.length - 1 : Math.max(0, (this.historyIdx ?? 0) - 1);
    }
    // Find most recent match
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i]!.includes(this.searchQuery)) {
        this.historyIdx = i;
        break;
      }
    }
    this.emit();
  }

  private acceptSearch(): void {
    const match = this.history[this.historyIdx ?? -1];
    this.searchMode = false;
    if (match !== undefined) {
      this.recordHistory(match);
      this.opts.onSubmit(match.split("\n"));
      this.reset();
      this.emit();
      return;
    }
    this.emit();
  }

  private cancelSearch(): void {
    this.searchMode = false;
    this.searchQuery = "";
    this.emit();
  }

  private currentLine(): string {
    return this.lines[this.row] ?? "";
  }

  private submit(): void {
    this.browsingHistory = false;
    const text = this.getText().trimEnd();
    if (!text.trim()) {
      this.emit();
      return;
    }
    this.recordHistory(text);
    this.opts.onSubmit(this.lines.slice());
    this.reset();
    this.emit();
  }

  private recordHistory(text: string): void {
    if (this.history[this.history.length - 1] === text) return;
    this.history.push(text);
    if (this.history.length > (this.opts.maxHistory ?? 500)) this.history.shift();
    this.historyIdx = null;
    this.draftBeforeHistory = null;
  }

  private breakLine(): void {
    this.pushUndo();
    const line = this.currentLine();
    this.lines[this.row] = line.slice(0, this.col);
    this.lines.splice(this.row + 1, 0, line.slice(this.col));
    this.row++;
    this.col = 0;
    this.emit();
  }

  private insertText(text: string): void {
    this.browsingHistory = false;
    this.historyIdx = null;
    this.pushUndo();
    const parts = text.split("\n");
    const line = this.currentLine();
    if (parts.length === 1) {
      this.lines[this.row] = line.slice(0, this.col) + text + line.slice(this.col);
      this.col += text.length;
    } else {
      const before = line.slice(0, this.col);
      const after = line.slice(this.col);
      this.lines[this.row] = before + parts[0]!;
      for (let k = 1; k < parts.length; k++) {
        this.lines.splice(this.row + k, 0, "");
        this.lines[this.row + k] = k === parts.length - 1 ? parts[k]! + after : parts[k]!;
      }
      this.row += parts.length - 1;
      this.col = parts[parts.length - 1]!.length;
    }
    this.emit();
  }

  private backspace(): void {
    this.pushUndo();
    const line = this.currentLine();
    if (this.col > 0) {
      this.lines[this.row] = line.slice(0, this.col - 1) + line.slice(this.col);
      this.col--;
    } else if (this.row > 0) {
      const prevLen = this.lines[this.row - 1]!.length;
      this.lines[this.row - 1] += line;
      this.lines.splice(this.row, 1);
      this.row--;
      this.col = prevLen;
    }
    this.emit();
  }

  private deleteForward(): void {
    this.pushUndo();
    const line = this.currentLine();
    if (this.col < line.length) {
      this.lines[this.row] = line.slice(0, this.col) + line.slice(this.col + 1);
    } else if (this.row < this.lines.length - 1) {
      this.lines[this.row] = line + this.lines[this.row + 1]!;
      this.lines.splice(this.row + 1, 1);
    }
    this.emit();
  }

  private moveCol(d: number): void {
    const line = this.currentLine();
    if (d < 0 && this.col === 0 && this.row > 0) {
      this.row--;
      this.col = this.currentLine().length;
    } else if (d > 0 && this.col >= line.length && this.row < this.lines.length - 1) {
      this.row++;
      this.col = 0;
    } else {
      this.col = Math.max(0, Math.min(line.length, this.col + d));
    }
    this.emit();
  }

  private moveRow(d: number): void {
    if (this.browsingHistory || this.isSingleEmptyLine()) {
      this.navigateHistory(d);
      return;
    }
    const target = this.row + d;
    if (target < 0 || target >= this.lines.length) return;
    this.row = target;
    this.col = Math.min(this.col, this.currentLine().length);
    this.emit();
  }

  private isSingleEmptyLine(): boolean {
    return this.lines.length === 1 && this.lines[0] === "";
  }

  private navigateHistory(d: number): void {
    this.browsingHistory = true;
    if (this.draftBeforeHistory === null) this.draftBeforeHistory = this.lines.slice();
    let idx = this.historyIdx ?? this.history.length;
    idx += d;
    if (idx < 0) idx = 0;
    if (idx >= this.history.length) {
      this.historyIdx = null;
      this.lines = this.draftBeforeHistory!.slice();
      this.row = this.lines.length - 1;
      this.col = this.lines[this.row]!.length;
      this.emit();
      return;
    }
    this.historyIdx = idx;
    this.lines = this.history[idx]!.split("\n");
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row]!.length;
    this.emit();
  }

  private killToStart(): void {
    this.pushUndo();
    const line = this.currentLine();
    this.lines[this.row] = line.slice(this.col);
    this.col = 0;
    this.emit();
  }

  private killToEnd(): void {
    this.pushUndo();
    const line = this.currentLine();
    this.lines[this.row] = line.slice(0, this.col);
    this.emit();
  }

  private killWordBack(): void {
    this.pushUndo();
    const line = this.currentLine();
    const left = line.slice(0, this.col).replace(/\S+\s*$/, "");
    this.lines[this.row] = left + line.slice(this.col);
    this.col = left.length;
    this.emit();
  }

  private pushUndo(): void {
    this.undoStack.push({ lines: this.lines.slice(), row: this.row, col: this.col });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push({ lines: this.lines.slice(), row: this.row, col: this.col });
    this.lines = prev.lines;
    this.row = prev.row;
    this.col = prev.col;
    this.emit();
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push({ lines: this.lines.slice(), row: this.row, col: this.col });
    this.lines = next.lines;
    this.row = next.row;
    this.col = next.col;
    this.emit();
  }

  private runCompletion(): void {
    const provider = this.opts.completions;
    if (!provider) return;
    const offset = this.lines.slice(0, this.row).reduce((n, l) => n + l.length + 1, 0);
    const items = provider.complete(this.getText(), offset + this.col);
    if (items.length === 0) return;
    if (items.length === 1) {
      this.applyCompletion(items[0]!);
      return;
    }
    // Multiple candidates: complete longest common prefix, expose list to renderer hint.
    const prefix = commonPrefix(items.map((i) => i.insert));
    if (prefix.length > 0 && !this.currentLine().endsWith(prefix)) {
      this.applyCompletion({ ...items[0]!, insert: prefix });
    }
  }

  private applyCompletion(item: CompletionItem): void {
    this.pushUndo();
    const absCursor = this.lines.slice(0, this.row).reduce((n, l) => n + l.length + 1, 0) + this.col;
    const text = this.getText();
    const wordStart = text.lastIndexOf(" ", Math.max(0, absCursor - 1)) + 1;
    const newText = text.slice(0, wordStart) + item.insert + text.slice(absCursor);
    this.lines = newText.split("\n");
    this.row = 0;
    let consumed = 0;
    for (let i = 0; i < this.lines.length; i++) {
      consumed += this.lines[i]!.length + 1;
      if (consumed > wordStart + item.insert.length) {
        this.row = i;
        break;
      }
    }
    this.col = wordStart + item.insert.length - this.lines.slice(0, this.row).reduce((n, l) => n + l.length + 1, 0);
    this.emit();
  }

  private emit(): void {
    this.opts.render(this.getState());
  }
}

function commonPrefix(items: string[]): string {
  if (items.length === 0) return "";
  let prefix = items[0]!;
  for (const it of items.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < it.length && prefix[i] === it[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}
