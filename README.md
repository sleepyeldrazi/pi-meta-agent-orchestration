# pi-meta-agent-orchestration

A unified pi extension for multi-agent coding workflows with mode selection.

## Overview

Single extension that supports two orchestrator modes:

| Mode | Agents | Best For |
|------|--------|----------|
| **pi-only** | Spawns sub-agents via `pi` CLI with configurable providers | Using different providers/models per task, isolated worktrees |
| **cross-harness** | Claude Code (design) + OpenCode/GLM (code) with pi fallback | Leveraging specialized external tools for maximum quality |

On first launch, the extension defaults to **pi-only** mode. Switch anytime with `/orchestrator-mode`.

## Installation

```bash
cp -r multi-agent-orchestrator ~/.pi/agent/extensions/
```

Then reload pi with `/reload` or restart.

## Usage

The `delegate` tool is registered for the LLM to use:

```
delegate { design: "Create a landing page..." }
delegate { code: "Implement the API..." }
delegate { design: "...", code: "..." }  // Runs in parallel
```

### Commands

| Command | Description |
|---------|-------------|
| `/agents` | Show configured agents, mode, and providers |
| `/orchestrator-mode` | Switch between pi-only and cross-harness |
| `/agents-dashboard` | Full TUI dashboard overlay for agent activity |
| `/reload-agents` | Reload agents.json configuration |

### Post-Delegation Verification

After any `code` delegation, the orchestrator is instructed to:
1. Run the project's test suite
2. Run the linter/type-checker
3. If failures occur, delegate again with the errors to fix them
4. Repeat until all checks pass

## Configuration

### Mode selection

Mode is persisted in `multi-agent-orchestrator/.mode`. Delete it to get the selection prompt on next launch.

### pi-only mode: agents.json

Edit `agents.json` to set providers, models, and prompts per agent role:

```json
{
  "agents": {
    "design": {
      "provider": "kimi-coding",
      "model": "k2p5",
      "promptPrefix": "You are a frontend specialist..."
    },
    "code": {
      "provider": "gemini-coding",
      "model": "gemini-2.5-pro",
      "promptPrefix": "You are a coding specialist..."
    }
  },
  "fallbacks": {
    "design": { "provider": "kimi-coding", "model": "k2p5" },
    "code": { "provider": "gemini-coding", "model": "gemini-2.5-pro" }
  }
}
```

### cross-harness mode

Fixed routing:
- **Design**: Claude Opus (`claude` CLI) → pi fallback
- **Code**: GLM-5 (`opencode` CLI) → pi fallback

Requirements:
- `claude` CLI installed and authenticated
- `opencode` CLI installed

## spi wrapper

An optional `spi` wrapper is provided for convenience. The mode selection happens inside the extension, so `spi` is just a thin alias:

```bash
#!/usr/bin/env bash
exec pi "$@"
```

## pi-aware Skill

The included `pi-aware` skill provides guidelines for the agent to understand and modify pi configuration when needed.

Install to `~/.pi/agent/skills/pi-aware/`.

## License

Apache License 2.0 — see `multi-agent-orchestrator/LICENSE.txt`.
