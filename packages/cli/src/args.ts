/**
 * Qofeno CLI argument parser (#CLI grammar / #0102-#0111 headless/CI).
 * Supports all OpenCode compatible command grammar, flags, options, and formats.
 */
export interface CliArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = new Set([
  "p",
  "print",
  "prompt",
  "f",
  "file",
  "output-format",
  "format",
  "resume",
  "session-id",
  "session-name",
  "title",
  "model",
  "m",
  "provider",
  "mode",
  "profile",
  "project-root",
  "max-steps",
  "timeout-ms",
  "allowed-tools",
  "set",
  "port",
  "token",
  "host",
  "api-key",
  "quant",
  "limit",
  "unified",
  "shell",
  "out",
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
      const eqIdx = a.indexOf("=");
      if (eqIdx !== -1) {
        const key = a.slice(2, eqIdx);
        const val = a.slice(eqIdx + 1);
        flags[key] = val;
      } else {
        const key = a.slice(2);
        if (VALUE_FLAGS.has(key)) {
          const v = argv[++i];
          flags[key] = v ?? "";
        } else {
          flags[key] = true;
        }
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

  // Alias normalize
  if (flags.json) flags["output-format"] = "json";
  if (flags.format && !flags["output-format"]) flags["output-format"] = flags.format;
  if (flags.prompt && !flags.p) flags.p = flags.prompt;

  return { positional, flags };
}

export const USAGE = `qofeno — open-source, terminal-native AI agent

USAGE
  qofeno [options]                     start interactive TUI session
  qofeno run [prompt] [options]        execute prompt in headless/non-interactive mode
  qofeno -p <prompt> [options]         shortcut for headless execution
  qofeno <command> [subcommand] [args] run management command

OPTIONS
  -p, --prompt <text>           prompt string for headless execution
  -f, --file <path>             read prompt input from file
  -c, --continue                continue the most recent session
      --resume <id>             resume a specific session
      --session-name <title>    set title for new session
  -m, --model <provider:model>  select model (e.g. ollama:qwen2.5-coder:7b)
      --mode <mode>             mode: plan | review | execute | autonomous | restricted
      --output-format <fmt>     format: text | json | jsonl
      --allowed-tools <list>    comma-separated tool whitelist
      --max-steps <n>           agent step limit (default: 12)
      --timeout-ms <ms>         agent timeout limit in ms (default: 300000)
  -y, --auto-approve            auto-approve safe operations
  -q, --quiet                   suppress informational messages
      --local-only              enforce offline local execution only
      --profile <name>          configuration profile
      --project-root <dir>      operating workspace directory
  -v, --version                 print version
  -h, --help                    show help

COMMANDS
  run [prompt]                  execute prompt non-interactively
  serve [--port 7931]           start local API and Web/Desktop server
  model [list|recommend|install|use|search|info]
  provider [list|add|set|test|remove]
  session [list|resume|export|rm|rename|clear|info]
  config [get|set|list|reset|path|policy]
  doctor                        run environment and runtime diagnostics
  init                          scaffold .qofeno config and project instructions
  auth [login|logout|status]    manage secure API credentials
  share [session-id]            generate shareable session export
  export [session-id] [dest]    export session transcript (JSON, Markdown, text)
  diff <file1> <file2>          render styled terminal diff
  completion [shell]            generate shell completion script (bash, zsh, fish, powershell)
  update [--check]              check for latest updates
  onboarding                    guided first-run setup wizard
  setup                         guided local model discovery & installer
  permissions [list|grant|deny|revoke|reset]
  memory [list|add|forget|clear]
  knowledge [index|search|list|clear]
  repo [index|search|symbols|status]
  tools [list|info]
  agents run "<goal>"
  workflows [validate|run|list]
  extensions [list|install|enable|disable|rm]
  backup [dest] / restore <archive>
  privacy                       data mapping & network security posture
  version                       print version
  help [command]                show detailed command help

EXIT CODES
  0 success · 1 error · 2 invalid input · 3 policy/permission ·
  4 not found · 5 conflict · 20 provider error · 21 auth error ·
  22 storage error · 23 rate limited · 124 timeout · 130 cancelled`;

export function outputFormatOf(args: CliArgs): "text" | "json" | "jsonl" {
  const f = args.flags["output-format"] ?? args.flags.format;
  if (f === "json" || f === "jsonl") return f;
  return "text";
}
