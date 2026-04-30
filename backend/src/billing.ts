// D5 atomic billing rule + non-custodial charge path.
//
// rate=0 (BETA): write usage_log row with cost=0, skip on-chain charge entirely.
// rate>0 (paid): chargeUser() does an SPL TransferChecked on-chain (synchronous,
//   ~400ms-2s); on InsufficientAllowanceError throw a typed error the route
//   surfaces as 402 with approve_again_url.
//
// silent skip = no row (free).

import type { Querier } from "./db.ts";
import { config } from "./config.ts";
import { chargeUser, InsufficientAllowanceError } from "./lib/solana.ts";

export type CallType = "signal_push" | "reaction_push";

export interface MeterArgs {
  tx: Querier;
  address: string;
  channelId: string | null;
  signalId?: string | null;
  reactionId?: string | null;
  callType: CallType;
}

// Re-export so route handlers can import from a single place.
export { InsufficientAllowanceError };

/** Rate-aware atomic charge.
 *  - rate=0: write 0-cost usage_log row, return.
 *  - rate>0: chargeUser() (SPL TransferChecked); on confirm, write usage_log row.
 *
 *  The on-chain charge happens BEFORE the usage_log INSERT — if the chain call
 *  fails (insufficient allowance, RPC error), no row is written, no business
 *  state mutates. The caller's outer transaction will still run, but since
 *  this throws, the route handler returns 402/500 before COMMIT.
 *
 *  IMPORTANT: caller's tx may roll back AFTER chargeUser() succeeds. In that
 *  case we've moved real USDC on-chain but DB shows no usage. usage_log row
 *  is best-effort consistency. We accept this tradeoff because:
 *    1. usage_log is for transparency, not for re-debiting (charges are on-chain)
 *    2. tx rollback after an external on-chain commit is rare
 *    3. truth is on-chain (allowance decreases regardless of DB state)
 */
export async function meter(args: MeterArgs): Promise<{ cost_usd: number; usage_id: string }> {
  const cost = config.billingRateUsd;

  if (cost > 0) {
    // chargeUser may take 400ms-2s synchronously while we wait for confirmation.
    // The InsufficientAllowanceError path is the 402 trigger.
    await chargeUser({ userAddress: args.address, amountUsd: cost });
  }

  const rows = await args.tx<{ usage_id: string }[]>`
    INSERT INTO usage_log(address, channel_id, signal_id, reaction_id, call_type, cost_usd)
    VALUES (
      ${args.address},
      ${args.channelId},
      ${args.signalId ?? null},
      ${args.reactionId ?? null},
      ${args.callType},
      ${cost}
    )
    RETURNING usage_id
  `;
  return { cost_usd: cost, usage_id: rows[0]!.usage_id };
}
