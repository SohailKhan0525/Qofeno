/**
 * Qofeno CLI (#CLI grammar / #0102-#0111 headless/CI):
 *   qofeno                     interactive session
 *   qofeno -p "prompt"         print mode (headless)
 *   qofeno --output-format json|jsonl|text
 *   qofeno -c                  continue last session
 *   qofeno --resume <id>       resume named session
 * plus the management command namespace.
 */
export interface CliArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = new Set([
  "p",
  "print",
  "output-format",
  "resume",
  "session-id",
  "session-name",
  "model",
  "m",
  "mode",
  "profile",
  "project-root",
  "max-steps",
  "timeout-ms",
  "allowed-tools",
  "set",
  "port",
  "token",
]);

export function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (VALUE_FLAGS.has(key)) {
        const v = argv[++i];
        flags[key] = v ?? "";
      } else {
        flags[key] = true;
      }
    } else if (a.startsWith("-") && a.length > 1) {
      const key = a.slice(1);
      if (VALUE_FLAGS.has(key)) {
        const v = argv[++i];
        flags[key] = v ?? "";
      } else {
        for (const ch of key) flags[ch] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

export const USAGE = `qofeno — open-source terminal AI agent

USAGE
  qofeno [options]              start an interactive session
  qofeno -p <prompt> [options]  print mode: answer once, exit (headless)
  qofeno <command> [args]       run a management command

OPTIONS
  -p, --print <prompt>          headless prompt execution
  -c                            continue the most recent session
      --resume <id>             resume a specific session
      --session-name <title>    title for a new session
  -m, --model <provider:model>  select model
      --mode <plan|review|execute|autonomous|restricted>
      --output-format <text|json|jsonl>
      --allowed-tools <list>    comma-separated tool whitelist
      --max-steps <n>           agent step limit (default 12)
      --profile <name>          configuration profile
      --project-root <dir>      operate on a specific project
      --local-only              force local-only policy for this run
      --version                 print version
  -h, --help                    show help

COMMANDS
  onboarding                    guided first-run onboarding & setup wizard
  setup                         guided local model installer (hardware scored)
  models                        detect hardware & list installed/recommended models
  sessions list|rm <id>|export <id> [path]
  config get <key>|set <key> <value>|path|policy
  permissions list|grant|deny|revoke <id>
  provider add|list|test <kind> [baseUrl]
  memory list|add <text>|forget <id>|clear
  knowledge index <file>|search <query>
  repo index|search <query>|symbols <name>
  tools list
  agents run "<goal>"
  workflows validate <file>
  extensions install <dir>|list|enable <id>|disable <id>
  serve [--port 7931]           run local API & web app server
  backup [dest]                 create integrity-verified backup archive
  restore <archive>             restore from backup archive
  diff <file1> <file2>          render styled terminal diff
  doctor                        environment diagnostics (redacted)
  privacy                       data map & network posture
  version                       print version

EXIT CODES
  0 success · 2 invalid input · 3 permission/policy · 4 not found ·
  5 conflict · 20 provider error · 21 auth · 22 storage · 23 rate limited ·
  124 timeout · 130 cancelled`;

export function outputFormatOf(args: CliArgs): "text" | "json" | "jsonl" {
  const f = args.flags["output-format"];
  if (f === "json" || f === "jsonl") return f;
  return "text";
}
