/**
 * Command risk classification for shell tool calls (#0030 SHELL INTELLIGENCE,
 * #0070 command injection defense, #0180/#0181 destructive actions).
 *
 * This is defense-in-depth *for UX and policy hints only*; authorization is
 * still enforced by permissions + policy. We deliberately avoid naive prefix
 * matching: the classifier inspects the full pipeline (pipes, redirects,
 * chaining, substitution, escalation) before deciding.
 */

export type ShellRisk = "safe" | "moderate" | "high" | "destructive";

export interface CommandAnalysis {
  risk: ShellRisk;
  reasons: string[];
  /** True when the line contains constructs that make static analysis unreliable. */
  opaqueConstructs: boolean;
  networkTouch: boolean;
  fsMutations: string[];
}

const DESTRUCTIVE = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)/,
  /\brmdir\b/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b\s/,
  /\bshred\b/,
  />\s*\/dev\/[a-z]/,
  /\btruncate\s+-s\s*0\b/,
  /\bfind\b[^|]*-delete\b/,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|push\s+[^\n|;&]*--force|push\s+-f\b)/,
  /\bdrop\s+(table|database)\b/i,
];

const HIGH = [
  /\bchmod\s+777\b/,
  /\bchown\b/,
  /\bsudo\b/,
  /\bsu\b\s/,
  /\bdocker\b/,
  /\bkill(all)?\b/,
  /\bpkill\b/,
  /\breboot\b/,
  /\bshutdown\b/,
  /\bcrontab\b/,
  /\bln\s+-s\b/,
  /\bcurl\b[^\n|;&]*\|\s*(ba)?sh\b/,
  /\bwget\b[^\n|;&]*\|\s*(ba)?sh\b/,
  /\bpip\s+install\b/,
  /\bnpm\s+(i(nstall)?|publish|link)\b/,
  /\byarn\s+(add|publish)\b/,
  /\bgit\s+(commit|push|merge|rebase|tag)\b/,
];

const MODERATE = [/\bgit\s+\w/, /\bnpm\s+(run|test|ci)\b/, /\bmake\b/, /\bpytest\b/, /\bcargo\b/, /\btsc\b/, /\beslint\b/];

const NETWORK = [/\b(curl|wget|ping|ssh|scp|rsync|nc|netcat|telnet|ftp)\b/, /\bgit\s+(push|pull|fetch|clone)\b/];

const FS_MUTATIONS = [
  { re: /\b(mkdir|touch|cp|mv|tee|install)\b/, op: "write" },
  { re: /(^|\s|;|&|\|)>\s*\S+/, op: "redirect-write" },
  { re: /(^|\s|;|&|\|)>>\s*\S+/, op: "append" },
  { re: /\brm\b/, op: "delete" },
];

export function analyzeCommand(commandLine: string): CommandAnalysis {
  const cmd = commandLine.trim();
  const reasons: string[] = [];
  const fsMutations: string[] = [];

  const opaque =
    /[`$]\(/.test(cmd) ||
    /\$\{/.test(cmd) ||
    /\beval\b/.test(cmd) ||
    /\bbash\s+-c\b/.test(cmd) ||
    /\bsh\s+-c\b/.test(cmd);

  let risk: ShellRisk = "safe";
  const bump = (level: ShellRisk, why: string) => {
    reasons.push(why);
    const order: ShellRisk[] = ["safe", "moderate", "high", "destructive"];
    if (order.indexOf(level) > order.indexOf(risk)) risk = level;
  };

  if (opaque) {
    reasons.push("contains shell expansion/substitution — treat as unanalyzable");
    bump("moderate", "unanalyzable construct requires approval");
  }

  if (DESTRUCTIVE.some((re) => re.test(cmd))) bump("destructive", "potentially irreversible filesystem/git operation");
  if (HIGH.some((re) => re.test(cmd))) bump("high", "privileged or impactful operation");
  if (MODERATE.some((re) => re.test(cmd))) bump("moderate", "project/build operation");

  if (cmd.includes("|")) bump("moderate", "pipeline");
  if (/>>?\s*\S/.test(cmd)) {
    bump("moderate", "output redirection");
  }
  if (/&&|\|\||;/.test(cmd.replace(/"[^"]*"|'[^']*'/g, ""))) bump("moderate", "command chaining");

  for (const m of FS_MUTATIONS) if (m.re.test(cmd)) fsMutations.push(m.op);
  if (fsMutations.includes("delete")) bump("destructive", "file deletion");

  const networkTouch = NETWORK.some((re) => re.test(cmd));
  if (networkTouch) reasons.push("network access");

  return { risk, reasons, opaqueConstructs: opaque, networkTouch, fsMutations };
}
