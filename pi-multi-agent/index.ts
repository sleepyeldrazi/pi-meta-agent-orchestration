import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, Key, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type { TUI, Component } from "@mariozechner/pi-tui";

// ─── Configuration Loading ───────────────────────────────────────────────────

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
  orchestrator?: {
    systemPromptAddendum?: string;
  };
  agents: {
    design: AgentConfig;
    code: AgentConfig;
  };
  fallbacks: {
    design: FallbackConfig;
    code: FallbackConfig;
  };
  shared: {
    agientContext: string;
    spiSystemPrompt: string;
  };
}

function loadAgentsConfig(extensionDir: string): AgentsJson {
  const configPath = path.join(extensionDir, "agents.json");
  const defaultConfig: AgentsJson = {
    orchestrator: {},
    agents: {
      design: {
        name: "Designer",
        description: "Visual interfaces, UI components",
        provider: "claude-opus-4",
        model: "claude-opus-4-20250514",
        promptPrefix: "You are a frontend design specialist."
      },
      code: {
        name: "Coder",
        description: "Backend logic, algorithms",
        provider: "kimi-coding",
        model: "k2p5",
        promptPrefix: "You are a coding specialist."
      }
    },
    fallbacks: {
      design: { provider: "kimi-coding", model: "k2p5" },
      code: { provider: "gemini-coding", model: "gemini-2.5-pro" }
    },
    shared: {
      agientContext: "\n## Context\n\nRead AGENT.md before starting.",
      spiSystemPrompt: "\n## Specialist Tools\n\nYou have code and design tools."
    }
  };

  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(content);
      return {
        orchestrator: { ...defaultConfig.orchestrator, ...parsed.orchestrator },
        agents: {
          design: { ...defaultConfig.agents.design, ...parsed.agents?.design },
          code: { ...defaultConfig.agents.code, ...parsed.agents?.code }
        },
        fallbacks: {
          design: { ...defaultConfig.fallbacks.design, ...parsed.fallbacks?.design },
          code: { ...defaultConfig.fallbacks.code, ...parsed.fallbacks?.code }
        },
        shared: { ...defaultConfig.shared, ...parsed.shared }
      };
    }
  } catch (err) {
    console.error("[pi-multi-agent] Error loading agents.json:", err);
  }

  return defaultConfig;
}

// ─── Braille Spinner Animation ───────────────────────────────────────────────

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

// ─── Agent Monitor State ─────────────────────────────────────────────────────

interface AgentState {
  name: string;
  status: "running" | "complete" | "failed" | "waiting";
  output?: string;
  startTime: number;
  endTime?: number;
  provider: string;
  model: string;
  type: "design" | "code" | "fallback";
  // Meaningful metrics extracted from output
  linesGenerated: number;
  toolsExecuted: number;
  filesModified: Set<string>;
  currentActivity: string;
  outputSize: number;
}

class AgentMonitor {
  agents = new Map<string, AgentState>();
  private widgetRenderCallback?: () => void;

  setWidgetRenderCallback(callback: () => void) {
    this.widgetRenderCallback = callback;
  }

