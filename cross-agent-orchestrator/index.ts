import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const FRONTEND_DESIGN_SKILL = `Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications (examples include websites, landing pages, dashboards, React components, HTML/CSS layouts, or when styling/beautifying any web UI). Generates creative, polished code and UI design that avoids generic AI aesthetics.

License: See LICENSE.txt in the cross-agent-orchestrator extension directory (Apache License 2.0)

---

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

The user provides frontend requirements: a component, page, application, or interface to build. They may include context about the purpose, audience, or technical constraints.

## Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc. There are so many flavors to choose from. Use these for inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

Then implement working code (HTML/CSS/JS, React, Vue, etc.) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines

Focus on:
- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics; unexpected, characterful font choices. Pair a distinctive display font with a refined body font.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. Use scroll-triggering and hover states that surprise.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial, system fonts), cliched color schemes (particularly purple gradients on white backgrounds), predictable layouts and component patterns, and cookie-cutter design that lacks context-specific character.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, different aesthetics. NEVER converge on common choices (Space Grotesk, for example) across generations.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.

Remember: You are capable of extraordinary creative work. Don't hold back, show what can truly be created when thinking outside the box and committing fully to a distinctive vision.`;

const isSpiMode = process.env.SPI_MODE === "1";

const SPI_SYSTEM_PROMPT = `

## Specialist Tools

You have two specialist tools. Use them.

- \`code\`: for writing, editing, debugging, or refactoring code (backend/logic ONLY)
- \`design\`: for visual interfaces, UI components, HTML/CSS, TUI, styling

Rules:
1. Before calling \`code\` or \`design\`, create AGENT.md with: task description, tech stack, files to modify
2. Any task involving code (backend/logic) → call \`code\`
3. Any task involving UI/visual design → call \`design\`
4. NEVER let \`code\` design UI. It only handles backend/logic.
5. After \`code\` and/or \`design\` complete: check AGENT.md for remaining work, verify their outputs are compatible
6. Non-code, non-design tasks → handle yourself
7. Do not write code or design interfaces directly. Delegate.`;

const AGENT_CONTEXT = `

## Context

Read AGENT.md in this directory before starting. It contains the task description, tech stack, and any other context from the caller.

`;

// ─── Agent Monitor State ─────────────────────────────────────────────────────

interface AgentState {
  name: string;
  status: "running" | "complete" | "failed";
  output?: string;
  startTime: number;
}

const agentMonitor = {
  agents: new Map<string, AgentState>(),
  startAgent(key: string, name: string) {
    this.agents.set(key, { name, status: "running", startTime: Date.now() });
  },
  updateAgent(key: string, output: string) {
    const agent = this.agents.get(key);
    if (agent) agent.output = output;
  },
  completeAgent(key: string, success: boolean) {
    const agent = this.agents.get(key);
    if (agent) agent.status = success ? "complete" : "failed";
  },
  clear() {
    this.agents.clear();
  }
};

function renderMonitorWidget(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  const lines: string[] = ["\x1b[1m Agent Activity \x1b[0m", ""];
  for (const [key, agent] of agentMonitor.agents) {
    const icon = agent.status === "running" ? "\x1b[33m●\x1b[0m" 
               : agent.status === "complete" ? "\x1b[32m✓\x1b[0m" 
               : "\x1b[31m✗\x1b[0m";
    const elapsed = Math.round((Date.now() - agent.startTime) / 1000);
    const preview = agent.output ? agent.output.slice(0, 50).replace(/\n/g, " ") + "..." : "waiting...";
    lines.push(`${icon} \x1b[1m${agent.name}\x1b[0m (${elapsed}s)`);
    lines.push(`  \x1b[2m${preview}\x1b[0m`);
  }
  if (agentMonitor.agents.size === 0) {
    lines.push("\x1b[2mNo active agents\x1b[0m");
  }
  ctx.ui.setWidget("agent-monitor", lines, { placement: "aboveEditor" });
}

function clearMonitorWidget(ctx: ExtensionContext) {
  setTimeout(() => {
    try { if (ctx.hasUI) ctx.ui.setWidget("agent-monitor", undefined); } catch {}
  }, 5000);
}

// ─── Usage Fetching ───────────────────────────────────────────────────────────

