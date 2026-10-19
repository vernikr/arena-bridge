COMPLETION_BASH = """# arena-bridge bash completion
# Usage: arena-bridge completion bash >> ~/.bashrc
_arena_bridge_complete() {
  local cur prev words cword
  _init_completion || return
  local cmds="setup init start tunnel hub connect prompt tools approvals approve rotate trust audit config telegram doctor url version update service browser completion help"
  local flags="--mode --device --root --port --host --hub --public-url --protocol --bin --authtoken --domain --no-approval --no-shell --for --tools --paths --off --status --json --help"
  if [[ $cword == 1 ]]; then
    COMPREPLY=( $(compgen -W "$cmds" -- "$cur") )
    return
  fi
  local cmd="${words[1]}"
  case "$cmd" in
    config) COMPREPLY=( $(compgen -W "list get set edit" -- "$cur") ) ;;
    trust) COMPREPLY=( $(compgen -W "--for --tools --paths --off --status --json" -- "$cur") ) ;;
    telegram) COMPREPLY=( $(compgen -W "setup test status inbox poll" -- "$cur") ) ;;
    service) COMPREPLY=( $(compgen -W "install uninstall status" -- "$cur") ) ;;
    browser) COMPREPLY=( $(compgen -W "list login close open" -- "$cur") ) ;;
    audit) COMPREPLY=( $(compgen -W "artifacts dir prune" -- "$cur") ) ;;
    *) COMPREPLY=( $(compgen -W "$flags" -- "$cur") ) ;;
  esac
}
complete -F _arena_bridge_complete arena-bridge
"""

COMPLETION_ZSH = """# arena-bridge zsh completion
# Usage: arena-bridge completion zsh >> ~/.zshrc
#compdef arena-bridge
_arena_bridge() {
  local -a completions
  _arguments -C \\
    "1: :->cmd" \\
    "*:: :->args"
  case "$state" in
    cmd)
      completions=(
        "setup:One-shot create config + check + start"
        "init:Create config with fresh tokens"
        "start:Run local API server"
        "tunnel:Start API + cloudflared tunnel"
        "hub:Run relay server"
        "connect:Connect to hub as device"
        "prompt:Print agent instructions"
        "tools:Print tool catalog"
        "approvals:List pending approvals"
        "approve:Approve a pending request"
        "trust:Manage trust window"
        "audit:Show audit log"
        "config:Manage configuration"
        "telegram:Telegram integration"
        "doctor:Check installation"
        "url:Print public URL"
        "version:Show version"
        "update:Update package"
        "service:Background service"
        "browser:Browser profiles"
        "completion:Shell completion"
      )
      _describe -t commands 'arena-bridge commands' completions
      ;;
    args)
      case "$words[1]" in
        config) _describe -t subcmd 'config' '(list get set edit)' ;;
        trust) _arguments "--for[duration]" "--tools[tools]" "--paths[paths]" "--off" "--status" "--json" ;;
        telegram) _describe -t subcmd 'telegram' '(setup test status inbox poll)' ;;
        service) _describe -t subcmd 'service' '(install uninstall status)' ;;
        browser) _describe -t subcmd 'browser' '(list login close open)' ;;
      esac
      ;;
  esac
}
compdef _arena_bridge arena-bridge
"""

COMPLETION_FISH = """# arena-bridge fish completion
# Usage: arena-bridge completion fish > ~/.config/fish/completions/arena-bridge.fish
complete -c arena-bridge -f
complete -c arena-bridge -n "__fish_use_subcommand" -a setup -d "One-shot setup"
complete -c arena-bridge -n "__fish_use_subcommand" -a init -d "Create config"
complete -c arena-bridge -n "__fish_use_subcommand" -a start -d "Run API server"
complete -c arena-bridge -n "__fish_use_subcommand" -a tunnel -d "API + tunnel"
complete -c arena-bridge -n "__fish_use_subcommand" -a hub -d "Relay server"
complete -c arena-bridge -n "__fish_use_subcommand" -a connect -d "Connect to hub"
complete -c arena-bridge -n "__fish_use_subcommand" -a prompt -d "Agent instructions"
complete -c arena-bridge -n "__fish_use_subcommand" -a tools -d "Tool catalog"
complete -c arena-bridge -n "__fish_use_subcommand" -a approvals -d "List approvals"
complete -c arena-bridge -n "__fish_use_subcommand" -a approve -d "Approve request"
complete -c arena-bridge -n "__fish_use_subcommand" -a trust -d "Trust window"
complete -c arena-bridge -n "__fish_use_subcommand" -a audit -d "Audit log"
complete -c arena-bridge -n "__fish_use_subcommand" -a config -d "Manage config"
complete -c arena-bridge -n "__fish_use_subcommand" -a telegram -d "Telegram"
complete -c arena-bridge -n "__fish_use_subcommand" -a doctor -d "Check install"
complete -c arena-bridge -n "__fish_use_subcommand" -a url -d "Public URL"
complete -c arena-bridge -n "__fish_use_subcommand" -a version -d "Version"
complete -c arena-bridge -n "__fish_use_subcommand" -a update -d "Update"
complete -c arena-bridge -n "__fish_use_subcommand" -a service -d "Background service"
complete -c arena-bridge -n "__fish_use_subcommand" -a browser -d "Browser profiles"
complete -c arena-bridge -n "__fish_use_subcommand" -a completion -d "Shell completion"
"""
print("created completion.py")
