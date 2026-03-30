import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, Key, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type { TUI, Component } from "@mariozechner/pi-tui";

// ─── Types ────────────────────────────────────────────────────────────────────

type OrchestratorMode = "pi-only" | "cross-harness";

interface AgentConfig {
  name: string;
  description: string;
  provider: string;
  model: string;
  promptPrefix: string;
  env?: Record<string, string>;
}

interface FallbackConfig {
  provider: string;
  model: string;
}

interface AgentsJson {
  orchestrator?: { systemPromptAddendum?: string };
  agents: { design: AgentConfig; code: AgentConfig };
  fallbacks: { design: FallbackConfig; code: FallbackConfig };
  shared: { agientContext: string; spiSystemPrompt: string };
}

interface AgentState {
  name: string;
  status: "running" | "complete" | "failed" | "waiting";
  output?: string;
  startTime: number;
  endTime?: number;
  provider: string;
  model: string;
  type: "design" | "code" | "fallback";
  linesGenerated: number;
  toolsExecuted: number;
  filesModified: Set<string>;
  currentActivity: string;
  outputSize: number;
}

// ─── Paths ────────────────────────────────────────────────────────────────────

const EXTENSION_DIR = path.join(
  process.env.HOME || "",
  ".pi/agent/extensions/multi-agent-orchestrator"
);
const MODE_FILE = path.join(EXTENSION_DIR, ".mode");

// ─── Design Skill (cross-harness mode) ────────────────────────────────────────

const FRONTEND_DESIGN_SKILL = `Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications (examples include websites, landing pages, dashboards, React components, HTML/CSS layouts, or when styling/beautifying any web UI). Generates creative, polished code and UI design that avoids generic AI aesthetics.

License: See LICENSE.txt in the multi-agent-orchestrator extension directory (Apache License 2.0)

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

// ─── System Prompts ───────────────────────────────────────────────────────────

const ORCHESTRATOR_SYSTEM_PROMPT = `

## Specialist Tools

You have one delegation tool: \`delegate\`.

Fields:
- \`design\`: UI/visual work — interfaces, TUI, HTML/CSS, React, styling
- \`code\`: backend logic — algorithms, implementation, debugging, scripts

Rules:
1. Before calling \`delegate\`, write AGENT.md with: task description, tech stack, files to modify, AND the project's test and lint commands (check package.json scripts, Makefile, pyproject.toml, Cargo.toml, etc.)
2. UI/visual only → \`delegate { design: "..." }\`
3. Backend/logic only → \`delegate { code: "..." }\`
4. Both needed → \`delegate { design: "...", code: "..." }\` — they run IN PARALLEL
5. After delegation: read AGENT.md and agent result files, verify outputs integrate correctly
6. Non-code, non-design tasks → handle yourself
7. Do not write code or design interfaces directly. Delegate.

## Post-Delegation Verification (MANDATORY)

After any \`code\` delegation returns:
1. Run the project's test suite (npm test, pytest, cargo test, make test, etc.)
2. Run the linter/type-checker (npm run lint, npm run typecheck, ruff check, cargo clippy, etc.)
3. If any failures occur:
   a. Read the full error output
   b. Delegate again with \`code\` field containing the errors and "fix these"
   c. Repeat until all checks pass
4. Do NOT report task completion to the user until tests and linter are clean
`;

const AGENT_CONTEXT = `

## Context

Read AGENT.md in this directory before starting. It contains the task description, tech stack, and any other context from the caller.

`;

const TEST_LINT_SUFFIX = `

After implementing your changes:
1. Identify and run the project's test suite (check package.json scripts, Makefile, pyproject.toml, Cargo.toml, pytest.ini, etc.)
2. Identify and run the linter/type-checker (npm run lint, npm run typecheck, ruff check, cargo clippy, etc.)
3. If any tests or lints fail, fix the issues and re-run
4. Repeat until all checks pass
`;

// ─── Config Loading ───────────────────────────────────────────────────────────

function loadAgentsConfig(extensionDir: string): AgentsJson {
  const configPath = path.join(extensionDir, "agents.json");
  const defaults: AgentsJson = {
    orchestrator: {},
    agents: {
      design: {
        name: "Designer",
        description: "Visual interfaces, UI components",
        provider: "kimi-coding",
        model: "k2p5",
        promptPrefix: "You are a frontend design specialist.",
      },
      code: {
        name: "Coder",
        description: "Backend logic, algorithms",
        provider: "kimi-coding",
        model: "k2p5",
        promptPrefix: "You are a coding specialist.",
      },
    },
    fallbacks: {
      design: { provider: "kimi-coding", model: "k2p5" },
      code: { provider: "gemini-coding", model: "gemini-2.5-pro" },
    },
    shared: {
      agientContext: "\n## Context\n\nRead AGENT.md before starting.",
      spiSystemPrompt: "\n## Specialist Tools\n\nYou have code and design tools.",
    },
  };

  try {
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return {
        orchestrator: { ...defaults.orchestrator, ...parsed.orchestrator },
        agents: {
          design: { ...defaults.agents.design, ...parsed.agents?.design },
          code: { ...defaults.agents.code, ...parsed.agents?.code },
        },
        fallbacks: {
          design: { ...defaults.fallbacks.design, ...parsed.fallbacks?.design },
          code: { ...defaults.fallbacks.code, ...parsed.fallbacks?.code },
        },
        shared: { ...defaults.shared, ...parsed.shared },
      };
    }
  } catch (err) {
    console.error("[multi-agent-orchestrator] Error loading agents.json:", err);
  }
  return defaults;
}

