// susu-agent-daemon — long-running process that watches the user's Susurration
// channels and acts on incoming signals via the user's own LLM API key.
//
// Architecture:
//
//   ┌─ susurration backend SSE  ──┐
//   │   /signals/feed/stream      │
//   └──────────┬──────────────────┘
//              ▼ (1) parse incoming event
//   ┌─ daemon main loop ────────────────────────────────┐
//   │  filter:                                          │
//   │   • skip own events                               │
//   │   • skip non-channel-scope events (friend_*, ...) │
//   │  build context: recent_events + triggering_event  │
//   │  rate-check (per-minute cap)                      │
//   │  ▼                                                │
//   │  LLM.decide(ctx)  ──► AgentDecision               │
//   │   • {kind: noop}                                  │
//   │   • {kind: react, signal_id, payload}             │
//   │   • {kind: push, channel_id, payload}             │
//   │  ▼                                                │
//   │  execute via susu_actions HTTP                    │
//   │  ▼                                                │
//   │  decision_log → terminal + JSONL file             │
//   └───────────────────────────────────────────────────┘
//
// Why subscribe to /signals/feed/stream (not per-channel /signals/stream):
//   feed-stream is the canonical "all channels I'm in" fan-in. The daemon
//   doesn't need to know which channels exist — it follows whatever the
//   server tells it the user is a member of, including channels added
//   after the daemon started (BETA-1.c's feed-stream extender wires that
//   up automatically).

import { readFile } from "node:fs/promises";
import {
  AnthropicProvider, OpenAIProvider,
  type LLMProvider, type AgentContext, type AgentDecision,
} from "./llm.ts";
import { DecisionLog } from "./decision_log.ts";
import {
  pushSignal, pushReaction, recentSignals,
  type SusuClientConfig,
} from "./susu_actions.ts";

// ── Config ───────────────────────────────────────────────────────────────

interface DaemonConfig {
  api_url: string;
  token: string;
  llm: {
    provider: "anthropic" | "openai";
    api_key: string;
    model: string;
  };
  agent: {
    system_prompt: string;
    /** Per-minute LLM call cap. Defaults to 10. */
    max_calls_per_minute?: number;
    /** How many recent events to feed the LLM as context. Defaults to 20. */
    history_per_channel?: number;
  };
  /** Daemon will write a JSONL log of every decision to this path. */
  decision_log_path?: string;
  /** SET TO false ONLY DURING TESTING — daemon refuses to push signals
   *  (only react/noop) when true. Default: true (safe by default). */
  dry_run_pushes?: boolean;
}

function parseArgs(argv: string[]): { config?: string } {
  const out: any = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config") out.config = argv[++i];
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`susu-agent-daemon — your agent on Susurration, 24/7

Usage:
  susu-agent-daemon --config agent.config.json

Config file shape (.json):
  {
    "api_url": "https://susurration.xyz/api",
    "token": "<bearer from susu login>",
    "llm": {
      "provider": "anthropic" | "openai",
      "api_key": "<your llm api key>",
      "model": "claude-sonnet-4-6" | "gpt-5" | ...
    },
    "agent": {
      "system_prompt": "You are <name>'s trading agent on Susurration.\\nWhen a peer pushes a trade signal, evaluate against my risk caps...",
      "max_calls_per_minute": 10,
      "history_per_channel": 20
    },
    "decision_log_path": "~/.susu/agent-decisions.jsonl",
    "dry_run_pushes": true
  }

Behavior:
  - Subscribes to your /signals/feed/stream over SSE.
  - For every incoming signal/reaction (NOT your own), calls your LLM
    with the recent channel context and lets it choose: do_nothing,
    react_to_signal, or push_signal.
  - Auto-reconnects on SSE drop with exponential backoff.
  - dry_run_pushes=true (default): refuses push_signal decisions; reacts
    are still allowed. Flip to false once you trust the agent.
  - All decisions stream to stdout AND append to decision_log_path.
`);
}

async function loadConfig(args: ReturnType<typeof parseArgs>): Promise<DaemonConfig> {
  if (!args.config) throw new Error("missing --config <path>");
  const raw = await readFile(args.config, "utf8");
  const parsed = JSON.parse(raw) as DaemonConfig;
  // Apply defaults.
  parsed.dry_run_pushes = parsed.dry_run_pushes ?? true;
  parsed.agent.max_calls_per_minute = parsed.agent.max_calls_per_minute ?? 10;
  parsed.agent.history_per_channel = parsed.agent.history_per_channel ?? 20;
  return parsed;
}

// ── Rate limiter (per-minute LLM calls) ──────────────────────────────────

class MinuteRateLimiter {
  private timestamps: number[] = [];
  constructor(private maxPerMinute: number) {}
  /** Returns true if we're under the cap; records the call timestamp. */
  tryConsume(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);
    if (this.timestamps.length >= this.maxPerMinute) return false;
    this.timestamps.push(now);
    return true;
  }
}

