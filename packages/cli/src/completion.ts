/**
 * Shell completion scripts generator for Bash, Zsh, Fish, and PowerShell.
 */
import { COMMAND_MATRIX, SLASH_COMMANDS } from "./command-matrix.js";

export function generateCompletion(shell: "bash" | "zsh" | "fish" | "powershell"): string {
  const commands = COMMAND_MATRIX.map((c) => c.name);
  const allCmds = Array.from(new Set(COMMAND_MATRIX.flatMap((c) => [c.name, ...c.aliases]))).filter(
    (c) => !c.startsWith("-")
  );

  switch (shell) {
    case "bash":
      return `# bash completion for qofeno
_qofeno_completions() {
    local cur prev opts
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    opts="${allCmds.join(" ")} --help --version --model --mode --local-only --output-format"

    if [[ \${COMP_CWORD} -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "\${opts}" -- \${cur}) )
        return 0
    fi

    case "\${prev}" in
        --model|-m)
            COMPREPLY=( $(compgen -W "ollama:qwen2.5-coder:7b ollama:llama3.2:3b openai:gpt-4o anthropic:claude-3-5-sonnet openrouter:auto" -- \${cur}) )
            return 0
            ;;
        --mode)
            COMPREPLY=( $(compgen -W "plan review execute autonomous restricted" -- \${cur}) )
            return 0
            ;;
        --output-format)
            COMPREPLY=( $(compgen -W "text json jsonl" -- \${cur}) )
            return 0
            ;;
        completion)
            COMPREPLY=( $(compgen -W "bash zsh fish powershell" -- \${cur}) )
            return 0
            ;;
        session|sessions)
            COMPREPLY=( $(compgen -W "list resume export rm rename clear info" -- \${cur}) )
            return 0
            ;;
        provider|providers)
            COMPREPLY=( $(compgen -W "list add set test remove models" -- \${cur}) )
            return 0
            ;;
        model|models)
            COMPREPLY=( $(compgen -W "list recommend info use install search status" -- \${cur}) )
            return 0
            ;;
        config|settings)
            COMPREPLY=( $(compgen -W "get set list reset path policy" -- \${cur}) )
            return 0
            ;;
        memory|mem)
            COMPREPLY=( $(compgen -W "list add forget clear" -- \${cur}) )
            return 0
            ;;
        knowledge|kb)
            COMPREPLY=( $(compgen -W "index search list clear" -- \${cur}) )
            return 0
            ;;
        repo)
            COMPREPLY=( $(compgen -W "index search symbols status" -- \${cur}) )
            return 0
            ;;
        permissions|perms)
            COMPREPLY=( $(compgen -W "list grant deny revoke reset" -- \${cur}) )
            return 0
            ;;
        auth)
            COMPREPLY=( $(compgen -W "login logout status" -- \${cur}) )
            return 0
            ;;
        tools)
            COMPREPLY=( $(compgen -W "list info" -- \${cur}) )
            return 0
            ;;
        *)
            ;;
    esac
}
complete -F _qofeno_completions qofeno
`;

    case "zsh":
      return `#compdef qofeno
# zsh completion for qofeno

_qofeno() {
    local -a commands
    commands=(
${COMMAND_MATRIX.map((c) => `        '${c.name}:${c.description.replace(/'/g, "")}'`).join("\n")}
    )

    _arguments -C \
        '(-h --help)'{-h,--help}'[Show help and syntax guide]' \
        '(-v --version)'{-v,--version}'[Print version]' \
        '(-m --model)'{-m,--model}'[Select model]:model:()' \
        '--mode[Select mode]:mode:(plan review execute autonomous restricted)' \
        '--output-format[Output format]:format:(text json jsonl)' \
        '--local-only[Enforce offline local execution]' \
        '1: :->command' \
        '*:: :->args'

    case $state in
        command)
            _describe -t commands 'qofeno commands' commands
            ;;
        args)
            case $words[1] in
                session|sessions)
                    _values 'subcommands' list resume export rm rename clear info
                    ;;
                provider|providers)
                    _values 'subcommands' list add set test remove models
                    ;;
                model|models)
                    _values 'subcommands' list recommend info use install search status
                    ;;
                config|settings)
                    _values 'subcommands' get set list reset path policy
                    ;;
                completion)
                    _values 'shell' bash zsh fish powershell
                    ;;
            esac
            ;;
    esac
}

_qofeno "$@"
`;

    case "fish":
      return `# fish completion for qofeno
complete -c qofeno -f
${COMMAND_MATRIX.map((c) => `complete -c qofeno -n "__fish_use_subcommand" -a "${c.name}" -d "${c.description.replace(/"/g, "")}"`).join("\n")}
complete -c qofeno -s h -l help -d "Show help"
complete -c qofeno -s v -l version -d "Print version"
complete -c qofeno -s m -l model -d "Select model"
complete -c qofeno -l mode -a "plan review execute autonomous restricted" -d "Session mode"
complete -c qofeno -l output-format -a "text json jsonl" -d "Output format"
complete -c qofeno -l local-only -d "Force offline execution"
complete -c qofeno -n "__fish_seen_subcommand_from completion" -a "bash zsh fish powershell" -d "Shell completion target"
`;

    case "powershell":
      return `# PowerShell completion for qofeno
Register-ArgumentCompleter -Native -CommandName qofeno -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    $commands = @(${allCmds.map((c) => `"${c}"`).join(", ")})
    $subcommands = @{
        "session" = @("list", "resume", "export", "rm", "rename", "clear", "info")
        "sessions" = @("list", "resume", "export", "rm", "rename", "clear", "info")
        "provider" = @("list", "add", "set", "test", "remove", "models")
        "providers" = @("list", "add", "set", "test", "remove", "models")
        "model" = @("list", "recommend", "info", "use", "install", "search", "status")
        "models" = @("list", "recommend", "info", "use", "install", "search", "status")
        "config" = @("get", "set", "list", "reset", "path", "policy")
        "settings" = @("get", "set", "list", "reset", "path", "policy")
        "memory" = @("list", "add", "forget", "clear")
        "knowledge" = @("index", "search", "list", "clear")
        "repo" = @("index", "search", "symbols", "status")
        "permissions" = @("list", "grant", "deny", "revoke", "reset")
        "auth" = @("login", "logout", "status")
        "tools" = @("list", "info")
        "completion" = @("bash", "zsh", "fish", "powershell")
    }

    $elements = $commandAst.CommandElements
    if ($elements.Count -le 2) {
        $commands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
        }
    } else {
        $cmd = $elements[1].Extent.Text
        if ($subcommands.ContainsKey($cmd)) {
            $subcommands[$cmd] | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
            }
        }
    }
}
`;
  }
}