// ─── Braille Spinner ──────────────────────────────────────────────────────────

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerFrameIndex = 0;
let spinnerInterval: NodeJS.Timeout | null = null;

function startSpinner(callback: () => void) {
  if (spinnerInterval) return;
  spinnerInterval = setInterval(() => {
    spinnerFrameIndex = (spinnerFrameIndex + 1) % BRAILLE_FRAMES.length;
    callback();
  }, 80);
}

function stopSpinner() {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
  }
}

function getCurrentSpinnerFrame(): string {
  return BRAILLE_FRAMES[spinnerFrameIndex];
}

// ─── Agent Monitor ────────────────────────────────────────────────────────────

class AgentMonitor {
  agents = new Map<string, AgentState>();
  private widgetRenderCallback?: () => void;

  setWidgetRenderCallback(cb: () => void) {
    this.widgetRenderCallback = cb;
  }

  startAgent(
    key: string,
    name: string,
    provider: string,
    model: string,
    type: AgentState["type"]
  ) {
    this.agents.set(key, {
      name,
      status: "running",
      startTime: Date.now(),
      provider,
      model,
      type,
      linesGenerated: 0,
      toolsExecuted: 0,
      filesModified: new Set(),
      currentActivity: "Starting...",
      outputSize: 0,
    });
    if (this.hasRunningAgents())
      startSpinner(() => this.widgetRenderCallback?.());
    this.widgetRenderCallback?.();
  }

