// LLM 提供方抽象。当前内置三个提供方：Anthropic（默认）、
// OpenAI 和 Groq。要增加新的提供方，只需要实现 `LLMProvider`。
//
// 为什么不用 LiteLLM / 通用 SDK：agent-daemon 会针对每个信号做一次
// 结构固定的调用，我们很清楚要暴露哪些工具。使用轻量的原生 SDK 包装
// 更短、更容易调试，也避免为了少数几个提供方引入一层厚抽象。

import Anthropic from "@anthropic-ai/sdk";
import Groq from "groq-sdk";
import OpenAI from "openai";

// ── 领域类型：daemon 请求什么，以及返回什么 ─────────────────────────

/** daemon 交给 LLM 评估时，对传入事件的认知信息。 */
export interface AgentContext {
  /** 频道最近的 N 条事件（按时间从旧到新），已序列化为 JSON。 */
  recent_events: unknown[];
  /** 频道显示名（1 对 1 时是对方 @handle，群组时是群名）。 */
  channel_label: string;
  /** 触发本次决策的事件本身（单独传入，方便 prompt 强调）。 */
  triggering_event: unknown;
  /** 调用者自己的 @handle，避免 LLM 对自己的推送做反应。 */
  my_handle: string | null;
}

/** LLM 返回的决策。daemon 会执行拿到的任意一种结构。 */
export type AgentDecision =
  | { kind: "noop"; reason: string }
  | { kind: "react"; signal_id: string; payload: Record<string, unknown>; reason: string }
  | { kind: "push"; channel_id: string; payload: Record<string, unknown>; reason: string };

/** 供决策日志使用的 token 和延迟统计信息。 */
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

// ── 工具 schema：多个提供方都能复用同一套 JSON Schema ────────────────

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
    "React to a peer's signal (acknowledge, agree, disagree, propose modification). Use for trade signals where you want to take a position-style stance without sending a fresh message. The payload is what the PEER sees on the wire — `reason` is private to your own decision log, so always express your stance via payload.value.",
  parameters: {
    type: "object",
    properties: {
      signal_id: { type: "string", description: "ID of the signal you're reacting to (from triggering_event.signal_id)." },
      payload: {
        type: "object",
        description: "Reaction visible to the peer. value is required so the peer can see your stance.",
        properties: {
          value: {
            type: "string",
            enum: ["+1", "-1"],
            description: "+1 = agree (would also take this trade). -1 = disagree (signal looks bad).",
          },
          size_factor: {
            type: "number",
            minimum: 0.1,
            maximum: 1.0,
            description: "REQUIRED. Your conviction level: 1.0 = full size, 0.5 = half, 0.3 = minimum. Always provide — paper trading uses this to size positions.",
          },
          note: {
            type: "string",
            description: "≤15 words explaining the stance to the peer (separate from `reason` which is your private decision log).",
          },
        },
        required: ["value", "size_factor"],
        additionalProperties: true,
      },
      reason: { type: "string", description: "Brief reasoning visible only in YOUR decision log (peer doesn't see this)." },
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

const OPENAI_COMPAT_TOOLS = [
  { type: "function" as const, function: TOOL_NOOP },
  { type: "function" as const, function: TOOL_REACT },
  { type: "function" as const, function: TOOL_PUSH },
];

function buildUserText(ctx: AgentContext): string {
  return JSON.stringify(
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
}

async function decideWithOpenAICompatibleClient(
  createChatCompletion: (args: any) => Promise<any>,
  providerName: "openai" | "groq",
  model: string,
  ctx: AgentContext,
  systemPrompt: string,
): Promise<{ decision: AgentDecision; stats: CallStats }> {
  const startedAt = Date.now();
  const userText = buildUserText(ctx);

  const resp = await createChatCompletion({
    model,
    tools: OPENAI_COMPAT_TOOLS,
    tool_choice: "required",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
  });

  const stats: CallStats = {
    provider: providerName,
    model,
    input_tokens: resp.usage?.prompt_tokens ?? 0,
    output_tokens: resp.usage?.completion_tokens ?? 0,
    latency_ms: Date.now() - startedAt,
  };

  const tc = resp.choices?.[0]?.message?.tool_calls?.[0];
  if (!tc) {
    return {
      decision: { kind: "noop", reason: "LLM returned no tool call" } as AgentDecision,
      stats,
    };
  }

  let parsedArgs: any = {};
  try { parsedArgs = JSON.parse(tc.function.arguments ?? "{}"); } catch { /* keep {} */ }
  return { decision: blockToDecision(tc.function.name, parsedArgs), stats };
}

// ── Anthropic ────────────────────────────────────────────────────────────

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  constructor(apiKey: string, private model: string) {
    this.client = new Anthropic({ apiKey });
  }

  async decide(ctx: AgentContext, systemPrompt: string) {
    const startedAt = Date.now();
    const userText = buildUserText(ctx);

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

    // 找到第一个 tool_use block。
    for (const block of resp.content) {
      if (block.type === "tool_use") {
        return { decision: blockToDecision(block.name, block.input as any), stats };
      }
    }
    // 没有工具调用时，回退为 noop。
    return {
      decision: { kind: "noop", reason: "LLM returned no tool call" } as AgentDecision,
      stats,
    };
  }
}

// ── OpenAI ───────────────────────────────────────────────────────────────

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  constructor(apiKey: string, private model: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }

  async decide(ctx: AgentContext, systemPrompt: string) {
    return decideWithOpenAICompatibleClient(
      this.client.chat.completions.create.bind(this.client.chat.completions),
      "openai",
      this.model,
      ctx,
      systemPrompt,
    );
  }
}

// ── Groq ─────────────────────────────────────────────────────────────────

export class GroqProvider implements LLMProvider {
  private client: Groq;
  constructor(apiKey: string, private model: string) {
    this.client = new Groq({ apiKey });
  }

  async decide(ctx: AgentContext, systemPrompt: string) {
    return decideWithOpenAICompatibleClient(
      this.client.chat.completions.create.bind(this.client.chat.completions),
      "groq",
      this.model,
      ctx,
      systemPrompt,
    );
  }
}

// ── 工具结果 → AgentDecision ──────────────────────────────────────────

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