  startAgent(key: string, name: string, provider: string, model: string, type: AgentState["type"]) {
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
      outputSize: 0
    });
    this.startSpinnerIfNeeded();
    this.widgetRenderCallback?.();
  }

  updateAgent(key: string, output: string) {
    const agent = this.agents.get(key);
    if (agent) {
      agent.output = output;
      agent.outputSize = Buffer.byteLength(output, 'utf-8');
      
      // Parse metrics from output
      const lines = output.split('\n');
      agent.linesGenerated = lines.length;
      
      // Count tool executions by looking for tool call patterns
      // Patterns like "read:", "write:", "edit:", "bash:" at start of lines
      const toolPatterns = /^(read|write|edit|bash):/i;
      agent.toolsExecuted = lines.filter(line => toolPatterns.test(line.trim())).length;
      
      // Extract file paths from tool calls
      // Common patterns: "read: /path/to/file", "write: /path/to/file", "edit: /path/to/file"
      const filePattern = /^(?:read|write|edit):\s*(\S+)/i;
      for (const line of lines) {
        const match = filePattern.exec(line.trim());
        if (match && match[1]) {
          // Extract the file path and normalize it
          const filePath = match[1].replace(/["']/g, '').trim();
          if (filePath && !filePath.startsWith('-') && !filePath.startsWith('--')) {
            agent.filesModified.add(filePath);
          }
        }
      }
      
      // Extract current activity from the last meaningful line
      // Look for the last non-empty line that looks like an action
      const activityLine = this.extractCurrentActivity(lines);
      if (activityLine) {
        agent.currentActivity = activityLine;
      }
      
      this.widgetRenderCallback?.();
    }
  }

  /**
   * Extract the current activity from the output lines.
   * Looks for the last non-empty line that appears to be an action.
   */
  private extractCurrentActivity(lines: string[]): string | null {
    // Filter for meaningful lines (non-empty, not just whitespace)
    const meaningfulLines = lines
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .filter(l => !l.match(/^\s*$/)); // Skip empty/whitespace only
    
    if (meaningfulLines.length === 0) return null;
    
    // Start from the end and work backwards to find an action-like line
    for (let i = meaningfulLines.length - 1; i >= 0; i--) {
      const line = meaningfulLines[i]!;
      
      // Skip lines that are clearly not activities
      if (line.startsWith('```')) continue;
      if (line.startsWith('---')) continue;
      if (line.match(/^\d+\s*$/)) continue; // Just numbers
      
      // Look for action-like patterns
      const actionPatterns = [
        /^(?:reading|writing|editing|creating|deleting|analyzing|checking|building|running|testing|debugging|searching|finding|extracting|parsing|generating|compiling|installing|updating)/i,
        /^(?:read|write|edit|create|delete|analyze|check|build|run|test|debug|search|find|extract|parse|generate|compile|install|update)\s/i,
        /^(?:working on|processing|handling|managing|organizing|implementing|refactoring|optimizing|fixing|adding|removing)/i,
        /^(?:thinking|planning|considering|evaluating)/i
      ];
      
      for (const pattern of actionPatterns) {
        if (pattern.test(line)) {
          // Truncate if too long
          return line.length > 60 ? line.slice(0, 57) + '...' : line;
        }
      }
      
      // If no pattern matches but line looks substantial, use it as fallback
      // but only if it's reasonably short (not a code block or data dump)
      if (line.length > 5 && line.length < 80 && !line.includes('{') && !line.includes('}')) {
        return line.length > 60 ? line.slice(0, 57) + '...' : line;
      }
    }
    
    // Fallback: return the last meaningful line, truncated
    const lastLine = meaningfulLines[meaningfulLines.length - 1]!;
    return lastLine.length > 60 ? lastLine.slice(0, 57) + '...' : lastLine;
  }

  completeAgent(key: string, success: boolean) {
    const agent = this.agents.get(key);
    if (agent) {
      agent.status = success ? "complete" : "failed";
      agent.endTime = Date.now();
      this.widgetRenderCallback?.();
      if (!this.hasRunningAgents()) {
        stopSpinner();
      }
    }
  }

  clear() {
    this.agents.clear();
    stopSpinner();
    this.widgetRenderCallback?.();
  }

  hasRunningAgents(): boolean {
    for (const agent of this.agents.values()) {
      if (agent.status === "running") return true;
    }
    return false;
  }

  getRunningCount(): number {
    let count = 0;
    for (const agent of this.agents.values()) {
      if (agent.status === "running") count++;
    }
    return count;
  }

  getAgentTypeIcon(type: AgentState["type"]): string {
    switch (type) {
      case "design": return "🎨";
      case "code": return "⚡";
      case "fallback": return "🔧";
      default: return "●";
    }
  }

  private startSpinnerIfNeeded() {
    if (this.hasRunningAgents()) {
      startSpinner(() => this.widgetRenderCallback?.());
    }
  }
}

const agentMonitor = new AgentMonitor();

// ─── Utility Functions ───────────────────────────────────────────────────────

function formatElapsedTime(startTime: number, endTime?: number): string {
  const elapsed = Math.floor(((endTime || Date.now()) - startTime) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  if (minutes > 0) {
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }
  return `0:${seconds.toString().padStart(2, "0")}`;
}

function formatProviderModel(provider: string, model: string): string {
  const shortModel = model.length > 12 ? model.slice(0, 10) + ".." : model;
  return `${provider}/${shortModel}`;
}

function getStatusIcon(status: AgentState["status"], theme: Theme): string {
  switch (status) {
    case "running": return theme.fg("accent", getCurrentSpinnerFrame());
    case "complete": return theme.fg("success", "✓");
    case "failed": return theme.fg("error", "✗");
    case "waiting": return theme.fg("dim", "○");
    default: return "○";
  }
}

function getStatusBorderColor(status: AgentState["status"]): "accent" | "success" | "error" | "dim" {
  switch (status) {
    case "running": return "accent";
    case "complete": return "success";
    case "failed": return "error";
    case "waiting": return "dim";
    default: return "dim";
  }
}

function createProgressBar(progress: number, width: number): string {
  const filled = Math.round((progress / 100) * width);
  const empty = width - filled;
  return "━".repeat(filled) + "░".repeat(empty);
}

// ─── Dashboard Widget Component ───────────────────────────────────────────────

class AgentDashboardWidget implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(private monitor: AgentMonitor) {}

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines = this.buildWidgetLines(width);
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private buildWidgetLines(width: number): string[] {
    const theme = this.getTheme();
    const agents = Array.from(this.monitor.agents.values());
    
    if (agents.length === 0) {
      return [];
    }

    const lines: string[] = [];
    const runningCount = this.monitor.getRunningCount();
    const totalCount = agents.length;
    
    // Header with box-drawing characters
    const headerText = ` Agent Activity ${runningCount > 0 ? `(${runningCount} running)` : ""}`;
    const headerRight = totalCount > 0 ? `${totalCount} agents ` : "";
    
    lines.push(this.renderTopBorder(width, theme, runningCount > 0));
    lines.push(this.renderHeaderLine(headerText, headerRight, width, theme));
    lines.push(this.renderSeparator(width, theme));

    // Agent cards
    for (const agent of agents) {
      const cardLines = this.renderAgentCard(agent, width, theme);
      lines.push(...cardLines);
      if (agents.indexOf(agent) < agents.length - 1) {
        lines.push(this.renderThinSeparator(width, theme));
      }
    }

    lines.push(this.renderBottomBorder(width, theme, runningCount > 0));
    return lines;
  }

  private renderTopBorder(width: number, theme: Theme, isActive: boolean): string {
    const color = isActive ? "accent" : "border";
    const borderColor = theme.fg(color, "┌" + "─".repeat(width - 2) + "┐");
    return borderColor;
  }

  private renderBottomBorder(width: number, theme: Theme, isActive: boolean): string {
    const color = isActive ? "accent" : "border";
    const borderColor = theme.fg(color, "└" + "─".repeat(width - 2) + "┘");
    return borderColor;
  }

  private renderSeparator(width: number, theme: Theme): string {
    return theme.fg("border", "├" + "─".repeat(width - 2) + "┤");
  }

  private renderThinSeparator(width: number, theme: Theme): string {
    return theme.fg("border", "│" + theme.fg("dim", "─".repeat(width - 2)) + theme.fg("border", "│"));
  }

  private renderHeaderLine(left: string, right: string, width: number, theme: Theme): string {
    const leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(right);
    const middleWidth = width - 2 - leftWidth - rightWidth;
    const middle = " ".repeat(Math.max(0, middleWidth));
    return theme.fg("border", "│") + theme.bold(left) + middle + theme.fg("muted", right) + theme.fg("border", "│");
  }

  private renderAgentCard(agent: AgentState, width: number, theme: Theme): string[] {
    const lines: string[] = [];
    const innerWidth = width - 4; // Account for │ and padding
    
    // Status line with icon, name, and metadata
    const statusIcon = getStatusIcon(agent.status, theme);
    const typeIcon = this.monitor.getAgentTypeIcon(agent.type);
    const name = theme.bold(agent.name);
    const elapsed = theme.fg("dim", formatElapsedTime(agent.startTime, agent.endTime));
    const providerInfo = theme.fg("muted", formatProviderModel(agent.provider, agent.model));
    
    const statusLine = ` ${statusIcon} ${typeIcon} ${name} ${providerInfo} ${elapsed}`;
    lines.push(
      theme.fg("border", "│ ") + 
      truncateToWidth(statusLine, innerWidth) + 
      " ".repeat(Math.max(0, innerWidth - visibleWidth(statusLine))) +
      theme.fg("border", " │")
    );

    // Current activity as main status line
    const activityText = agent.currentActivity || "Working...";
    const activityLine = `   ${theme.fg("accent", "→")} ${theme.fg("text", activityText)}`;
    lines.push(
      theme.fg("border", "│ ") + 
      truncateToWidth(activityLine, innerWidth) + 
      " ".repeat(Math.max(0, innerWidth - visibleWidth(activityLine))) +
      theme.fg("border", " │")
    );

    // Metrics line with actual data instead of fake progress bar
    const metricsParts: string[] = [];
    if (agent.linesGenerated > 0) {
      metricsParts.push(`📄 ${agent.linesGenerated} lines`);
    }
    if (agent.toolsExecuted > 0) {
      metricsParts.push(`🔧 ${agent.toolsExecuted} tools`);
    }
    if (agent.filesModified.size > 0) {
      metricsParts.push(`📁 ${agent.filesModified.size} files`);
    }
    
    if (metricsParts.length > 0) {
      const metricsLine = `   ${theme.fg("muted", metricsParts.join("  •  "))}`;
      lines.push(
        theme.fg("border", "│ ") + 
        truncateToWidth(metricsLine, innerWidth) + 
        " ".repeat(Math.max(0, innerWidth - visibleWidth(metricsLine))) +
        theme.fg("border", " │")
      );
    }

    return lines;
  }

  private getTheme(): Theme {
    // Access the global theme or return a fallback
    // In practice, this gets styled by the TUI system
    return (global as any).PI_THEME || { fg: (c: string, s: string) => s, bg: () => "", bold: (s: string) => s } as any;
  }
}

// ─── Full Dashboard Overlay Component ─────────────────────────────────────────

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
      this.selectedIndex = Math.min(this.agentKeys.length - 1, this.selectedIndex + 1);
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
    // Keep selected item visible
    const visibleHeight = 20; // Approximate visible area
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + visibleHeight) {
      this.scrollOffset = this.selectedIndex - visibleHeight + 1;
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    this.updateAgentKeys();
    
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines = this.buildFullDashboard(width);
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private buildFullDashboard(width: number): string[] {
    const lines: string[] = [];
    const th = this.theme;
    const runningCount = this.monitor.getRunningCount();
    const totalCount = this.agentKeys.length;

    // Header
    lines.push(th.fg("border", "┌" + "─".repeat(width - 2) + "┐"));
    
    const title = " 🔮 Multi-Agent Dashboard ";
    const subtitle = runningCount > 0 
      ? ` ${runningCount} running, ${totalCount} total `
      : ` ${totalCount} agents `;
    
    const titleLine = title + " ".repeat(Math.max(0, width - 4 - visibleWidth(title) - visibleWidth(subtitle))) + subtitle;
    lines.push(th.fg("border", "│") + th.fg("accent", th.bold(titleLine)) + th.fg("border", "│"));
    
    lines.push(th.fg("border", "├" + "═".repeat(width - 2) + "┤"));

    if (this.agentKeys.length === 0) {
      const emptyMsg = " No agents active ";
      const padding = " ".repeat(Math.max(0, width - 4 - visibleWidth(emptyMsg)));
      lines.push(th.fg("border", "│") + th.fg("dim", emptyMsg) + padding + th.fg("border", "│"));
    } else {
      // Agent detail cards
      for (let i = 0; i < this.agentKeys.length; i++) {
        const key = this.agentKeys[i]!;
        const agent = this.monitor.agents.get(key)!;
        const isSelected = i === this.selectedIndex;
        
        if (isSelected) {
          lines.push(th.fg("border", "│") + th.bg("selectedBg", " ".repeat(width - 2)) + th.fg("border", "│"));
        }

        const cardLines = this.renderDetailedAgentCard(agent, width - 4, th, isSelected);
        for (const line of cardLines) {
          const prefix = isSelected ? th.bg("selectedBg", " ") : " ";
          const suffix = isSelected ? th.bg("selectedBg", " ") : " ";
          const padding = " ".repeat(Math.max(0, width - 4 - visibleWidth(line)));
          lines.push(th.fg("border", "│") + prefix + line + padding + suffix + th.fg("border", "│"));
        }

        if (isSelected) {
          lines.push(th.fg("border", "│") + th.bg("selectedBg", " ".repeat(width - 2)) + th.fg("border", "│"));
        }
        
        // Separator between cards
        if (i < this.agentKeys.length - 1) {
          lines.push(th.fg("border", "├" + th.fg("dim", "─".repeat(width - 2)) + th.fg("border", "┤")));
        }
      }
    }

    // Footer with help
    lines.push(th.fg("border", "├" + "─".repeat(width - 2) + "┤"));
    const help = " ↑↓ navigate • q/esc close ";
    const helpPadding = " ".repeat(Math.max(0, width - 4 - visibleWidth(help)));
    lines.push(th.fg("border", "│") + th.fg("dim", help) + helpPadding + th.fg("border", "│"));
    lines.push(th.fg("border", "└" + "─".repeat(width - 2) + "┘"));

    return lines;
  }

  private renderDetailedAgentCard(agent: AgentState, width: number, theme: Theme, isSelected: boolean): string[] {
    const lines: string[] = [];
    const statusIcon = getStatusIcon(agent.status, theme);
    const typeIcon = this.monitor.getAgentTypeIcon(agent.type);
    
    // Header line with status and name
    const name = isSelected ? theme.fg("accent", theme.bold(agent.name)) : theme.bold(agent.name);
    const headerLine = `${statusIcon} ${typeIcon} ${name}`;
    lines.push(headerLine);

    // Current activity
    const activityText = agent.currentActivity || "Working...";
    const activityLine = `   ${theme.fg("accent", "→")} ${theme.fg("text", activityText)}`;
    lines.push(activityLine);

    // Provider/Model info
    const providerLine = `   ${theme.fg("muted", "Provider:")} ${agent.provider}`;
    lines.push(providerLine);
    
    const modelLine = `   ${theme.fg("muted", "Model:")} ${agent.model}`;
    lines.push(modelLine);

    // Timing info
    const elapsed = formatElapsedTime(agent.startTime, agent.endTime);
    const timingLine = `   ${theme.fg("muted", "Elapsed:")} ${elapsed}${agent.endTime ? " (completed)" : ""}`;
    lines.push(timingLine);

    // Detailed metrics section
    lines.push(`   ${theme.fg("muted", "Metrics:")}`);
    
    // Lines generated
    const linesLine = `     ${theme.fg("dim", "📄")} ${agent.linesGenerated} lines generated`;
    lines.push(linesLine);
    
    // Tools executed
    const toolsLine = `     ${theme.fg("dim", "🔧")} ${agent.toolsExecuted} tools executed`;
    lines.push(toolsLine);
    
    // Files modified
    const filesLine = `     ${theme.fg("dim", "📁")} ${agent.filesModified.size} files modified`;
    lines.push(filesLine);
    
    // Output size
    const sizeKb = (agent.outputSize / 1024).toFixed(1);
    const sizeLine = `     ${theme.fg("dim", "💾")} ${sizeKb} KB output`;
    lines.push(sizeLine);

    // Show modified files list (limited)
    if (agent.filesModified.size > 0) {
      lines.push(`   ${theme.fg("muted", "Files:")}`);
      const files = Array.from(agent.filesModified).slice(0, 5); // Show first 5
      for (const file of files) {
        const fileName = file.length > width - 12 
          ? "..." + file.slice(-(width - 15)) 
          : file;
        lines.push(`     ${theme.fg("dim", "•")} ${fileName}`);
      }
      if (agent.filesModified.size > 5) {
        const moreLine = `     ${theme.fg("dim", `... and ${agent.filesModified.size - 5} more`)}`;
        lines.push(moreLine);
      }
    }

    // Output preview (expanded in full view)
    if (agent.output && agent.output.length > 0) {
      lines.push(`   ${theme.fg("muted", "Latest Output:")}`);
      
      // Get the last meaningful lines instead of processing the whole output
      const outputLines = agent.output.split('\n');
      const meaningfulLines = outputLines
        .map(l => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
        .filter(l => l.length > 0)
        .slice(-3); // Show last 3 meaningful lines
      
      for (const line of meaningfulLines) {
        const chunk = line.length > width - 12 
          ? line.slice(0, width - 15) + "..."
          : line;
        lines.push(`     ${theme.fg("dim", "→")} ${truncateToWidth(chunk, width - 8)}`);
      }
    }

    return lines;
  }
}

// ─── Pi Agent Runner ─────────────────────────────────────────────────────────

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

    const args = [
      "-ne",
      "--provider", provider,
      "--model", model,
      "-p", prompt
    ];

    const proc = spawn("pi", args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PI_SUBAGENT: "1" }
    });

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
      
      if (!agentMonitor.hasRunningAgents()) {
        clearWidget(ctx, 10000);
      }
      
      if (code === 0) {
        resolve(output || "(no output)");
      } else {
        reject(new Error(`Pi agent exited with code ${code}. stderr: ${stderrOutput}`));
      }
    });

    proc.on("error", (err) => {
      agentMonitor.completeAgent(agentKey, false);
      updateWidget(ctx);
      reject(err);
    });
  });
}