  updateAgent(key: string, output: string) {
    const agent = this.agents.get(key);
    if (!agent) return;
    agent.output = output;
    agent.outputSize = Buffer.byteLength(output, "utf-8");
    const lines = output.split("\n");
    agent.linesGenerated = lines.length;
    const toolRe = /^(read|write|edit|bash):/i;
    agent.toolsExecuted = lines.filter((l) => toolRe.test(l.trim())).length;
    const fileRe = /^(?:read|write|edit):\s*(\S+)/i;
    for (const line of lines) {
      const m = fileRe.exec(line.trim());
      if (m?.[1]) {
        const fp = m[1].replace(/["']/g, "").trim();
        if (fp && !fp.startsWith("-")) agent.filesModified.add(fp);
      }
    }
    const activity = this.extractActivity(lines);
    if (activity) agent.currentActivity = activity;
    this.widgetRenderCallback?.();
  }

  private extractActivity(lines: string[]): string | null {
    const meaningful = lines.map((l) => l.trim()).filter((l) => l.length > 0);
    if (meaningful.length === 0) return null;
    for (let i = meaningful.length - 1; i >= 0; i--) {
      const line = meaningful[i]!;
      if (line.startsWith("```") || line.startsWith("---") || /^\d+\s*$/.test(line))
        continue;
      const patterns = [
        /^(?:reading|writing|editing|creating|deleting|analyzing|checking|building|running|testing|debugging|searching|finding|extracting|parsing|generating|compiling|installing|updating)/i,
        /^(?:read|write|edit|create|delete|analyze|check|build|run|test|debug|search|find|extract|parse|generate|compile|install|update)\s/i,
        /^(?:working on|processing|handling|managing|organizing|implementing|refactoring|optimizing|fixing|adding|removing)/i,
        /^(?:thinking|planning|considering|evaluating)/i,
      ];
      for (const p of patterns) {
        if (p.test(line))
          return line.length > 60 ? line.slice(0, 57) + "..." : line;
      }
      if (
        line.length > 5 &&
        line.length < 80 &&
        !line.includes("{") &&
        !line.includes("}")
      ) {
        return line.length > 60 ? line.slice(0, 57) + "..." : line;
      }
    }
    const last = meaningful[meaningful.length - 1]!;
    return last.length > 60 ? last.slice(0, 57) + "..." : last;
  }

  completeAgent(key: string, success: boolean) {
    const agent = this.agents.get(key);
    if (agent) {
      agent.status = success ? "complete" : "failed";
      agent.endTime = Date.now();
      this.widgetRenderCallback?.();
      if (!this.hasRunningAgents()) stopSpinner();
    }
  }

  clear() {
    this.agents.clear();
    stopSpinner();
    this.widgetRenderCallback?.();
  }

  hasRunningAgents(): boolean {
    for (const a of this.agents.values())
      if (a.status === "running") return true;
    return false;
  }

  getRunningCount(): number {
    let c = 0;
    for (const a of this.agents.values()) if (a.status === "running") c++;
    return c;
  }

  getAgentTypeIcon(type: AgentState["type"]): string {
    switch (type) {
      case "design":
        return "🎨";
      case "code":
        return "⚡";
      case "fallback":
        return "🔧";
      default:
        return "●";
    }
  }
}

const agentMonitor = new AgentMonitor();

// ─── Utility Functions ────────────────────────────────────────────────────────

function formatElapsedTime(startTime: number, endTime?: number): string {
  const elapsed = Math.floor(((endTime || Date.now()) - startTime) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return minutes > 0
    ? `${minutes}:${seconds.toString().padStart(2, "0")}`
    : `0:${seconds.toString().padStart(2, "0")}`;
}

function formatProviderModel(provider: string, model: string): string {
  const short = model.length > 12 ? model.slice(0, 10) + ".." : model;
  return `${provider}/${short}`;
}

function getStatusIcon(
  status: AgentState["status"],
  theme: Theme
): string {
  switch (status) {
    case "running":
      return theme.fg("accent", getCurrentSpinnerFrame());
    case "complete":
      return theme.fg("success", "✓");
    case "failed":
      return theme.fg("error", "✗");
    case "waiting":
      return theme.fg("dim", "○");
    default:
      return "○";
  }
}

// ─── Dashboard Widget ─────────────────────────────────────────────────────────

class AgentDashboardWidget implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(private monitor: AgentMonitor) {}

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const lines = this.buildLines(width);
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private getTheme(): Theme {
    return (global as any).PI_THEME ||
      ({ fg: (_c: string, s: string) => s, bold: (s: string) => s } as any);
  }

  private padContent(content: string, innerWidth: number, theme: Theme): string {
    return (
      truncateToWidth(content, innerWidth) +
      " ".repeat(Math.max(0, innerWidth - visibleWidth(content))) +
      theme.fg("border", " │")
    );
  }

  private buildLines(width: number): string[] {
    const theme = this.getTheme();
    const agents = Array.from(this.monitor.agents.values());
    if (agents.length === 0) return [];

    const lines: string[] = [];
    const running = this.monitor.getRunningCount();
    const activeColor = running > 0 ? "accent" : "border";

    lines.push(theme.fg(activeColor, "┌" + "─".repeat(width - 2) + "┐"));

    const header = ` Agent Activity ${running > 0 ? `(${running} running)` : ""}`;
    const right = `${agents.length} agents `;
    const mid = " ".repeat(
      Math.max(0, width - 4 - visibleWidth(header) - visibleWidth(right))
    );
    lines.push(
      theme.fg("border", "│") +
        theme.bold(header) +
        mid +
        theme.fg("muted", right) +
        theme.fg("border", "│")
    );

    lines.push(theme.fg("border", "├" + "─".repeat(width - 2) + "┤"));

    const iw = width - 4;

    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i]!;

      const statusIcon = getStatusIcon(agent.status, theme);
      const typeIcon = this.monitor.getAgentTypeIcon(agent.type);
      const name = theme.bold(agent.name);
      const elapsed = theme.fg(
        "dim",
        formatElapsedTime(agent.startTime, agent.endTime)
      );
      const prov = theme.fg(
        "muted",
        formatProviderModel(agent.provider, agent.model)
      );
      const statusLine = ` ${statusIcon} ${typeIcon} ${name} ${prov} ${elapsed}`;
      lines.push(
        theme.fg("border", "│ ") + this.padContent(statusLine, iw, theme)
      );

      const actText = agent.currentActivity || "Working...";
      const actLine = `   ${theme.fg("accent", "→")} ${theme.fg("text", actText)}`;
      lines.push(
        theme.fg("border", "│ ") + this.padContent(actLine, iw, theme)
      );

      const metrics: string[] = [];
      if (agent.linesGenerated > 0) metrics.push(`📄 ${agent.linesGenerated} lines`);
      if (agent.toolsExecuted > 0) metrics.push(`🔧 ${agent.toolsExecuted} tools`);
      if (agent.filesModified.size > 0) metrics.push(`📁 ${agent.filesModified.size} files`);

      if (metrics.length > 0) {
        const mLine = `   ${theme.fg("muted", metrics.join("  •  "))}`;
        lines.push(
          theme.fg("border", "│ ") + this.padContent(mLine, iw, theme)
        );
      }

      if (i < agents.length - 1) {
        lines.push(
          theme.fg(
            "border",
            "│" + theme.fg("dim", "─".repeat(width - 2)) + "│"
          )
        );
      }
    }

    lines.push(theme.fg(activeColor, "└" + "─".repeat(width - 2) + "┘"));
    return lines;
  }
}

// ─── Full Dashboard Overlay ──────────────────────────────────────────────────

