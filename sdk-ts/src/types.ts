// Domain types that mirror the backend wire format. Hand-maintained;
// the surface is small enough that codegen would add ceremony without value.

export type Direction = "LONG" | "SHORT" | "long" | "short";
export type Venue = "cex_perp" | "cex_spot" | "dex_perp" | "dex_spot" | "onchain";
export type TimeHorizon = "intraday" | "1d" | "3d" | "1w" | "swing";

/** Reference signal template (signal-template-v0.1.md). All fields optional;
 *  the wire protocol does not validate. SDK provides a typed helper for the
 *  common case but accepts free-form payloads for everything else. */
export interface SignalTemplate {
  symbol?: string;
  direction?: Direction;
  leverage?: number;
  entry_price?: number;
  sl?: number;
  tp?: number | number[];
  time_horizon?: TimeHorizon;
  confidence_pct?: number;
  position_size_pct?: number;
  chain?: string;
  venue?: Venue;
  reasoning?: string;
}

export interface Signal {
  signal_id: string;
  channel_id: string;
  from_address: string;
  payload: unknown;
  created_at: string;
}

export interface Reaction {
  reaction_id: string;
  signal_id: string;
  channel_id?: string;
  from_address: string;
  payload: unknown;
  is_auto: boolean;
  created_at: string;
}

export interface Channel {
  channel_id: string;
  name: string | null;
  created_by: string;
  /** Group: address of current owner. 1-on-1: always null. */
  owner: string | null;
  /** D13: distinguishes group (true) from 1-on-1 (false). */
  is_group: boolean;
  /** D13: free-form JSON. Members read; owner writes (group only). */
  meta: Record<string, unknown>;
  created_at: string;
}

export interface Friend {
  friend_address: string;
  friend_username: string | null;
  channel_id: string;
  created_at: string;
}

export interface FriendRequest {
  request_id: string;
  from_addr: string;
  from_username: string | null;
  created_at: string;
}

/** D13 non-custodial billing — replaces the legacy `Balance` shape.
 *  BETA mode (rate=0) returns `status: "BETA — free"` with allowance fields null.
 *  Paid mode (rate>0) returns the on-chain delegate snapshot. */
export interface Allowance {
  address: string;
  rate_usd_per_call: number;
  status: "BETA — free" | "paid";
  allowance_usd: number | null;
  estimated_calls_remaining: number | null;
  spender_pubkey: string | null;
  usdc_mint: string;
  cluster: string;
  approve_again_url: string;
}

export interface Spender {
  spender_pubkey: string;
  usdc_mint: string;
  cluster: string;
  rate_usd_per_call: number;
}

export interface ApproveTx {
  tx_b64: string;
  amount_usd: number;
  spender_pubkey: string;
  usdc_mint: string;
  cluster: string;
}

export interface UsageItem {
  usage_id: string;
  channel_id: string | null;
  signal_id: string | null;
  reaction_id: string | null;
  call_type: "signal_push" | "reaction_push";
  cost_usd: string;
  created_at: string;
}

export interface Usage {
  address: string;
  rate_usd_per_call: number;
  total_calls: number;
  total_cost_usd: number;
  items: UsageItem[];
}

export class SusurrationError extends Error {
  constructor(public status: number, public body: any, public path: string) {
    super(`HTTP ${status} ${path}: ${typeof body === "object" ? JSON.stringify(body) : body}`);
  }
}

/** 402 — caller's on-chain SPL allowance is below the per-call rate.
 *  Catch separately to surface a "sign an Approve" prompt. `approve_again_url`
 *  is the web flow that builds + signs the tx. */
export class InsufficientAllowanceError extends SusurrationError {
  constructor(
    public allowance_usd: number,
    public required_usd: number,
    public approve_again_url: string | null,
    path: string,
  ) {
    super(
      402,
      { error: "insufficient_allowance", allowance_usd, required_usd, approve_again_url },
      path,
    );
  }
}
