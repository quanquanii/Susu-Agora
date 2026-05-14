// Decision log — pretty-print every LLM decision to stdout (for the human
// glancing at the daemon terminal) and append a JSONL line to a file (for
// post-hoc analysis or audit). This is the "看到 agent 在做什么" surface
// that builds user trust during the early product period: humans should
// always be able to see WHY the agent did what it did.

import { appendFile } from "node:fs/promises";
import type { AgentContext, AgentDecision, CallStats } from "./llm.ts";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

function isTTY(): boolean { return process.stdout.isTTY === true; }
function dim(s: string): string { return isTTY() ? `${DIM}${s}${RESET}` : s; }
function bold(s: string): string { return isTTY() ? `${BOLD}${s}${RESET}` : s; }
function color(s: string, c: string): string { return isTTY() ? `${c}${s}${RESET}` : s; }

function shortId(id: string): string { return id.slice(0, 8); }

function fmtTime(): string {
  const d = new Date();
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

export interface LogEntry {
  ctx: AgentContext;
  decision: AgentDecision;
  stats: CallStats;
  /** Optional ID + cost the daemon got back from the action it executed. */
  result?: { id: string; cost_usd: number };
  /** Set if the action threw — the daemon will still log the LLM's intent. */
  error?: string;
}

export class DecisionLog {
  constructor(private filePath?: string) {}

  async log(entry: LogEntry): Promise<void> {
    this.printToTerminal(entry);
    if (this.filePath) await this.appendToFile(entry);
  }

  async logSkipped(ctx: AgentContext, reason: string): Promise<void> {
    this.printSkippedToTerminal(ctx, reason);
    if (this.filePath) await this.appendSkippedToFile(ctx, reason);
  }

  private printToTerminal(e: LogEntry): void {
    const t = dim(fmtTime());
    const triggerPreview = previewEvent(e.ctx.triggering_event);
    process.stdout.write(`${t}  ${color(e.ctx.channel_label, CYAN)}  ${triggerPreview}\n`);
    process.stdout.write(`  ${dim("⌥ context:")} ${e.ctx.recent_events.length} recent events\n`);
    process.stdout.write(
      `  ${dim("⌥ LLM:")} ${e.stats.provider}/${e.stats.model}  ` +
      `${e.stats.input_tokens}↑ ${e.stats.output_tokens}↓ tok  ` +
      `${(e.stats.latency_ms / 1000).toFixed(2)}s\n`,
    );
    const decisionLine = formatDecision(e.decision);
    process.stdout.write(`  ${dim("⌥ decision:")} ${decisionLine}\n`);
    if (e.error) {
      process.stdout.write(`  ${color("⌥ ERROR:", RED)} ${e.error}\n`);
    } else if (e.result) {
      process.stdout.write(
        `  ${color("⌥ executed:", GREEN)} id=${shortId(e.result.id)} cost=$${e.result.cost_usd.toFixed(4)}\n`,
      );
    }
    process.stdout.write("\n");
  }

  private async appendToFile(e: LogEntry): Promise<void> {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      channel_label: e.ctx.channel_label,
      triggering_event: e.ctx.triggering_event,
      recent_event_count: e.ctx.recent_events.length,
      decision: e.decision,
      stats: e.stats,
      result: e.result,
      error: e.error,
    }) + "\n";
    try { await appendFile(this.filePath!, line, "utf8"); } catch {
      // Don't crash the daemon over log file issues.
    }
  }

  private printSkippedToTerminal(ctx: AgentContext, reason: string): void {
    const t = dim(fmtTime());
    process.stdout.write(`${t}  ${color(ctx.channel_label, CYAN)}\n`);
    process.stdout.write(`  ${dim("⌥ skipped:")} ${reason}\n\n`);
  }

  private async appendSkippedToFile(ctx: AgentContext, reason: string): Promise<void> {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      channel_label: ctx.channel_label,
      triggering_event: ctx.triggering_event,
      recent_event_count: ctx.recent_events.length,
      decision: { kind: "noop", reason },
      skipped: true,
      skip_reason: reason,
    }) + "\n";
    try { await appendFile(this.filePath!, line, "utf8"); } catch {
      // Don't crash the daemon over log file issues.
    }
  }
}

function previewEvent(evt: any): string {
  if (!evt || typeof evt !== "object") return "(unknown event)";
  const kind = evt.kind ?? "?";
  const who = evt.from_username ? `@${evt.from_username}` : (evt.from_address ? evt.from_address.slice(0, 8) + "…" : "?");
  if (kind === "signal") {
    const txt = previewPayload(evt.payload);
    return `${color("signal", YELLOW)} from ${who}: ${txt}`;
  }
  if (kind === "reaction") {
    const txt = previewPayload(evt.payload);
    return `${color("reaction", YELLOW)} from ${who} on ${shortId(evt.signal_id ?? "")}: ${txt}`;
  }
  return `${color(kind, YELLOW)} from ${who}`;
}

function previewPayload(p: any): string {
  if (p == null) return "(empty)";
  if (typeof p === "string") return p.length > 80 ? p.slice(0, 77) + "..." : p;
  if (typeof p === "object" && typeof p.text === "string") return previewPayload(p.text);
  const s = JSON.stringify(p);
  return s.length > 80 ? s.slice(0, 77) + "..." : s;
}

function formatDecision(d: AgentDecision): string {
  switch (d.kind) {
    case "noop": return `${dim("noop")} — ${d.reason}`;
    case "react": return `${color("react", GREEN)} ${shortId(d.signal_id)} ${JSON.stringify(d.payload)} — ${d.reason}`;
    case "push": return `${color("push", YELLOW)} ${shortId(d.channel_id)} ${JSON.stringify(d.payload)} — ${d.reason}`;
  }
}
