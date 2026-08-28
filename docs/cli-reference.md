# CLI Reference

`qofeno <command> [options]` — every command also supports `-h` / `--help`.

## Interactive

| Command | Description |
|---|---|
| `qofeno` | start an interactive session |
| `qofeno -c` | continue most recent session |
| `qofeno --resume <id>` | resume a specific session |
| `--mode plan\|review\|execute\|autonomous\|restricted` | set starting mode |

### Slash commands (in session)

`/help` · `/model [id]` · `/mode <m>` · `/permissions` · `/memory [text]` · `/memory-forget <id>` · `/knowledge index <file> | search <q>` · `/compact` · `/sessions` · `/resume <id>` · `/export [path]` · `/tools` · `/privacy` · `/clear` · `/quit`

## Headless

```bash
qofeno -p "<prompt>"                       # answer once, exit
  --output-format text|json|jsonl          # machine-readable output
  --allowed-tools "fs_read,fs_grep"        # tool whitelist for this run
  --max-steps <n>   --timeout-ms <n>       # agent bounds
CI=1 qofeno agents run "<goal>" -m ollama:llama3.2
```

Headless runs are **fail-closed**: tools execute only when explicit permission grants exist (`qofeno permissions grant …`) or policy allows; no prompts are ever shown.

## Management commands

```bash
onboarding                                              # guided interactive onboarding & hardware setup
setup                                                   # guided local model pull (hardware scored)
models                                                  # detect hardware & list installed/recommended models
sessions list | rm <id> | export <id> [path]
config get <key> | set <key> <value> | path | policy
permissions list | grant <permission> [pattern] | deny <permission> [pattern] | revoke <id>
provider add <openai|openrouter|gemini|anthropic|ollama|custom> [baseUrl] | list | test
memory list | add <text> | forget <id> | clear
knowledge index <file> | search <query>
repo index | search <query> | symbols <name>           # repository intelligence (FTS5 + symbol heuristics)
backup [path] | restore <archive>                      # sha256-manifested, validate-before-swap
tools list
agents run "<goal>"
workflows validate <file.json>
extensions install <dir> | list | enable <id> | disable <id>
serve [--port n] [--token t]                           # the App: HTTP API + web console
doctor                                                 # redacted environment diagnostics
privacy                                                # data map & network posture
version                                                # print version
diff <old> <new>                                       # render a terminal diff
```

## Permission keys

`fs.read fs.write fs.delete shell.exec network.fetch git.network git.mutate package.install code.exec secrets.read memory.write knowledge.write extension.run`

Grant scopes: `always` · `session` · `project:<root>` · `pattern:<prefix or host>`. Example:

```bash
qofeno permissions grant shell.exec "npm test"
qofeno permissions deny  shell.exec "rm"
```

## Exit codes

0 ok · 2 invalid input · 3 permission/policy · 4 not found · 5 conflict · 20 provider error/unavailable · 21 auth/secret store · 22 storage · 23 rate limited · 124 timeout · 130 cancelled.
