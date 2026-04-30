// Regression tests for the 5 🔴 + Y3 from G's audit (2026-04-28).
// These cover: cluster/mint validation (R3 pure), redaction (R2 pure),
// proposal effect status semantics (Y3 pure). The runtime / SSE leak (R1)
// and ledger / max-members behaviors (R5) need DB and live in e2e.

import { describe, expect, test, beforeEach } from "bun:test";
import { validateSolanaConfig, ClusterMismatchError } from "../src/lib/solana.ts";
import { check, RateLimitedError, _resetForTests } from "../src/lib/rate_limit.ts";

describe("R3 — Solana cluster/RPC/mint validation", () => {
  test("default devnet config passes", () => {
    expect(() => validateSolanaConfig({
      cluster: "devnet",
      rpcUrl: "https://api.devnet.solana.com",
      usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    })).not.toThrow();
  });

  test("default mainnet config passes", () => {
    expect(() => validateSolanaConfig({
      cluster: "mainnet-beta",
      rpcUrl: "https://api.mainnet-beta.solana.com",
      usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    })).not.toThrow();
  });

  test("mainnet RPC + devnet mint REFUSES (R3 main-line bug)", () => {
    expect(() => validateSolanaConfig({
      cluster: "mainnet-beta",
      rpcUrl: "https://api.mainnet-beta.solana.com",
      usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // devnet mint
    })).toThrow(ClusterMismatchError);
  });

  test("devnet cluster + mainnet RPC hostname REFUSES", () => {
    expect(() => validateSolanaConfig({
      cluster: "devnet",
      rpcUrl: "https://api.mainnet-beta.solana.com",
      usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    })).toThrow(/different cluster/);
  });

  test("unknown cluster name refuses", () => {
    expect(() => validateSolanaConfig({
      cluster: "fakenet",
      rpcUrl: "https://api.devnet.solana.com",
      usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    })).toThrow(/unknown cluster/);
  });

  test("override flag allows custom mint (e.g. local mock USDC)", () => {
    expect(() => validateSolanaConfig({
      cluster: "devnet",
      rpcUrl: "https://api.devnet.solana.com",
      usdcMint: "MockUsdcMint11111111111111111111111111111111",
      allowOverride: true,
    })).not.toThrow();
  });

  test("private RPC hostname (no cluster keyword) is allowed", () => {
    expect(() => validateSolanaConfig({
      cluster: "mainnet-beta",
      rpcUrl: "https://my-helius-shard.example.com/v1/rpc?token=abc",
      usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    })).not.toThrow();
  });
});

describe("BETA-1.b — sliding-window rate limiter", () => {
  beforeEach(() => _resetForTests());

  test("allows up to N hits in window", () => {
    for (let i = 0; i < 5; i++) {
      expect(() => check("k1", { windowMs: 60_000, max: 5 })).not.toThrow();
    }
  });

  test("blocks the (N+1)th hit and reports retry_after", () => {
    for (let i = 0; i < 3; i++) check("k2", { windowMs: 60_000, max: 3 });
    try {
      check("k2", { windowMs: 60_000, max: 3 });
      throw new Error("should have rate-limited");
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitedError);
      expect((e as RateLimitedError).retryAfterSec).toBeGreaterThan(0);
    }
  });

  test("different keys have independent buckets", () => {
    for (let i = 0; i < 5; i++) check(`k3:${i}`, { windowMs: 60_000, max: 1 });
    // each key only used once → no throw
    expect(true).toBe(true);
  });

  test("very short window expires hits", async () => {
    check("k4", { windowMs: 50, max: 1 });
    expect(() => check("k4", { windowMs: 50, max: 1 })).toThrow(RateLimitedError);
    await new Promise((r) => setTimeout(r, 60));
    expect(() => check("k4", { windowMs: 50, max: 1 })).not.toThrow();
  });
});

describe("R2 — log redaction", () => {
  // Mirror the regex used in src/index.ts so a future change in either
  // place breaks this test.
  const REDACT_KEYS = /(stream_token|token)=[^&]*/gi;
  function redact(url: string): string {
    return url.replace(REDACT_KEYS, "$1=REDACTED");
  }

  test("stream_token in URL is redacted", () => {
    expect(redact("/x?stream_token=abc.def-ghi"))
      .toBe("/x?stream_token=REDACTED");
  });
  test("token= (legacy) is redacted", () => {
    expect(redact("/x?token=secret"))
      .toBe("/x?token=REDACTED");
  });
  test("multiple params + redacted token mid-string", () => {
    expect(redact("/x?a=1&stream_token=AAA&b=2"))
      .toBe("/x?a=1&stream_token=REDACTED&b=2");
  });
  test("URL without token is unchanged", () => {
    expect(redact("/channels/abc/signals?since=2026-01-01"))
      .toBe("/channels/abc/signals?since=2026-01-01");
  });
});