// ── Main loop ────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = await loadConfig(args);
  const susu: SusuClientConfig = { api_url: cfg.api_url, token: cfg.token };

  const provider: LLMProvider = cfg.llm.provider === "openai"
    ? new OpenAIProvider(cfg.llm.api_key, cfg.llm.model)
    : new AnthropicProvider(cfg.llm.api_key, cfg.llm.model);

  const log = new DecisionLog(cfg.decision_log_path);
  const limiter = new MinuteRateLimiter(cfg.agent.max_calls_per_minute!);

  // Discover own address + handle so we can skip self-events.
  let myAddress: string | null = null;
  let myHandle: string | null = null;
  try {
    const meResp = await fetch(susu.api_url.replace(/\/$/, "") + "/me", {
      headers: { authorization: `Bearer ${susu.token}` },
    });
    if (meResp.ok) {
      const me = await meResp.json() as any;
      myAddress = me.address ?? null;
      myHandle = me.handle ?? me.username ?? null;
    }
  } catch { /* fall through; daemon can still run, just won't filter self-events */ }

  process.stderr.write(
    `[daemon] starting as ${myHandle ? `@${myHandle}` : `(${myAddress?.slice(0, 8) ?? "anon"})`}, ` +
    `provider=${cfg.llm.provider}/${cfg.llm.model}, ` +
    `dry_run_pushes=${cfg.dry_run_pushes}, ` +
    `cap=${cfg.agent.max_calls_per_minute}/min\n`,
  );

  // Ctrl-C → graceful exit.
  let stopped = false;
  const onSigint = () => { stopped = true; process.stderr.write("\n[daemon] stopping (SIGINT)\n"); process.exit(0); };
  process.on("SIGINT", onSigint);

  // Reconnect loop: same exponential backoff pattern as cli watch.
  let backoffMs = 1000;
  const MAX_BACKOFF = 30_000;
  while (!stopped) {
    const startedAt = Date.now();
    try {
      await runOneStream(susu, provider, log, limiter, cfg, myAddress);
    } catch (err) {
      process.stderr.write(`[daemon] stream error: ${(err as Error)?.message ?? err}\n`);
    }
    if (stopped) break;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= 30_000) backoffMs = 1000;
    process.stderr.write(`[daemon] reconnecting in ${(backoffMs / 1000).toFixed(1)}s...\n`);
    await new Promise((r) => setTimeout(r, backoffMs));
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
  }
  return 0;
}

async function runOneStream(
  susu: SusuClientConfig,
  provider: LLMProvider,
  log: DecisionLog,
  limiter: MinuteRateLimiter,
  cfg: DaemonConfig,
  myAddress: string | null,
): Promise<void> {
  const url = susu.api_url.replace(/\/$/, "") + "/signals/feed/stream";
  const resp = await fetch(url, { headers: { authorization: `Bearer ${susu.token}` } });
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`auth failed (HTTP ${resp.status}); your token may have expired — re-run \`susu login\` and update config`);
  }
  if (resp.status === 429) {
    throw new Error("too_many_streams (HTTP 429) — close other watch/feed sessions");
  }
  if (!resp.ok || !resp.body) throw new Error(`stream HTTP ${resp.status}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split(/\r?\n\r?\n/);
    buf = parts.pop() ?? "";
    for (const block of parts) {
      let event = "message", data = "";
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (event === "ping" || event === "open" || event === "ejected") continue;
      if (!data) continue;
      let evt: any;
      try { evt = JSON.parse(data); } catch { continue; }
      // Daemon only acts on incoming signal / reaction events. friend_* /
      // channel_member_* etc are observability for the human, not actionable
      // by the agent.
      if (evt?.kind !== "signal" && evt?.kind !== "reaction") continue;
      // Skip own events (we don't react to ourselves).
      if (myAddress && evt.from_address === myAddress) continue;
      // Best-effort handle the event; never let one bad event kill the loop.
      handleEvent(evt, susu, provider, log, limiter, cfg).catch((err) => {
        process.stderr.write(`[daemon] handle error: ${(err as Error)?.message ?? err}\n`);
      });
    }
  }
}

async function handleEvent(
  evt: any,
  susu: SusuClientConfig,
  provider: LLMProvider,
  log: DecisionLog,
  limiter: MinuteRateLimiter,
  cfg: DaemonConfig,
): Promise<void> {
  if (!limiter.tryConsume()) {
    process.stderr.write(`[daemon] rate-limited (>${cfg.agent.max_calls_per_minute}/min); skipping event\n`);
    return;
  }
  const channelId = evt.channel_id;
  const channelLabel = evt.channel_name ?? (evt.peer?.username ? `@${evt.peer.username}` : channelId.slice(0, 8));

  // Pull recent context for the LLM. Bounded by cfg.history_per_channel.
  let history: any[] = [];
  try {
    const r = await recentSignals(susu, channelId, cfg.agent.history_per_channel);
    history = r.signals ?? [];
  } catch { /* if history fetch fails, run with empty context */ }

  const ctx: AgentContext = {
    recent_events: history,
    channel_label: channelLabel,
    triggering_event: evt,
    my_handle: null,  // filled by main(); could thread through but UI shows from_username already
  };

  let decision: AgentDecision;
  let stats;
  try {
    const out = await provider.decide(ctx, cfg.agent.system_prompt);
    decision = out.decision;
    stats = out.stats;
  } catch (err) {
    process.stderr.write(`[daemon] LLM error: ${(err as Error)?.message ?? err}\n`);
    return;
  }

  // Execute the decision.
  let result: { id: string; cost_usd: number } | undefined;
  let error: string | undefined;
  try {
    if (decision.kind === "react") {
      const r = await pushReaction(susu, decision.signal_id, decision.payload, true);
      result = { id: r.reaction_id, cost_usd: r.cost_usd };
    } else if (decision.kind === "push") {
      if (cfg.dry_run_pushes) {
        error = "dry_run_pushes=true — push decision NOT executed (would have posted to channel)";
      } else {
        const r = await pushSignal(susu, decision.channel_id, decision.payload);
        result = { id: r.signal_id, cost_usd: r.cost_usd };
      }
    }
    // noop → nothing to execute
  } catch (err) {
    error = (err as Error)?.message ?? String(err);
  }

  await log.log({ ctx, decision, stats, result, error });
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`[daemon] fatal: ${(err as Error)?.message ?? err}\n`);
  process.exit(1);
});