interface UsageLimits {
  fiveHour: { utilization: number; resetsAt: string };
  weekly: { utilization: number; resetsAt: string };
}

const CLAUDE_CREDENTIALS_PATH = path.join(process.env.HOME || "", ".claude/.credentials.json");
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

async function getClaudeAccessToken(): Promise<string | null> {
  try {
    if (!fs.existsSync(CLAUDE_CREDENTIALS_PATH)) return null;
    const creds = JSON.parse(fs.readFileSync(CLAUDE_CREDENTIALS_PATH, "utf-8"));
    let token = creds.claudeAiOauth?.accessToken;
    const expiresAt = creds.claudeAiOauth?.expiresAt || 0;
    
    if (expiresAt > 0 && expiresAt <= Date.now()) {
      const refreshToken = creds.claudeAiOauth?.refreshToken;
      if (!refreshToken) return null;
      
      const response = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE_OAUTH_CLIENT_ID }),
      });
      
      if (!response.ok) return null;
      const data = await response.json();
      token = data.access_token;
      creds.claudeAiOauth.accessToken = token;
      creds.claudeAiOauth.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
      fs.writeFileSync(CLAUDE_CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
    }
    return token || null;
  } catch { return null; }
}

async function fetchClaudeUsage(): Promise<UsageLimits | null> {
  try {
    const token = await getClaudeAccessToken();
    if (!token) return null;
    
    const response = await fetch(CLAUDE_USAGE_URL, {
      headers: { 
        "Authorization": `Bearer ${token}`, 
        "anthropic-beta": CLAUDE_OAUTH_BETA 
      },
    });
    if (!response.ok) return null;
    
    const data = await response.json();
    return {
      fiveHour: { utilization: data.five_hour?.utilization || 0, resetsAt: data.five_hour?.resets_at || "" },
      weekly: { utilization: data.seven_day?.utilization || 0, resetsAt: data.seven_day?.resets_at || "" },
    };
  } catch { return null; }
}

async function fetchGlmUsage(): Promise<UsageLimits | null> {
  return new Promise((resolve) => {
    const proc = spawn("ssh", [
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=5",
      "dietpi@192.168.178.70",
      "cat /opt/kimi-monitor/data/usage.json"
    ], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    
    let output = "";
    proc.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    
    proc.on("close", (code) => {
      if (code !== 0 || !output.trim()) {
        resolve(null);
        return;
      }
      try {
        const data = JSON.parse(output);
        const glm = data.services?.glm?.data;
        if (!glm) {
          resolve(null);
          return;
        }
        resolve({
          fiveHour: { utilization: glm["5h"]?.used || 0, resetsAt: glm["5h"]?.reset || "" },
          weekly: { utilization: glm.weekly?.used || 0, resetsAt: glm.weekly?.reset || "" },
        });
      } catch {
        resolve(null);
      }
    });
    proc.on("error", () => resolve(null));
  });
}

// ─── Process Runners ──────────────────────────────────────────────────────────

async function runClaude(prompt: string, cwd: string, ctx: ExtensionContext): Promise<string> {
  return new Promise((resolve, reject) => {
    agentMonitor.startAgent("claude", "Claude Design");
    renderMonitorWidget(ctx);

    const args = ["-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"];
    const proc = spawn("claude", [...args, prompt], { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let buffer = "";

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "assistant" && event.message?.content) {
            const text: string = event.message.content
              .filter((b: { type: string }) => b.type === "text")
              .map((b: { type: string; text: string }) => b.text)
              .join("");
            if (text) {
              output = text;
              agentMonitor.updateAgent("claude", output);
              renderMonitorWidget(ctx);
            }
          } else if (event.type === "result" && event.result) {
            output = event.result;
          }
        } catch {}
      }
    });

    proc.on("close", (code) => {
      agentMonitor.completeAgent("claude", code === 0);
      renderMonitorWidget(ctx);
      clearMonitorWidget(ctx);
      if (code === 0) resolve(output || "(no output)");
      else reject(new Error(`Claude exited with code ${code}`));
    });
    proc.on("error", (err) => {
      agentMonitor.completeAgent("claude", false);
      renderMonitorWidget(ctx);
      reject(err);
    });
  });
}

