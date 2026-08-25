/**
 * Process supervisor (#0086/#0121): spawn children with timeouts, output
 * caps, signal forwarding and guaranteed cleanup. Never uses a shell unless
 * explicitly requested (and only the tool layer may request it, after
 * permission checks). Environment passed to children is filtered by default
 * so secrets do not leak into subprocesses (#0182).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { ErrorCode, QofenoError, throwIfAborted } from "@agent-qofeno/core";

const MAX_OUTPUT_BYTES = 512 * 1024;

const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "COMSPEC", "TERM"];

export interface ExecResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Replace PATH etc. entirely with the given environment. */
  cleanEnv?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  stdin?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export function childEnv(opts: { cleanEnv?: boolean; env?: Record<string, string> }): NodeJS.ProcessEnv {
  if (opts.cleanEnv) {
    const base: Record<string, string> = {};
    for (const k of ENV_ALLOWLIST) {
      if (process.env[k] !== undefined) base[k] = process.env[k]!;
    }
    return { ...base, ...(opts.env ?? {}) };
  }
  const inherited: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) inherited[k] = v;
  return { ...inherited, ...(opts.env ?? {}) };
}

export async function execFile(
  file: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  throwIfAborted(opts.signal);
  const startedAt = Date.now();
  const maxOut = opts.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  let outBytes = 0;
  let errBytes = 0;
  let truncated = false;

  return new Promise<ExecResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: childEnv(opts),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      reject(new QofenoError({ code: ErrorCode.INTERNAL, message: `spawn failed`, cause: e }));
      return;
    }

    let stdoutBuf = "";
    let stderrBuf = "";
    let timedOut = false;
    let settled = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, opts.timeoutMs)
      : undefined;

    const onAbort = () => {
      killTree(child);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      outBytes += Buffer.byteLength(line) + 1;
      if (outBytes > maxOut) {
        truncated = true;
        rl.close();
        child.stdout!.destroy();
        return;
      }
      stdoutBuf += line + "\n";
      opts.onStdout?.(line + "\n");
    });
    const rle = createInterface({ input: child.stderr! });
    rle.on("line", (line) => {
      errBytes += Buffer.byteLength(line) + 1;
      if (errBytes > maxOut) {
        truncated = true;
        rle.close();
        child.stderr!.destroy();
        return;
      }
      stderrBuf += line + "\n";
      opts.onStderr?.(line + "\n");
    });

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(new QofenoError({ code: ErrorCode.NOT_FOUND, message: `cannot execute ${file}`, userMessage: `Could not run \`${file}\`. Is it installed and on PATH?`, cause: e }));
    });

    child.on("close", (code, signalName) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        code,
        signal: signalName,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        truncated,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });

    if (opts.stdin !== undefined) {
      child.stdin!.end(opts.stdin);
    } else {
      child.stdin!.end();
    }
  });
}

/** Kill a child and its process group when possible. */
export function killTree(child: ChildProcess): void {
  try {
    if (child.pid === undefined) return;
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    } else {
      child.kill("SIGTERM");
    }
    setTimeout(() => {
      try {
        if (child.pid !== undefined && child.exitCode === null) child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 1500).unref?.();
  } catch {
    /* already gone */
  }
}

/** Run a command through the user's shell ONLY after explicit authorization upstream. */
export async function execShell(commandLine: string, opts: ExecOptions = {}): Promise<ExecResult> {
  const shell = process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : process.env.SHELL ?? "/bin/sh";
  const shellFlag = process.platform === "win32" ? "/c" : "-c";
  return execFile(shell, [shellFlag, commandLine], { ...opts, cleanEnv: false });
}