class FullDashboardOverlay implements Component {
  private scrollOffset = 0;
  private selectedIndex = 0;
  private agentKeys: string[] = [];
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private monitor: AgentMonitor,
    private theme: Theme,
    private onClose: () => void,
    private tui: TUI
  ) {
    this.updateAgentKeys();
  }

  private updateAgentKeys() {
    this.agentKeys = Array.from(this.monitor.agents.keys());
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q") {
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.adjustScroll();
      this.invalidate();
      this.tui.requestRender();
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(
        this.agentKeys.length - 1,
        this.selectedIndex + 1
      );
      this.adjustScroll();
      this.invalidate();
      this.tui.requestRender();
    } else if (matchesKey(data, Key.home)) {
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      this.invalidate();
      this.tui.requestRender();
    } else if (matchesKey(data, Key.end)) {
      this.selectedIndex = this.agentKeys.length - 1;
      this.invalidate();
      this.tui.requestRender();
    }
  }

  private adjustScroll() {
    const visibleHeight = 20;
    if (this.selectedIndex < this.scrollOffset)
      this.scrollOffset = this.selectedIndex;
    else if (this.selectedIndex >= this.scrollOffset + visibleHeight)
      this.scrollOffset = this.selectedIndex - visibleHeight + 1;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    this.updateAgentKeys();
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const lines = this.buildDashboard(width);
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private buildDashboard(width: number): string[] {
    const lines: string[] = [];
    const th = this.theme;
    const running = this.monitor.getRunningCount();

    lines.push(th.fg("border", "┌" + "─".repeat(width - 2) + "┐"));

    const title = " Agent Dashboard ";
    const sub = running > 0 ? ` ${running} running ` : " idle ";
    const titleLine =
      title +
      " ".repeat(
        Math.max(0, width - 4 - visibleWidth(title) - visibleWidth(sub))
      ) +
      sub;
    lines.push(
      th.fg("border", "│") +
        th.fg("accent", th.bold(titleLine)) +
        th.fg("border", "│")
    );
    lines.push(th.fg("border", "├" + "═".repeat(width - 2) + "┤"));

    if (this.agentKeys.length === 0) {
      const msg = " No agents active ";
      const pad = " ".repeat(Math.max(0, width - 4 - visibleWidth(msg)));
      lines.push(
        th.fg("border", "│") + th.fg("dim", msg) + pad + th.fg("border", "│")
      );
    } else {
      for (let i = 0; i < this.agentKeys.length; i++) {
        const key = this.agentKeys[i]!;
        const agent = this.monitor.agents.get(key)!;
        const selected = i === this.selectedIndex;

        const statusIcon = getStatusIcon(agent.status, th);
        const typeIcon = this.monitor.getAgentTypeIcon(agent.type);
        const name = selected
          ? th.fg("accent", th.bold(agent.name))
          : th.bold(agent.name);
        const elapsed = formatElapsedTime(agent.startTime, agent.endTime);
        const prov = formatProviderModel(agent.provider, agent.model);

        const cardLines = [
          `${statusIcon} ${typeIcon} ${name}`,
          `   ${th.fg("accent", "→")} ${agent.currentActivity || "Working..."}`,
          `   ${th.fg("muted", `${prov} • ${elapsed}`)}`,
        ];

        const metrics: string[] = [];
        if (agent.linesGenerated > 0)
          metrics.push(`📄 ${agent.linesGenerated} lines`);
        if (agent.toolsExecuted > 0)
          metrics.push(`🔧 ${agent.toolsExecuted} tools`);
        if (agent.filesModified.size > 0)
          metrics.push(`📁 ${agent.filesModified.size} files`);
        if (metrics.length > 0)
          cardLines.push(`   ${th.fg("muted", metrics.join("  •  "))}`);

        for (const line of cardLines) {
          const prefix = selected ? " " : " ";
          const padding = " ".repeat(
            Math.max(0, width - 4 - visibleWidth(line))
          );
          lines.push(
            th.fg("border", "│") + prefix + line + padding + " " + th.fg("border", "│")
          );
        }

        if (i < this.agentKeys.length - 1) {
          lines.push(
            th.fg(
              "border",
              "├" + th.fg("dim", "─".repeat(width - 2)) + "┤"
            )
          );
        }
      }
    }

    lines.push(th.fg("border", "├" + "─".repeat(width - 2) + "┤"));
    const help = " ↑↓ navigate • q/esc close ";
    const helpPad = " ".repeat(Math.max(0, width - 4 - visibleWidth(help)));
    lines.push(
      th.fg("border", "│") + th.fg("dim", help) + helpPad + th.fg("border", "│")
    );
    lines.push(th.fg("border", "└" + "─".repeat(width - 2) + "┘"));
    return lines;
  }
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

let widgetHandle:
  | { close: () => void; requestRender: () => void }
  | undefined;
const widgetComponent = new AgentDashboardWidget(agentMonitor);

function updateWidget(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  if (!widgetHandle) {
    widgetHandle = ctx.ui.setWidget(
      "agent-monitor",
      (_tui: any, theme: any) => {
        (global as any).PI_THEME = theme;
        return widgetComponent;
      },
      { placement: "aboveEditor" }
    ) as any;
  } else {
    widgetComponent.invalidate();
    widgetHandle.requestRender();
  }
}

function clearWidget(ctx: ExtensionContext, delay = 5000) {
  setTimeout(() => {
    if (widgetHandle) {
      widgetHandle.close();
      widgetHandle = undefined;
    }
  }, delay);
}

// ─── Process Runners ──────────────────────────────────────────────────────────

async function runPiAgent(
  provider: string,
  model: string,
  prompt: string,
  cwd: string,
  ctx: ExtensionContext,
  agentKey: string,
  agentName: string,
  agentType: AgentState["type"]
): Promise<string> {
  return new Promise((resolve, reject) => {
    agentMonitor.startAgent(agentKey, agentName, provider, model, agentType);
    updateWidget(ctx);

    const proc = spawn(
      "pi",
      ["-ne", "--provider", provider, "--model", model, "-p", prompt],
      {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PI_SUBAGENT: "1" },
      }
    );

    let output = "";
    let stderrOutput = "";

    proc.stdout.on("data", (data: Buffer) => {
      output += data.toString();
      agentMonitor.updateAgent(agentKey, output);
      updateWidget(ctx);
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderrOutput += data.toString();
    });

    proc.on("close", (code) => {
      agentMonitor.completeAgent(agentKey, code === 0);
      updateWidget(ctx);
      if (!agentMonitor.hasRunningAgents()) clearWidget(ctx, 10000);
      if (code === 0) resolve(output || "(no output)");
      else
        reject(
          new Error(
            `Pi agent exited with code ${code}. stderr: ${stderrOutput}`
          )
        );
    });
    proc.on("error", (err) => {
      agentMonitor.completeAgent(agentKey, false);
      updateWidget(ctx);
      reject(err);
    });
  });
}