async function runOpencode(prompt: string, cwd: string, ctx: ExtensionContext): Promise<string> {
  return new Promise((resolve, reject) => {
    agentMonitor.startAgent("glm", "GLM Code");
    renderMonitorWidget(ctx);

    const args = ["run", "--format", "json", "-m", "zai-coding-plan/glm-5", prompt];
    const proc = spawn("opencode", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let buffer = "";

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "text" && event.part?.text) {
            output += event.part.text;
            agentMonitor.updateAgent("glm", output);
            renderMonitorWidget(ctx);
          }
        } catch {}
      }
    });

    proc.on("close", (code) => {
      agentMonitor.completeAgent("glm", code === 0);
      renderMonitorWidget(ctx);
      clearMonitorWidget(ctx);
      if (code === 0) resolve(output || "(no output)");
      else reject(new Error(`OpenCode exited with code ${code}`));
    });
    proc.on("error", (err) => {
      agentMonitor.completeAgent("glm", false);
      renderMonitorWidget(ctx);
      reject(err);
    });
  });
}

async function runPiFallback(prompt: string, cwd: string, ctx: ExtensionContext): Promise<string> {
  return new Promise((resolve, reject) => {
    agentMonitor.startAgent("kimi", "Kimi Fallback");
    renderMonitorWidget(ctx);

    const args = ["--provider", "kimi-coding", "-p", prompt];
    const proc = spawn("pi", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    
    proc.stdout.on("data", (data: Buffer) => { 
      output += data.toString();
      agentMonitor.updateAgent("kimi", output);
      renderMonitorWidget(ctx);
    });
    
    proc.on("close", (code) => {
      agentMonitor.completeAgent("kimi", code === 0);
      renderMonitorWidget(ctx);
      clearMonitorWidget(ctx);
      if (code === 0) resolve(output || "(no output)");
      else reject(new Error(`Pi fallback exited with code ${code}`));
    });
    proc.on("error", (err) => {
      agentMonitor.completeAgent("kimi", false);
      renderMonitorWidget(ctx);
      reject(err);
    });
  });
}

// ─── Extension Entry Point ───────────────────────────────────────────────────

export default function multiAgentOrchestrator(pi: ExtensionAPI) {
  if (!isSpiMode) {
    console.log("[SPI] Not in SPI mode, skipping");
    return;
  }

  async function updateUsageFooter(ctx: ExtensionContext) {
    const [claude, glm] = await Promise.all([fetchClaudeUsage(), fetchGlmUsage()]);
    const c5 = claude ? Math.round(claude.fiveHour.utilization) : "?";
    const cw = claude ? Math.round(claude.weekly.utilization) : "?";
    const g5 = glm ? Math.round(glm.fiveHour.utilization) : "?";
    const gw = glm ? Math.round(glm.weekly.utilization) : "?";
    ctx.ui.setStatus("spi-usage", `\x1b[2mC:${c5}%/${cw}% G:${g5}%/${gw}%\x1b[0m`);
  }

  pi.registerTool({
    name: "design",
    label: "Design",
    description: "Creates visual interfaces, UI components, TUI, styling, HTML/CSS, React components, dashboards, landing pages. Use for: web design, React components, HTML/CSS, TUI, styling, any visual/frontend work.",
    promptSnippet: "Use for visual interfaces, UI components, TUI, styling, HTML/CSS, React components, dashboards, landing pages.",
    promptGuidelines: [
      "Use for any visual/frontend work: web design, UI components, TUI, styling, HTML/CSS, React components, dashboards, landing pages.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Description of what to design/create" })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { task } = params as { task: string };
      const cwd = process.cwd();
      
      let agentMd = "";
      const agentMdPath = path.join(cwd, "AGENT.md");
      if (fs.existsSync(agentMdPath)) {
        agentMd = fs.readFileSync(agentMdPath, "utf-8");
      }
      
      const prompt = `${AGENT_CONTEXT}

${FRONTEND_DESIGN_SKILL}

---

${agentMd ? `Context from AGENT.md:\n${agentMd}\n\n---\n\n` : ""}

Task: ${task}

Read AGENT.md first, then complete the task.

When done, update AGENT.md with what you designed.`;

      ctx.ui.notify("Running Claude for design...", "info");

      try {
        const result = await runClaude(prompt, cwd, ctx);
        ctx.ui.notify("Design complete", "success");
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Claude failed: ${msg}. Falling back...`, "warning");
        try {
          const result = await runPiFallback(task, cwd, ctx);
          ctx.ui.notify("Fallback complete", "success");
          return { content: [{ type: "text", text: result }] };
        } catch (fallbackErr) {
          const errMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          return { content: [{ type: "text", text: `Error: ${errMsg}` }] };
        }
      }
    }
  });

  pi.registerTool({
    name: "code",
    label: "Code",
    description: "Writes code. Use for: implementation, debugging, refactoring, algorithms, scripts, multi-file projects, any coding work.",
    promptSnippet: "Use for any coding task: implementation, debugging, refactoring, algorithms, scripts.",
    promptGuidelines: [
      "Use for any coding task: implementation, debugging, refactoring, algorithms, scripts, multi-file projects.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Description of the coding task" }),
      files: Type.Optional(Type.String({ description: "Optional: specific files or codebase context" }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { task, files } = params as { task: string; files?: string };
      const cwd = process.cwd();
      
      let agentMd = "";
      const agentMdPath = path.join(cwd, "AGENT.md");
      if (fs.existsSync(agentMdPath)) {
        agentMd = fs.readFileSync(agentMdPath, "utf-8");
      }
      
      const prompt = `${AGENT_CONTEXT}

${agentMd ? `Context from AGENT.md:\n${agentMd}\n\n---\n\n` : ""}

Task: ${task}${files ? `\n\nFiles: ${files}` : ""}

Read AGENT.md first, then complete the task.

Rules:
- Do NOT touch any UI/TUI/frontend code. Focus on backend/logic only.
- When done, update AGENT.md with what you implemented.`;

      ctx.ui.notify("Running GLM for coding...", "info");

      try {
        const result = await runOpencode(prompt, cwd, ctx);
        ctx.ui.notify("Coding complete", "success");
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`GLM failed: ${msg}. Falling back...`, "warning");
        try {
          const result = await runPiFallback(task, cwd, ctx);
          ctx.ui.notify("Fallback complete", "success");
          return { content: [{ type: "text", text: result }] };
        } catch (fallbackErr) {
          const errMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          return { content: [{ type: "text", text: `Error: ${errMsg}` }] };
        }
      }
    }
  });

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: event.systemPrompt + SPI_SYSTEM_PROMPT
    };
  });

  // Gently remind the orchestrator about delegation for coding/design tasks
  pi.on("input", async (event) => {
    // Only transform actual user prompts (not commands, not empty input)
    if (!event.text || event.text.startsWith("/") || event.text.trim().length === 0) {
      return { action: "continue" as const };
    }
    
    // Append a soft reminder about delegation
    const reminder = "\n\n(Consider using delegate if this involves coding or design work.)";
    return {
      action: "transform" as const,
      text: event.text + reminder
    };
  });

  pi.registerCommand("test-fallback", {
    description: "Test the fallback mechanism by intentionally failing Claude",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Testing fallback: running Claude with invalid args...", "info");
      
      try {
        const result = await runClaude("--invalid-flag-that-does-not-exist-xyz", process.cwd(), ctx);
        ctx.ui.notify("Unexpected: Claude succeeded?", "warning");
        return `Unexpected result: ${result}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Claude failed as expected: ${msg}. Testing fallback...`, "info");
        
        try {
          const fallbackResult = await runPiFallback("Say hello world", process.cwd(), ctx);
          ctx.ui.notify("Fallback test PASSED!", "success");
          return `Fallback test successful!\n\nClaude failed: ${msg}\nKimi result: ${fallbackResult}`;
        } catch (fallbackErr) {
          const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          ctx.ui.notify("Fallback test FAILED", "error");
          return `Fallback test failed!\n\nClaude error: ${msg}\nFallback error: ${fallbackMsg}`;
        }
      }
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("SPI ready. /test-fallback to verify fallback.", "info");
    updateUsageFooter(ctx);
    setInterval(() => updateUsageFooter(ctx), 60000);
  });
}