// ─── UI Update Functions ─────────────────────────────────────────────────────

let widgetHandle: { close: () => void; requestRender: () => void } | undefined;
const widgetComponent = new AgentDashboardWidget(agentMonitor);

function updateWidget(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;

  if (!widgetHandle) {
    widgetHandle = ctx.ui.setWidget("agent-monitor", (_tui, theme) => {
      // Store theme for widget rendering
      (global as any).PI_THEME = theme;
      return widgetComponent;
    }, { placement: "aboveEditor" }) as any;
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

// ─── Extension Entry Point ───────────────────────────────────────────────────

export default function piMultiAgent(pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT === "1") {
    return;
  }

  const extensionDir = (pi as any).extensionDir ||
    path.join(process.env.HOME || "", ".pi/agent/extensions/pi-multi-agent");

  const config = loadAgentsConfig(extensionDir);

  // ─── Helpers (closures over config) ─────────────────────────────────────────

  function buildPrompt(role: "design" | "code", task: string, agentMd: string): string {
    const agentFile = `AGENT-${role}.md`;
    return `${config.agents[role].promptPrefix}

${config.shared.agientContext}

${agentMd ? `Context from AGENT.md:\n${agentMd}\n\n---\n\n` : ""}Task: ${task}

Read AGENT.md before starting. When done, write your results to ${agentFile}. Last line of ${agentFile} must be a timestamp: \`_Updated: <ISO datetime>_\``;
  }

  async function runWithFallback(
    role: "design" | "code",
    prompt: string,
    cwd: string,
    ctx: ExtensionContext
  ): Promise<string> {
    const agentCfg = config.agents[role];
    try {
      return await runPiAgent(agentCfg.provider, agentCfg.model, prompt, cwd, ctx, role, agentCfg.name, role);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`${agentCfg.name} failed: ${msg}. Falling back...`, "warning");
      const fallback = config.fallbacks[role];
      return runPiAgent(fallback.provider, fallback.model, prompt, cwd, ctx, `${role}-fallback`, `${agentCfg.name} (Fallback)`, "fallback");
    }
  }

  // Register delegate tool — runs design and/or code agents, in parallel when both are provided
  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description: "Delegate work to specialist agents. Set 'design' for UI/visual work, 'code' for backend/logic. Provide BOTH fields to run them in parallel.",
    promptSnippet: "design: UI/TUI/CSS/React. code: backend/logic. Both fields = run in parallel.",
    promptGuidelines: [
      "design: visual interfaces, UI components, TUI, HTML/CSS, React, styling",
      "code: backend logic, algorithms, implementation, debugging, scripts",
      "Provide BOTH fields to run design and code agents simultaneously.",
    ],
    parameters: Type.Object({
      design: Type.Optional(Type.String({ description: "UI/visual task: interfaces, TUI, HTML/CSS, React, styling" })),
      code: Type.Optional(Type.String({ description: "Code task: backend logic, algorithms, implementation, debugging" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { design, code } = params as { design?: string; code?: string };
      const cwd = process.cwd();

      let agentMd = "";
      const agentMdPath = path.join(cwd, "AGENT.md");
      if (fs.existsSync(agentMdPath)) {
        agentMd = fs.readFileSync(agentMdPath, "utf-8");
      }

      const tasks: Promise<{ role: string; result: string }>[] = [];
      if (design) {
        tasks.push(runWithFallback("design", buildPrompt("design", design, agentMd), cwd, ctx)
          .then(result => ({ role: "design", result })));
      }
      if (code) {
        tasks.push(runWithFallback("code", buildPrompt("code", code, agentMd), cwd, ctx)
          .then(result => ({ role: "code", result })));
      }

      if (tasks.length === 0) {
        return { content: [{ type: "text", text: "No tasks provided. Use 'design', 'code', or both fields." }] };
      }

      const label = tasks.length > 1 ? "both agents in parallel" : (design ? config.agents.design.name : config.agents.code.name);
      ctx.ui.notify(`Running ${label}...`, "info");

      const results = await Promise.all(tasks);
      ctx.ui.notify(`${tasks.length > 1 ? "Both agents" : "Agent"} complete`, "success");

      const combined = results.map(r => `### ${r.role}\n${r.result}`).join("\n\n---\n\n");
      return { content: [{ type: "text", text: combined }] };
    }
  });

  // Replace system prompt and inject stealthy delegation reminder
  // Uses a hidden message (display: false) so user doesn't see it, but LLM receives it
  pi.on("before_agent_start", async (_event) => {
    const addendum = config.orchestrator?.systemPromptAddendum || "";
    const spiPrompt = config.shared.spiSystemPrompt || "";
    const now = new Date();
    const dateStr = now.toLocaleString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short"
    });
    const cwd = process.cwd();
    
    const newPrompt = spiPrompt + addendum + `\n\nCurrent date: ${dateStr}\nCurrent working directory: ${cwd}`;
    
    return {
      systemPrompt: newPrompt,
      message: {
        customType: "delegate-reminder",
        content: "Remember: use the `delegate` tool for any coding or design tasks. Coding → `delegate { code: "..." }`, Design → `delegate { design: "..." }`, Both → `delegate { code: "...", design: "..." }`.",
        display: false
      }
    };
  });

  // Register commands
  pi.registerCommand("agents", {
    description: "Show configured agents and their providers/models",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const lines = [
        "\x1b[1mConfigured Agents\x1b[0m",
        "",
        `\x1b[1mDesigner:\x1b[0m`,
        `  Provider: ${config.agents.design.provider}`,
        `  Model: ${config.agents.design.model}`,
        `  Fallback: ${config.fallbacks.design.provider}/${config.fallbacks.design.model}`,
        "",
        `\x1b[1mCoder:\x1b[0m`,
        `  Provider: ${config.agents.code.provider}`,
        `  Model: ${config.agents.code.model}`,
        `  Fallback: ${config.fallbacks.code.provider}/${config.fallbacks.code.model}`,
        "",
        `\x1b[2mConfig file: ${path.join(extensionDir, "agents.json")}\x1b[0m`
      ];
      return lines.join("\n");
    }
  });

  pi.registerCommand("reload-agents", {
    description: "Reload agents.json configuration",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const newConfig = loadAgentsConfig(extensionDir);
      Object.assign(config, newConfig);
      ctx.ui.notify("Agents configuration reloaded", "success");
      return "Configuration reloaded from agents.json";
    }
  });

  // Full dashboard overlay command
  pi.registerCommand("agents-dashboard", {
    description: "Show full agent activity dashboard",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        return "Dashboard requires interactive UI mode";
      }

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        const dashboard = new FullDashboardOverlay(agentMonitor, theme, done, tui);
        return {
          render: (w) => dashboard.render(w),
          handleInput: (data) => dashboard.handleInput(data),
          invalidate: () => dashboard.invalidate()
        };
      }, { overlay: true });
    }
  });

  // Session start notification
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      `Pi Multi-Agent ready. Designer: ${config.agents.design.provider}, Coder: ${config.agents.code.provider}. /agents for status.`,
      "info"
    );
  });

  // Update status on agent activity
  agentMonitor.setWidgetRenderCallback(() => {
    widgetComponent.invalidate();
    widgetHandle?.requestRender();
  });
}