async function runClaude(
  prompt: string,
  cwd: string,
  ctx: ExtensionContext
): Promise<string> {
  return new Promise((resolve, reject) => {
    agentMonitor.startAgent(
      "claude-design",
      "Claude Design",
      "anthropic",
      "claude-opus-4",
      "design"
    );
    updateWidget(ctx);

    const args = [
      "-p",
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--verbose",
    ];
    const proc = spawn("claude", [...args, prompt], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

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
              agentMonitor.updateAgent("claude-design", output);
              updateWidget(ctx);
            }
          } else if (event.type === "result" && event.result) {
            output = event.result;
          }
        } catch {}
      }
    });

    proc.on("close", (code) => {
      agentMonitor.completeAgent("claude-design", code === 0);
      updateWidget(ctx);
      clearWidget(ctx);
      if (code === 0) resolve(output || "(no output)");
      else reject(new Error(`Claude exited with code ${code}`));
    });
    proc.on("error", (err) => {
      agentMonitor.completeAgent("claude-design", false);
      updateWidget(ctx);
      reject(err);
    });
  });
}

async function runOpencode(
  prompt: string,
  cwd: string,
  ctx: ExtensionContext
): Promise<string> {
  return new Promise((resolve, reject) => {
    agentMonitor.startAgent(
      "glm-code",
      "GLM Code",
      "zai",
      "glm-5",
      "code"
    );
    updateWidget(ctx);

    const args = ["run", "--format", "json", "-m", "zai-coding-plan/glm-5", prompt];
    const proc = spawn("opencode", args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

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
            agentMonitor.updateAgent("glm-code", output);
            updateWidget(ctx);
          }
        } catch {}
      }
    });

    proc.on("close", (code) => {
      agentMonitor.completeAgent("glm-code", code === 0);
      updateWidget(ctx);
      clearWidget(ctx);
      if (code === 0) resolve(output || "(no output)");
      else reject(new Error(`OpenCode exited with code ${code}`));
    });
    proc.on("error", (err) => {
      agentMonitor.completeAgent("glm-code", false);
      updateWidget(ctx);
      reject(err);
    });
  });
}

async function runPiFallback(
  prompt: string,
  cwd: string,
  ctx: ExtensionContext
): Promise<string> {
  return new Promise((resolve, reject) => {
    agentMonitor.startAgent(
      "pi-fallback",
      "Pi Fallback",
      "kimi-coding",
      "k2p5",
      "fallback"
    );
    updateWidget(ctx);

    const args = ["--provider", "kimi-coding", "-p", prompt];
    const proc = spawn("pi", args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PI_SUBAGENT: "1" },
    });

    let output = "";

    proc.stdout.on("data", (data: Buffer) => {
      output += data.toString();
      agentMonitor.updateAgent("pi-fallback", output);
      updateWidget(ctx);
    });

    proc.on("close", (code) => {
      agentMonitor.completeAgent("pi-fallback", code === 0);
      updateWidget(ctx);
      clearWidget(ctx);
      if (code === 0) resolve(output || "(no output)");
      else reject(new Error(`Pi fallback exited with code ${code}`));
    });
    proc.on("error", (err) => {
      agentMonitor.completeAgent("pi-fallback", false);
      updateWidget(ctx);
      reject(err);
    });
  });
}

// ─── Usage Fetching ───────────────────────────────────────────────────────────

interface UsageLimits {
  fiveHour: { utilization: number; resetsAt: string };
  weekly: { utilization: number; resetsAt: string };
}

const CLAUDE_CREDENTIALS_PATH = path.join(
  process.env.HOME || "",
  ".claude/.credentials.json"
);
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

async function getClaudeAccessToken(): Promise<string | null> {
  try {
    if (!fs.existsSync(CLAUDE_CREDENTIALS_PATH)) return null;
    const creds = JSON.parse(
      fs.readFileSync(CLAUDE_CREDENTIALS_PATH, "utf-8")
    );
    let token = creds.claudeAiOauth?.accessToken;
    const expiresAt = creds.claudeAiOauth?.expiresAt || 0;

    if (expiresAt > 0 && expiresAt <= Date.now()) {
      const refreshToken = creds.claudeAiOauth?.refreshToken;
      if (!refreshToken) return null;

      const response = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: CLAUDE_OAUTH_CLIENT_ID,
        }),
      });

      if (!response.ok) return null;
      const data = await response.json();
      token = data.access_token;
      creds.claudeAiOauth.accessToken = token;
      creds.claudeAiOauth.expiresAt =
        Date.now() + (data.expires_in || 3600) * 1000;
      fs.writeFileSync(
        CLAUDE_CREDENTIALS_PATH,
        JSON.stringify(creds, null, 2)
      );
    }
    return token || null;
  } catch {
    return null;
  }
}

