# pi-meta-agent-orchestration

Two complementary pi extensions for multi-agent coding workflows.

## Overview

| Extension | Use Case | How It Works |
|-----------|----------|--------------|
| **pi-multi-agent** | Local delegation with pi CLI | Spawns sub-agents using `pi -ne --provider X --model Y` |
| **cross-agent-orchestrator** | Cross-tool delegation | Calls external agents directly (Claude Code, OpenCode, etc.) |

## pi-multi-agent

Delegates tasks to specialist agents by spawning separate pi processes.

**Best for:**
- Using different providers/models for different tasks
- Isolated worktrees per agent
- Falling back to alternative providers if one fails

**Requirements:**
- `pi` CLI installed and in PATH
- API keys configured for your chosen providers

**Configuration:**
Edit `agents.json` to set providers, models, and prompts:

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

## cross-agent-orchestrator

Delegates tasks to external agent tools (Claude Code, OpenCode, etc.).

**Best for:**
- Leveraging specialized tools like Claude Code or OpenCode
- Workflows requiring specific external agent capabilities
- SPI mode integration with Claude Code

**Requirements:**
- `claude` CLI (for design tasks)
- `opencode` CLI (for coding tasks with GLM)
- Or configure fallback to `pi` CLI

**Configuration:**
Edit `config.json`:

```json
{
  "agents": {
    "claude-design": {
      "command": "claude",
      "model": "claude-opus-4"
    },
    "opencode-code": {
      "command": "opencode",
      "model": "zai-coding-plan/glm-5.1"
    }
  }
}
```

## Installation

Copy the extension directory to `~/.pi/agent/extensions/`:

```bash
# For pi-multi-agent
cp -r pi-multi-agent ~/.pi/agent/extensions/

# For cross-agent-orchestrator
cp -r cross-agent-orchestrator ~/.pi/agent/extensions/
```

Then reload pi with `/reload` or restart.

## Usage

Both extensions register a `delegate` tool:

```
delegate { design: "Create a landing page..." }
delegate { code: "Implement the API..." }
delegate { design: "...", code: "..." }  // Runs in parallel
```

## pi-aware Skill

The included `pi-aware` skill provides guidelines for the agent to understand and modify pi configuration when needed.

Install to `~/.pi/agent/skills/pi-aware/`.

## License

See individual extension LICENSE files.
