import { describe, expect, test } from "bun:test";
import { getLockedSignalSkipInfo } from "./locked_signal.ts";

describe("getLockedSignalSkipInfo", () => {
  test("returns skip info for locked signals without private_payload", () => {
    expect(getLockedSignalSkipInfo({
      kind: "signal",
      signal_id: "sig_123",
      payload: {
        locked: true,
        price: "0.01",
        currency: "USDC",
        public_payload: { summary: "BTC breakout retest" },
      },
    })).toEqual({
      signal_id: "sig_123",
      price: "0.01",
      currency: "USDC",
    });
  });

  test("does not skip locked signals that already include private_payload", () => {
    expect(getLockedSignalSkipInfo({
      kind: "signal",
      signal_id: "sig_456",
      payload: {
        locked: true,
        price: "0.01",
        currency: "USDC",
        private_payload: { entry_price: 65000 },
      },
    })).toBeNull();
  });

  test("does not skip ordinary unlocked signals", () => {
    expect(getLockedSignalSkipInfo({
      kind: "signal",
      signal_id: "sig_789",
      payload: {
        token: "ETHUSDT",
        direction: "long",
      },
    })).toBeNull();
  });
});