async function fetchClaudeUsage(): Promise<UsageLimits | null> {
  try {
    const token = await getClaudeAccessToken();
    if (!token) return null;

    const response = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": CLAUDE_OAUTH_BETA,
      },
    });
    if (!response.ok) return null;

    const data = await response.json();
    return {
      fiveHour: {
        utilization: data.five_hour?.utilization || 0,
        resetsAt: data.five_hour?.resets_at || "",
      },
      weekly: {
        utilization: data.seven_day?.utilization || 0,
        resetsAt: data.seven_day?.resets_at || "",
      },
    };
  } catch {
    return null;
  }
}

async function fetchGlmUsage(): Promise<UsageLimits | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ssh",
      [
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "ConnectTimeout=5",
        "dietpi@192.168.178.70",
        "cat /opt/kimi-monitor/data/usage.json",
      ],
      { shell: false, stdio: ["ignore", "pipe", "pipe"] }
    );
    let output = "";
    proc.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });

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
          fiveHour: {
            utilization: glm["5h"]?.used || 0,
            resetsAt: glm["5h"]?.reset || "",
          },
          weekly: {
            utilization: glm.weekly?.used || 0,
            resetsAt: glm.weekly?.reset || "",
          },
        });
      } catch {
        resolve(null);
      }
    });
    proc.on("error", () => resolve(null));
  });
}

// ─── Mode Management ──────────────────────────────────────────────────────────

function loadStoredMode(): OrchestratorMode | null {
  try {
    if (fs.existsSync(MODE_FILE)) {
      const mode = fs.readFileSync(MODE_FILE, "utf-8").trim();
      if (mode === "pi-only" || mode === "cross-harness") return mode;
    }
  } catch {}
  return null;
}

