# pi-multi-agent

Multi-agent orchestrator using only the `pi` CLI. Spawns sub-agents with different providers/models.

## How It Works

When you call `delegate`, this extension spawns separate `pi` processes:

```bash
pi -ne --provider <provider> --model <model> -p <prompt>
```

Each agent runs in isolation and can use different providers/models.

## Configuration

Edit `agents.json`:

```json
{
  "orchestrator": {
    "systemPromptAddendum": "\n## Multi-Agent Orchestration\n\nYou are an orchestrator..."
  },
  "agents": {
    "design": {
      "name": "Designer",
      "provider": "kimi-coding",
      "model": "k2p5",
      "promptPrefix": "You are a frontend specialist..."
    },
    "code": {
      "name": "Coder", 
      "provider": "gemini-coding",
      "model": "gemini-2.5-pro",
      "promptPrefix": "You are a coding specialist..."
    }
  },
  "fallbacks": {
    "design": { "provider": "kimi-coding", "model": "k2p5" },
    "code": { "provider": "gemini-coding", "model": "gemini-2.5-pro" }
  },
  "shared": {
    "spiSystemPrompt": "\n## Specialist Tools\n\nYou have one delegation tool: `delegate`...",
    "agientContext": "\n## Context\n\nRead AGENT.md before starting..."
  }
}
```

## Usage

```
delegate { design: "Create a React component..." }
delegate { code: "Implement the backend API..." }
delegate { design: "...", code: "..." }  // Parallel
```

## Commands

- `/agents` - Show configured agents
- `/reload-agents` - Reload agents.json
- `/agents-dashboard` - Show full agent activity dashboard

## Installation

Copy to `~/.pi/agent/extensions/pi-multi-agent/` and reload pi.
