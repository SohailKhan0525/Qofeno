# OpenCode Command Compatibility & Parity Matrix

Qofeno implements complete command parity with the OpenCode terminal interface contract while operating under Qofeno's local-first, deterministic security architecture.

## Overview

| OpenCode Command | Qofeno Command | Aliases | Interactive / TUI | Headless / Non-interactive | Slash Equivalent |
|:---|:---|:---|:---|:---|:---|
| `opencode` | `qofeno` | `tui`, `chat`, `repl` | Yes | No | `/new` |
| `opencode run [prompt]` | `qofeno run [prompt]` | `exec`, `-p`, `--print` | No | Yes | — |
| `opencode serve` | `qofeno serve` | `server` | No | Yes | — |
| `opencode model` | `qofeno model` | `models` | Yes | Yes | `/model` |
| `opencode provider` | `qofeno provider` | `providers` | Yes | Yes | `/provider` |
| `opencode session` | `qofeno session` | `sessions` | Yes | Yes | `/sessions` |
| `opencode config` | `qofeno config` | `settings` | Yes | Yes | `/config` |
| `opencode doctor` | `qofeno doctor` | `diagnostics`, `check` | Yes | Yes | `/doctor` |
| `opencode init` | `qofeno init` | `scaffold` | Yes | Yes | `/init` |
| `opencode auth` | `qofeno auth` | `login`, `logout` | Yes | Yes | — |
| `opencode share` | `qofeno share` | — | Yes | Yes | `/share` |
| `opencode export` | `qofeno export` | — | Yes | Yes | `/export` |
| `opencode diff` | `qofeno diff` | — | Yes | Yes | `/diff` |
| `opencode completion` | `qofeno completion` | `completions` | No | Yes | — |
| `opencode update` | `qofeno update` | `upgrade` | Yes | Yes | — |
| `opencode onboarding` | `qofeno onboarding` | `welcome` | Yes | No | — |
| `opencode setup` | `qofeno setup` | `install-model` | Yes | No | `/setup` |
| `opencode permissions` | `qofeno permissions` | `perms` | Yes | Yes | `/permissions` |
| `opencode memory` | `qofeno memory` | `mem` | Yes | Yes | `/memory` |
| `opencode knowledge` | `qofeno knowledge` | `kb`, `rag` | Yes | Yes | `/knowledge` |
| `opencode repo` | `qofeno repo` | `codebase` | Yes | Yes | `/repo` |
| `opencode tools` | `qofeno tools` | — | Yes | Yes | `/tools` |
| `opencode agent` | `qofeno agents` | `agent` | No | Yes | `/plan` |
| `opencode workflow` | `qofeno workflows` | `workflow` | No | Yes | — |
| `opencode ext` | `qofeno extensions` | `plugins` | Yes | Yes | — |
| `opencode backup` | `qofeno backup` | — | No | Yes | — |
| `opencode restore` | `qofeno restore` | — | No | Yes | — |
| `opencode privacy` | `qofeno privacy` | — | Yes | Yes | `/privacy` |
| `opencode version` | `qofeno version` | `-v`, `--version` | Yes | Yes | `/version` |
| `opencode help` | `qofeno help` | `-h`, `--help`, `/?` | Yes | Yes | `/help` |

## Interactive TUI Slash Commands

| Slash Command | Aliases | Description | CLI Equivalent |
|:---|:---|:---|:---|
| `/help` | `/?` | Display available commands & quick reference | `qofeno help` |
| `/quit` | `/exit`, `/q` | Exit the interactive session cleanly | — |
| `/clear` | `/cls` | Clear current screen / buffer | `qofeno session clear` |
| `/reset` | `/new` | Reset context and begin a new session | `qofeno session clear` |
| `/compact` | `/compress` | Summarize and compact session conversation context | — |
| `/model` | `/m` | Inspect available models or switch active model | `qofeno model` |
| `/provider` | — | Manage AI provider configurations | `qofeno provider` |
| `/mode` | — | Switch between `plan`, `review`, `execute`, `autonomous`, `restricted` | `qofeno --mode <mode>` |
| `/sessions` | `/history` | List recent conversation sessions | `qofeno session list` |
| `/resume` | — | Resume a session by ID | `qofeno session resume <id>` |
| `/export` | — | Export session transcript (JSON, Markdown, HTML) | `qofeno export` |
| `/share` | — | Generate a shareable summary transcript | `qofeno share` |
| `/copy` | — | Copy last response or code block to clipboard | — |
| `/cost` | `/usage` | Show session token counts and cost estimate | — |
| `/config` | `/settings` | Get or set configuration options | `qofeno config` |
| `/permissions` | `/perms` | Inspect security grants and policy denies | `qofeno permissions list` |
| `/memory` | `/mem` | Add or list persistent project memory notes | `qofeno memory` |
| `/memory-forget` | — | Delete a memory note by ID | `qofeno memory forget <id>` |
| `/knowledge` | `/kb` | Index project files or query knowledge collection | `qofeno knowledge` |
| `/repo` | — | Search symbols and index codebase files | `qofeno repo` |
| `/tools` | — | List available tools and security risk levels | `qofeno tools` |
| `/doctor` | `/diagnostics` | Check runtime, dependencies, and provider health | `qofeno doctor` |
| `/init` | — | Scaffold project configuration files | `qofeno init` |
| `/diff` | — | View workspace changes or file diffs | `qofeno diff` |
| `/plan` | — | Run planning agent on a goal | `qofeno agents run` |
| `/hardware` | `/hw` | Show hardware specifications and model tier | `qofeno model recommend` |
| `/setup` | `/install` | Launch guided local model installer | `qofeno setup` |
| `/theme` | — | Set color theme (`dark`, `light`, `high-contrast`, `no-color`) | `qofeno config set theme` |
| `/privacy` | — | Show local data map and network security policy | `qofeno privacy` |
| `/version` | — | Display installed Qofeno version | `qofeno version` |

## Standard Exit Codes

| Code | Name | Description |
|:---|:---|:---|
| `0` | Success | Normal successful completion |
| `1` | General Error | Generic operational error |
| `2` | Invalid Input | Command argument or option parsing error |
| `3` | Policy / Permission | Action blocked by deterministic security policy |
| `4` | Not Found | Target model, session, provider, or file not found |
| `5` | Conflict | Resource conflict or immutable version collision |
| `20` | Provider Error | AI model or provider endpoint failure |
| `21` | Authentication | Missing or invalid API credentials |
| `22` | Storage Error | SQLite database or filesystem storage failure |
| `23` | Rate Limited | Provider rate limit exceeded |
| `124` | Timeout | Process or request timeout exceeded |
| `130` | Cancelled | Process cancelled via SIGINT / Ctrl-C |