function saveMode(mode: OrchestratorMode): void {
  try {
    fs.writeFileSync(MODE_FILE, mode);
  } catch {}
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function multiAgentOrchestrator(pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT === "1") return;

  const extensionDir =
    (pi as any).extensionDir || EXTENSION_DIR;
  let currentMode: OrchestratorMode = loadStoredMode() || "pi-only";
  const agentsConfig = loadAgentsConfig(extensionDir);

  function buildPiPrompt(
    role: "design" | "code",
    task: string,
    agentMd: string
  ): string {
    const agentCfg = agentsConfig.agents[role];
    const agentFile = `AGENT-${role}.md`;
    return `${agentCfg.promptPrefix}

${agentsConfig.shared.agientContext}

${agentMd ? `Context from AGENT.md:\n${agentMd}\n\n---\n\n` : ""}Task: ${task}

Read AGENT.md before starting.
${TEST_LINT_SUFFIX}
When done, write your results to ${agentFile}. Last line: \`_Updated: <ISO datetime>_\``;
  }

  function buildCrossDesignPrompt(task: string, agentMd: string): string {
    return `${AGENT_CONTEXT}

${FRONTEND_DESIGN_SKILL}

---

${agentMd ? `Context from AGENT.md:\n${agentMd}\n\n---\n\n` : ""}

Task: ${task}

Read AGENT.md first, then complete the task.

When done, update AGENT.md with what you designed.`;
  }

  function buildCrossCodePrompt(
    task: string,
    agentMd: string,
    files?: string
  ): string {
    return `${AGENT_CONTEXT}

${agentMd ? `Context from AGENT.md:\n${agentMd}\n\n---\n\n` : ""}

Task: ${task}${files ? `\n\nFiles: ${files}` : ""}

Read AGENT.md first, then complete the task.

Rules:
- Do NOT touch any UI/TUI/frontend code. Focus on backend/logic only.
${TEST_LINT_SUFFIX}
When done, update AGENT.md with what you implemented.`;
  }

  async function runDesign(
    task: string,
    cwd: string,
    ctx: ExtensionContext
  ): Promise<string> {
    let agentMd = "";
    const agentMdPath = path.join(cwd, "AGENT.md");
    if (fs.existsSync(agentMdPath))
      agentMd = fs.readFileSync(agentMdPath, "utf-8");

    if (currentMode === "cross-harness") {
      const prompt = buildCrossDesignPrompt(task, agentMd);
      ctx.ui.notify("Running Claude for design...", "info");
      try {
        const result = await runClaude(prompt, cwd, ctx);
        ctx.ui.notify("Design complete", "success");
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(
          `Claude failed: ${msg}. Falling back to pi...`,
          "warning"
        );
        return runPiFallback(prompt, cwd, ctx);
      }
    } else {
      const prompt = buildPiPrompt("design", task, agentMd);
      const agentCfg = agentsConfig.agents.design;
      try {
        return await runPiAgent(
          agentCfg.provider,
          agentCfg.model,
          prompt,
          cwd,
          ctx,
          "pi-design",
          agentCfg.name,
          "design"
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(
          `${agentCfg.name} failed: ${msg}. Falling back...`,
          "warning"
        );
        const fb = agentsConfig.fallbacks.design;
        return runPiAgent(
          fb.provider,
          fb.model,
          prompt,
          cwd,
          ctx,
          "pi-design-fb",
          `${agentCfg.name} (Fallback)`,
          "fallback"
        );
      }
    }
  }

  async function runCode(
    task: string,
    cwd: string,
    ctx: ExtensionContext
  ): Promise<string> {
    let agentMd = "";
    const agentMdPath = path.join(cwd, "AGENT.md");
    if (fs.existsSync(agentMdPath))
      agentMd = fs.readFileSync(agentMdPath, "utf-8");

    if (currentMode === "cross-harness") {
      const prompt = buildCrossCodePrompt(task, agentMd);
      ctx.ui.notify("Running GLM for coding...", "info");
      try {
        const result = await runOpencode(prompt, cwd, ctx);
        ctx.ui.notify("Coding complete", "success");
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(
          `GLM failed: ${msg}. Falling back to pi...`,
          "warning"
        );
        return runPiFallback(prompt, cwd, ctx);
      }
    } else {
      const prompt = buildPiPrompt("code", task, agentMd);
      const agentCfg = agentsConfig.agents.code;
      try {
        return await runPiAgent(
          agentCfg.provider,
          agentCfg.model,
          prompt,
          cwd,
          ctx,
          "pi-code",
          agentCfg.name,
          "code"
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(
          `${agentCfg.name} failed: ${msg}. Falling back...`,
          "warning"
        );
        const fb = agentsConfig.fallbacks.code;
        return runPiAgent(
          fb.provider,
          fb.model,
          prompt,
          cwd,
          ctx,
          "pi-code-fb",
          `${agentCfg.name} (Fallback)`,
          "fallback"
        );
      }
    }
  }

  async function updateUsageFooter(ctx: ExtensionContext) {
    if (currentMode !== "cross-harness") return;
    const [claude, glm] = await Promise.all([
      fetchClaudeUsage(),
      fetchGlmUsage(),
    ]);
    const c5 = claude ? Math.round(claude.fiveHour.utilization) : "?";
    const cw = claude ? Math.round(claude.weekly.utilization) : "?";
    const g5 = glm ? Math.round(glm.fiveHour.utilization) : "?";
    const gw = glm ? Math.round(glm.weekly.utilization) : "?";
    ctx.ui.setStatus(
      "spi-usage",
      `\x1b[2mC:${c5}%/${cw}% G:${g5}%/${gw}%\x1b[0m`
    );
  }

  function modeLabel(): string {
    return currentMode === "cross-harness"
      ? "Cross-harness (Claude + GLM)"
      : "Pi-only (configurable)";
  }

  function currentAgentInfo(): string {
    if (currentMode === "cross-harness") {
      return `Design: Claude Opus → pi fallback, Code: GLM-5 → pi fallback`;
    }
    const d = agentsConfig.agents.design;
    const c = agentsConfig.agents.code;
    return `Design: ${d.provider}/${d.model} → ${agentsConfig.fallbacks.design.provider}/${agentsConfig.fallbacks.design.model}, Code: ${c.provider}/${c.model} → ${agentsConfig.fallbacks.code.provider}/${agentsConfig.fallbacks.code.model}`;
  }

  // ── Delegate Tool ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description:
      "Delegate work to specialist agents. Set 'design' for UI/visual work, 'code' for backend/logic. Provide BOTH fields to run them in parallel. After code tasks, the orchestrator must run tests and linter to verify.",
    promptSnippet:
      "design: UI/TUI/CSS/React. code: backend/logic. Both fields = run in parallel. Always verify code with tests/linter after delegation.",
    promptGuidelines: [
      "design: visual interfaces, UI components, TUI, HTML/CSS, React, styling",
      "code: backend logic, algorithms, implementation, debugging, scripts",
      "Provide BOTH fields to run design and code agents simultaneously.",
      "After code delegation returns, ALWAYS run the project's test suite and linter/type-checker.",
      "If tests or linter fail, delegate again with the full error output to fix them. Repeat until clean.",
      "Include test commands and lint commands in AGENT.md when known (check package.json, Makefile, pyproject.toml, etc.).",
    ],
    parameters: Type.Object({
      design: Type.Optional(
        Type.String({
          description:
            "UI/visual task: interfaces, TUI, HTML/CSS, React, styling",
        })
      ),
      code: Type.Optional(
        Type.String({
          description:
            "Code task: backend logic, algorithms, implementation, debugging",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { design, code } = params as {
        design?: string;
        code?: string;
      };
      const cwd = process.cwd();

      const tasks: Promise<{ role: string; result: string }>[] = [];
      if (design) {
        tasks.push(
          runDesign(design, cwd, ctx).then((result) => ({
            role: "design",
            result,
          }))
        );
      }
      if (code) {
        tasks.push(
          runCode(code, cwd, ctx).then((result) => ({
            role: "code",
            result,
          }))
        );
      }

      if (tasks.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No tasks provided. Use 'design', 'code', or both fields.",
            },
          ],
        };
      }

      const label =
        tasks.length > 1
          ? "both agents in parallel"
          : design
            ? "Design agent"
            : "Code agent";
      ctx.ui.notify(`Running ${label}...`, "info");

      const results = await Promise.all(tasks);
      ctx.ui.notify(
        `${tasks.length > 1 ? "Both agents" : "Agent"} complete`,
        "success"
      );

      const combined = results
        .map((r) => `### ${r.role}\n${r.result}`)
        .join("\n\n---\n\n");
      return { content: [{ type: "text", text: combined }] };
    },
  });

  // ── System Prompt Injection ──────────────────────────────────────────────────

  pi.on("before_agent_start", async (event) => {
    const addendum = agentsConfig.orchestrator?.systemPromptAddendum || "";
    const customSpi =
      agentsConfig.shared.spiSystemPrompt || ORCHESTRATOR_SYSTEM_PROMPT;
    const now = new Date();
    const dateStr = now.toLocaleString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
    const cwd = process.cwd();

    const newPrompt =
      customSpi +
      addendum +
      `\n\nCurrent date: ${dateStr}\nCurrent working directory: ${cwd}` +
      `\nOrchestrator mode: ${modeLabel()}`;

    return {
      systemPrompt:
        event.systemPrompt + "\n\n" + ORCHESTRATOR_SYSTEM_PROMPT + newPrompt,
      message: {
        customType: "delegate-reminder",
        content:
          "Consider using the `delegate` tool if this involves coding or design work. After code delegation, run tests and linter.",
        display: false,
      },
    };
  });

  // ── Commands ─────────────────────────────────────────────────────────────────

  pi.registerCommand("agents", {
    description: "Show configured agents, mode, and providers/models",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const lines = [
        "\x1b[1mMulti-Agent Orchestrator\x1b[0m",
        "",
        `\x1b[1mMode:\x1b[0m ${modeLabel()}`,
        "",
        currentMode === "cross-harness"
          ? [
              `\x1b[1mDesign:\x1b[0m Claude Opus → pi fallback (kimi-coding/k2p5)`,
              `\x1b[1mCode:\x1b[0m GLM-5 (opencode) → pi fallback (kimi-coding/k2p5)`,
            ].join("\n")
          : [
              `\x1b[1mDesign:\x1b[0m ${agentsConfig.agents.design.provider}/${agentsConfig.agents.design.model}`,
              `  Fallback: ${agentsConfig.fallbacks.design.provider}/${agentsConfig.fallbacks.design.model}`,
              ``,
              `\x1b[1mCode:\x1b[0m ${agentsConfig.agents.code.provider}/${agentsConfig.agents.code.model}`,
              `  Fallback: ${agentsConfig.fallbacks.code.provider}/${agentsConfig.fallbacks.code.model}`,
            ].join("\n"),
        "",
        `\x1b[2mConfig: ${path.join(extensionDir, "agents.json")}\x1b[0m`,
        `\x1b[2mMode file: ${MODE_FILE}\x1b[0m`,
        "",
        `\x1b[2mUse /orchestrator-mode to switch modes\x1b[0m`,
      ];
      return lines.join("\n");
    },
  });

  pi.registerCommand("orchestrator-mode", {
    description: "Switch orchestrator mode: pi-only or cross-harness",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        return "Mode switching requires interactive UI";
      }

      const choice = await ctx.ui.select(
        "Choose orchestrator mode:",
        [
          "pi-only (configurable providers per agent)",
          "cross-harness (Claude + GLM via separate CLIs)",
        ]
      );

      if (!choice) {
        ctx.ui.notify("Mode selection cancelled", "info");
        return;
      }

      currentMode = choice.startsWith("pi-only") ? "pi-only" : "cross-harness";
      saveMode(currentMode);
      ctx.ui.notify(`Orchestrator mode: ${modeLabel()}`, "success");
    },
  });

  pi.registerCommand("agents-dashboard", {
    description: "Show full agent activity dashboard overlay",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        return "Dashboard requires interactive UI mode";
      }

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        const dashboard = new FullDashboardOverlay(
          agentMonitor,
          theme,
          done,
          tui
        );
        return {
          render: (w: number) => dashboard.render(w),
          handleInput: (data: string) => dashboard.handleInput(data),
          invalidate: () => dashboard.invalidate(),
        };
      }, { overlay: true });
    },
  });

  pi.registerCommand("reload-agents", {
    description: "Reload agents.json configuration",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const newConfig = loadAgentsConfig(extensionDir);
      Object.assign(agentsConfig, newConfig);
      ctx.ui.notify("Agents configuration reloaded", "success");
      return `Configuration reloaded from ${path.join(extensionDir, "agents.json")}`;
    },
  });

  // ── Session Start ────────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    agentMonitor.setWidgetRenderCallback(() => {
      widgetComponent.invalidate();
      widgetHandle?.requestRender();
    });

    const storedMode = loadStoredMode();
    if (storedMode) {
      currentMode = storedMode;
    }

    ctx.ui.notify(
      `Multi-Agent Orchestrator [${modeLabel()}]. ${currentAgentInfo()}. /orchestrator-mode to switch.`,
      "info"
    );

    if (currentMode === "cross-harness") {
      updateUsageFooter(ctx);
      setInterval(() => updateUsageFooter(ctx), 60000);
    }
  });
}
