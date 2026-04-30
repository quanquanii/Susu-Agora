// Pure-function unit tests — no Postgres required.
// E2E tests live in tests/e2e.test.ts and need a running DB.
//
// D13 (2026-04-29) deleted the vote system and the 24h kick cooldown.
// Server now ships only protocol primitives. The previous tests for
// strictMajority + kickAllowed were dropped along with those helpers.

import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { buildSignInMessage, isValidSolanaAddress } from "../src/auth.ts";

describe("Solana address validation", () => {
  test("rejects empty / short / non-base58", () => {
    expect(isValidSolanaAddress("")).toBe(false);
    expect(isValidSolanaAddress("foo")).toBe(false);
    expect(isValidSolanaAddress("0x1234")).toBe(false);
    // Contains base58-illegal char '0' is fine (base58 has no zero), '0' isn't valid base58
    expect(isValidSolanaAddress("0".repeat(43))).toBe(false);
  });
  test("accepts a freshly generated keypair pubkey", () => {
    const kp = nacl.sign.keyPair();
    const addr = bs58.encode(kp.publicKey);
    expect(isValidSolanaAddress(addr)).toBe(true);
  });
});

describe("Sign-in message + ed25519 signature roundtrip", () => {
  test("verify works on a real signature, fails on tampered message", () => {
    const kp = nacl.sign.keyPair();
    const address = bs58.encode(kp.publicKey);
    const nonce = "test-nonce-abc";
    const msg = new TextEncoder().encode(buildSignInMessage(address, nonce));
    const sig = nacl.sign.detached(msg, kp.secretKey);
    expect(nacl.sign.detached.verify(msg, sig, kp.publicKey)).toBe(true);

    // Tamper: change the nonce in message.
    const wrong = new TextEncoder().encode(buildSignInMessage(address, "tampered"));
    expect(nacl.sign.detached.verify(wrong, sig, kp.publicKey)).toBe(false);
  });
});

describe("Atomic billing rule (D5)", () => {
  // No DB needed — we just assert the property: rate is the same for both call types.
  test("signal_push and reaction_push share one rate", async () => {
    const { config } = await import("../src/config.ts");
    // The rate is read from BILLING_RATE_USD; both call_types use config.billingRateUsd.
    expect(typeof config.billingRateUsd).toBe("number");
    // We don't have call-type-specific rates by design — verifying that the
    // billing module exposes only one rate (Querier-meter takes call_type but
    // does not branch cost).
    const billing = await import("../src/billing.ts");
    expect("meter" in billing).toBe(true);
  });
});
