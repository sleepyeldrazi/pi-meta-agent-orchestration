# cross-agent-orchestrator

Multi-agent orchestrator using external agent tools (Claude Code, OpenCode, etc.).

## How It Works

When you call `delegate`, this extension spawns external agent processes:

- **Design tasks**: Calls `claude` (Claude Code)
- **Coding tasks**: Calls `opencode` with GLM model
- **Fallback**: Falls back to `pi` CLI if primary tools fail

## Configuration

Edit `config.json`:

```json
{
  "orchestrator": {
    "provider": "kimi-coding",
    "model": "k2p5"
  },
  "agents": {
    "claude-design": {
      "name": "Claude Design Agent",
      "command": "claude",
      "type": "design",
      "model": "claude-opus-4"
    },
    "opencode-code": {
      "name": "OpenCode Coding Agent",
      "command": "opencode",
      "type": "coding",
      "model": "zai-coding-plan/glm-5.1"
    }
  }
}
```

## Requirements

- `claude` - Claude Code CLI (for design tasks)
- `opencode` - OpenCode CLI (for coding tasks with GLM)
- `pi` - pi CLI (for fallback)

## Usage

```
design { task: "Create a landing page..." }
code { task: "Implement the API..." }
```

Or use the unified interface (if SPI mode is enabled):

```
delegate { design: "..." }
delegate { code: "..." }
```

## SPI Mode

Set `SPI_MODE=1` to enable the unified `design`/`code`/`delegate` interface.

## Commands

- `/test-fallback` - Test the fallback mechanism

## Installation

Copy to `~/.pi/agent/extensions/cross-agent-orchestrator/` and reload pi.
