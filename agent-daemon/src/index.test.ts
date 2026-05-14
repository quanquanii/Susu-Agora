import { describe, expect, test } from "bun:test";
import type { AgentContext, AgentDecision, CallStats, LLMProvider } from "./llm.ts";
import { handleEvent } from "./index.ts";

function makeProvider(counter: { calls: number }): LLMProvider {
  return {
    async decide(_ctx: AgentContext): Promise<{ decision: AgentDecision; stats: CallStats }> {
      counter.calls += 1;
      return {
        decision: { kind: "noop", reason: "test noop" },
        stats: {
          provider: "mock",
          model: "test",
          input_tokens: 1,
          output_tokens: 1,
          latency_ms: 1,
        },
      };
    },
  };
}

const susu = { api_url: "http://127.0.0.1:9/api", token: "test-token" };
const limiter = { tryConsume: () => true } as any;
const cfg = {
  agent: {
    system_prompt: "test",
    max_calls_per_minute: 10,
    history_per_channel: 1,
  },
  llm: { provider: "groq", api_key: "dummy", model: "openai/gpt-oss-20b" },
  dry_run_pushes: true,
} as any;
const log = {
  log: async () => {},
  logSkipped: async () => {},
} as any;

describe("handleEvent", () => {
  test("skips locked signals without private_payload before calling LLM", async () => {
    const calls = { calls: 0 };
    await handleEvent({
      kind: "signal",
      signal_id: "sig_locked",
      channel_id: "chan_1",
      created_at: new Date().toISOString(),
      payload: {
        locked: true,
        price: "0.01",
        currency: "USDC",
        public_payload: { summary: "BTC breakout retest" },
      },
    }, susu, makeProvider(calls), log, limiter, cfg, null);
    expect(calls.calls).toBe(0);
  });

  test("continues to LLM for unlocked paid signals that include private_payload", async () => {
    const calls = { calls: 0 };
    await handleEvent({
      kind: "signal",
      signal_id: "sig_unlocked",
      channel_id: "chan_1",
      created_at: new Date().toISOString(),
      payload: {
        locked: true,
        price: "0.01",
        currency: "USDC",
        private_payload: { entry_price: 65000 },
      },
    }, susu, makeProvider(calls), log, limiter, cfg, null);
    expect(calls.calls).toBe(1);
  });

  test("continues to LLM for ordinary unlocked signals", async () => {
    const calls = { calls: 0 };
    await handleEvent({
      kind: "signal",
      signal_id: "sig_plain",
      channel_id: "chan_1",
      created_at: new Date().toISOString(),
      payload: {
        token: "ETHUSDT",
        direction: "long",
      },
    }, susu, makeProvider(calls), log, limiter, cfg, null);
    expect(calls.calls).toBe(1);
  });
});
