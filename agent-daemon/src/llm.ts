// LLM provider abstraction. Two providers shipped: Anthropic (default) and
// OpenAI. Adding a third just means implementing `LLMProvider`.
//
// Why not just LiteLLM / a generic SDK: the agent-daemon makes one well-
// shaped call per incoming signal — we know exactly what tools we want to
// expose. A thin native-SDK wrapper is shorter, easier to debug, and avoids
// pulling in a heavy abstraction layer for two providers.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// ── Domain types — what the daemon asks for and what it gets back ────────

/** What the daemon knows about an incoming event for the LLM to evaluate. */
export interface AgentContext {
  /** Recent N events on the channel (newest last), JSON-serialized. */
  recent_events: unknown[];
  /** Channel display label (peer @handle for 1on1, group name for group). */
  channel_label: string;
  /** The triggering event itself (separated so prompt can highlight it). */
  triggering_event: unknown;
  /** Caller's own @handle so the LLM doesn't react to its own pushes. */
  my_handle: string | null;
}

/** Decision the LLM returns. The daemon executes whichever shape it gets. */
export type AgentDecision =
  | { kind: "noop"; reason: string }
  | { kind: "react"; signal_id: string; payload: Record<string, unknown>; reason: string }
  | { kind: "push"; channel_id: string; payload: Record<string, unknown>; reason: string };

/** Token + latency stats for the decision log. */
export interface CallStats {
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
}

export interface LLMProvider {
  decide(ctx: AgentContext, systemPrompt: string): Promise<{ decision: AgentDecision; stats: CallStats }>;
}

// ── Tool schema — same JSON-Schema shape works for both providers ────────

const TOOL_NOOP = {
  name: "do_nothing",
  description:
    "Choose this when no response is warranted: not your turn, ambiguous, low confidence, or the event is informational only.",
  parameters: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Brief explanation visible in decision log." },
    },
    required: ["reason"],
  },
};

const TOOL_REACT = {
  name: "react_to_signal",
  description:
    "React to a peer's signal (acknowledge, agree, disagree, propose modification). Use for trade signals where you want to take a position-style stance without sending a fresh message.",
  parameters: {
    type: "object",
    properties: {
      signal_id: { type: "string", description: "ID of the signal you're reacting to (from triggering_event.signal_id)." },
      payload: {
        type: "object",
        description: "Free-form reaction payload. Common shape: {value: '+1' | '-1' | string, note: '...', size_factor: number}.",
      },
      reason: { type: "string", description: "Brief reasoning visible in decision log." },
    },
    required: ["signal_id", "payload", "reason"],
  },
};

const TOOL_PUSH = {
  name: "push_signal",
  description:
    "Push a fresh signal into the channel. Use for new alpha, asks, or context the channel doesn't have yet. Avoid spamming — `do_nothing` is often the right call.",
  parameters: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "Target channel — usually triggering_event.channel_id." },
      payload: {
        type: "object",
        description: "Free-form signal payload. Trade-signal shape: {symbol, direction, leverage, entry_price, sl, tp, reasoning}.",
      },
      reason: { type: "string", description: "Brief reasoning visible in decision log." },
    },
    required: ["channel_id", "payload", "reason"],
  },
};

// ── Anthropic ────────────────────────────────────────────────────────────

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  constructor(apiKey: string, private model: string) {
    this.client = new Anthropic({ apiKey });
  }

  async decide(ctx: AgentContext, systemPrompt: string) {
    const startedAt = Date.now();
    const userText = JSON.stringify(
      {
        my_handle: ctx.my_handle,
        channel_label: ctx.channel_label,
        recent_events: ctx.recent_events,
        triggering_event: ctx.triggering_event,
        instructions:
          "Choose exactly ONE tool call: do_nothing / react_to_signal / push_signal. Be conservative — prefer do_nothing if uncertain.",
      },
      null,
      2,
    );

    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: systemPrompt,
      tools: [
        { ...TOOL_NOOP, input_schema: TOOL_NOOP.parameters },
        { ...TOOL_REACT, input_schema: TOOL_REACT.parameters },
        { ...TOOL_PUSH, input_schema: TOOL_PUSH.parameters },
      ] as any,
      tool_choice: { type: "any" },
      messages: [{ role: "user", content: userText }],
    });

    const stats: CallStats = {
      provider: "anthropic",
      model: this.model,
      input_tokens: resp.usage.input_tokens,
      output_tokens: resp.usage.output_tokens,
      latency_ms: Date.now() - startedAt,
    };

    // Find the first tool_use block.
    for (const block of resp.content) {
      if (block.type === "tool_use") {
        return { decision: blockToDecision(block.name, block.input as any), stats };
      }
    }
    // No tool call → fallback noop.
    return {
      decision: { kind: "noop", reason: "LLM returned no tool call" } as AgentDecision,
      stats,
    };
  }
}

// ── OpenAI ───────────────────────────────────────────────────────────────

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  constructor(apiKey: string, private model: string) {
    this.client = new OpenAI({ apiKey });
  }

  async decide(ctx: AgentContext, systemPrompt: string) {
    const startedAt = Date.now();
    const userText = JSON.stringify(
      {
        my_handle: ctx.my_handle,
        channel_label: ctx.channel_label,
        recent_events: ctx.recent_events,
        triggering_event: ctx.triggering_event,
        instructions:
          "Choose exactly ONE tool call: do_nothing / react_to_signal / push_signal. Be conservative — prefer do_nothing if uncertain.",
      },
      null,
      2,
    );

    const resp = await this.client.chat.completions.create({
      model: this.model,
      tools: [
        { type: "function", function: TOOL_NOOP },
        { type: "function", function: TOOL_REACT },
        { type: "function", function: TOOL_PUSH },
      ],
      tool_choice: "required",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
    });

    const stats: CallStats = {
      provider: "openai",
      model: this.model,
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
      latency_ms: Date.now() - startedAt,
    };

    const tc = resp.choices[0]?.message?.tool_calls?.[0];
    if (!tc) {
      return {
        decision: { kind: "noop", reason: "LLM returned no tool call" } as AgentDecision,
        stats,
      };
    }
    let parsedArgs: any = {};
    try { parsedArgs = JSON.parse(tc.function.arguments); } catch { /* keep {} */ }
    return { decision: blockToDecision(tc.function.name, parsedArgs), stats };
  }
}

// ── Tool result → AgentDecision ──────────────────────────────────────────

function blockToDecision(toolName: string, input: any): AgentDecision {
  switch (toolName) {
    case "do_nothing":
      return { kind: "noop", reason: String(input?.reason ?? "(no reason)") };
    case "react_to_signal":
      return {
        kind: "react",
        signal_id: String(input?.signal_id ?? ""),
        payload: typeof input?.payload === "object" && input.payload !== null ? input.payload : {},
        reason: String(input?.reason ?? "(no reason)"),
      };
    case "push_signal":
      return {
        kind: "push",
        channel_id: String(input?.channel_id ?? ""),
        payload: typeof input?.payload === "object" && input.payload !== null ? input.payload : {},
        reason: String(input?.reason ?? "(no reason)"),
      };
    default:
      return { kind: "noop", reason: `unknown tool ${toolName}` };
  }
}
