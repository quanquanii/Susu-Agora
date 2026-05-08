// SusuClient — lean fetch wrapper. Same shape as the CLI's api.ts but
// exported as a class so application code can hold a stateful client.
//
// Mirrors the D13 backend surface (post open-protocol-framework + non-custodial
// billing). See `susu doc` (CLI) or the MCP server's `instructions` field
// for the canonical AGENT_DOC.

import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  SusurrationError,
  InsufficientAllowanceError,
  type Channel,
  type Signal,
  type Reaction,
  type Friend,
  type FriendRequest,
  type Allowance,
  type Spender,
  type ApproveTx,
  type Usage,
  type SignalTemplate,
} from "./types.ts";

export interface SusuClientOptions {
  apiUrl?: string;
  /** bearer token from /auth/verify */
  token?: string;
  /** ed25519 secret key (64-byte base58) — enables auto-login + sign helpers */
  secretKeyB58?: string;
  address?: string;
  fetch?: typeof fetch;
}

function stripAt(handle: string): string {
  return handle.startsWith("@") ? handle.slice(1) : handle;
}

export class SusuClient {
  apiUrl: string;
  token: string | undefined;
  address: string | undefined;
  private secretKeyB58: string | undefined;
  private fetchImpl: typeof fetch;

  constructor(opts: SusuClientOptions = {}) {
    // Backend mounts under /api (single-hostname deploy).
    this.apiUrl = (opts.apiUrl ?? "http://localhost:8787/api").replace(/\/$/, "");
    this.token = opts.token;
    this.address = opts.address;
    this.secretKeyB58 = opts.secretKeyB58;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // ── auth ──────────────────────────────────────────────────────────────

  /** Sign-in with the configured keypair. Sets this.token. */
  async login(): Promise<{ token: string; expires_at: string; address: string }> {
    if (!this.address || !this.secretKeyB58) {
      throw new Error("login() requires address + secretKeyB58 in constructor options");
    }
    const nonce = await this.req<{ nonce: string; message: string }>(
      "POST", "/auth/nonce", { address: this.address }, { auth: false },
    );
    const sig = nacl.sign.detached(
      new TextEncoder().encode(nonce.message),
      bs58.decode(this.secretKeyB58),
    );
    const verify = await this.req<{ token: string; expires_at: string; address: string }>(
      "POST", "/auth/verify",
      { address: this.address, nonce: nonce.nonce, signature_b58: bs58.encode(sig) },
      { auth: false },
    );
    this.token = verify.token;
    return verify;
  }

  // ── identity ──────────────────────────────────────────────────────────

  whoami() {
    return this.req<{
      address: string;
      handle: string | null;
      username: string | null;
      auto_accept_friends: boolean;
      created_at: string;
    }>("GET", "/identity/whoami");
  }

  /** Lock a permanent username for the authed address. Format
   *  `[a-z0-9_-]{3,20}`. Once set, cannot be changed. */
  register(username: string) {
    return this.req<{ address: string; username: string }>(
      "POST", "/identity/register", { username: stripAt(username) },
    );
  }

  /** Public — resolve `@handle` → `{address, username}`. No auth. */
  byUsername(username: string) {
    return this.req<{ address: string; username: string }>(
      "GET", `/identity/by-username/${stripAt(username)}`, undefined, { auth: false },
    );
  }

  // ── friends (1-on-1 channels) ────────────────────────────────────────

  /** Add a friend by `@handle` or address. Auto-creates a 1-on-1 channel
   *  if their auto_accept_friends is on; otherwise records a pending request. */
  friendsAdd(args: { username?: string; address?: string }) {
    const body: Record<string, string> = {};
    if (args.username) body.username = stripAt(args.username);
    if (args.address) body.address = args.address;
    return this.req<{
      status: "added" | "already_friends" | "pending";
      channel_id?: string;
      request_id?: string;
      target: { address: string; username: string };
    }>("POST", "/friends/add", body);
  }

  friendsAccept(args: { username?: string; address?: string }) {
    const body: Record<string, string> = {};
    if (args.username) body.username = stripAt(args.username);
    if (args.address) body.address = args.address;
    return this.req<{ status: "accepted"; channel_id: string }>(
      "POST", "/friends/accept", body,
    );
  }

  friendsRemove(args: { username?: string; address?: string }) {
    const body: Record<string, string> = {};
    if (args.username) body.username = stripAt(args.username);
    if (args.address) body.address = args.address;
    return this.req<{ status: "removed"; channel_id: string }>(
      "POST", "/friends/remove", body,
    );
  }

  friends() {
    return this.req<{ friends: Friend[] }>("GET", "/friends");
  }

  friendsRequests() {
    return this.req<{ requests: FriendRequest[] }>("GET", "/friends/requests");
  }

  // ── channels (groups) ────────────────────────────────────────────────

  /** Create a GROUP channel. Caller is owner + only initial member. */
  createChannel(name?: string | null) {
    return this.req<{ channel_id: string; owner: string; is_group: true }>(
      "POST", "/channels", { name: name ?? null },
    );
  }
  getChannel(channelId: string) {
    return this.req<Channel>("GET", `/channels/${channelId}`);
  }
  listMembers(channelId: string) {
    return this.req<{ members: { address: string; username: string | null; joined_at: string }[] }>(
      "GET", `/channels/${channelId}/members`,
    );
  }
  /** Group only. 1-on-1 channels return 409 not_supported_for_1on1. */
  invite(channelId: string, address: string) {
    return this.req<{ ok: true; added: string }>(
      "POST", `/channels/${channelId}/invite`, { address },
    );
  }
  /** 1-on-1: cascade-deletes the channel.
   *  Group: regular leave; if owner leaves, server auto-elects the
   *  earliest-joined remaining member as new owner. */
  leave(channelId: string) {
    return this.req<{ ok: true; was_1on1: boolean; ownerHandover?: string | null }>(
      "POST", `/channels/${channelId}/leave`,
    );
  }
  /** Group only, owner only. No server-side cooldown. */
  kick(channelId: string, address: string) {
    return this.req<{ ok: true; kicked: string }>(
      "POST", `/channels/${channelId}/kick`, { address },
    );
  }
  /** Group only, owner only. Candidate must already be a member. */
  transferOwner(channelId: string, args: { username?: string; candidate_address?: string }) {
    const body: Record<string, string> = {};
    if (args.username) body.username = stripAt(args.username);
    if (args.candidate_address) body.candidate_address = args.candidate_address;
    return this.req<{ ok: true; new_owner: string }>(
      "POST", `/channels/${channelId}/transfer-owner`, body,
    );
  }

  // ── channel meta KV (D13 open protocol) ──────────────────────────────

  /** Read channel meta JSON. Members can read; owner writes (group only). */
  metaGet(channelId: string) {
    return this.req<{ meta: Record<string, unknown> }>("GET", `/channels/${channelId}/meta`);
  }
  /** REPLACE channel meta with the given JSON. 16KB limit. */
  metaSet(channelId: string, meta: Record<string, unknown>) {
    return this.req<{ ok: true }>("PUT", `/channels/${channelId}/meta`, meta);
  }
  /** Shallow-merge into existing meta. */
  metaPatch(channelId: string, meta: Record<string, unknown>) {
    return this.req<{ ok: true }>("PATCH", `/channels/${channelId}/meta`, meta);
  }

  // ── signals + reactions ───────────────────────────────────────────────

  /** Push a signal. Accepts a typed SignalTemplate, plain object, or string.
   *  String is wrapped into `{text: ...}`. $0.01 per call; every new identity
   *  gets $5 free credits. Throws `InsufficientAllowanceError` on 402. */
  pushSignal(channelId: string, payload: SignalTemplate | Record<string, unknown> | string) {
    const body = typeof payload === "string" ? { text: payload } : payload;
    return this.req<Signal & { cost_usd: number; allowance_after?: Allowance }>(
      "POST", `/channels/${channelId}/signals`, body,
    );
  }
  listSignals(channelId: string, opts: { since?: string; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (opts.since) q.set("since", opts.since);
    if (opts.limit) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return this.req<{ signals: Signal[] }>("GET", `/channels/${channelId}/signals${qs ? `?${qs}` : ""}`);
  }

  /** SSE stream — async iterator yielding signals as they arrive.
   *  Iterate with `for await (const sig of client.streamSignals(id)) { ... }`.
   *  Closes when the iterator is broken or aborted. */
  async *streamSignals(channelId: string, opts: { signal?: AbortSignal } = {}): AsyncGenerator<Signal> {
    if (!this.token) throw new Error("streamSignals requires a session token");
    // R2: mint a single-use stream_token; the bearer never hits the URL.
    const st = await this.req<{ stream_token: string }>("POST", "/auth/stream-token");
    const url = `${this.apiUrl}/channels/${channelId}/signals/stream?stream_token=${encodeURIComponent(st.stream_token)}`;
    const resp = await this.fetchImpl(url, { signal: opts.signal });
    if (!resp.ok || !resp.body) {
      throw new SusurrationError(resp.status, await resp.text(), url);
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const blocks = buf.split(/\r?\n\r?\n/);
        buf = blocks.pop() ?? "";
        for (const block of blocks) {
          let event = "message", data = "";
          for (const line of block.split(/\r?\n/)) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (event === "signal" && data) {
            try { yield JSON.parse(data) as Signal; } catch { /* malformed — skip */ }
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  /** React to a peer's signal. $0.01 per call; every new identity gets $5 free credits. */
  pushReaction(signalId: string, payload: unknown, opts: { is_auto?: boolean } = {}) {
    return this.req<Reaction & { cost_usd: number; allowance_after?: Allowance }>(
      "POST", `/signals/${signalId}/reactions`, { payload, is_auto: !!opts.is_auto },
    );
  }
  listReactions(signalId: string) {
    return this.req<{ reactions: Reaction[] }>("GET", `/signals/${signalId}/reactions`);
  }

  // ── billing (non-custodial SPL Approve) ──────────────────────────────

  /** Read on-chain SPL allowance + rate. BETA returns
   *  `{status: 'BETA — free', rate_usd_per_call: 0}`. Paid returns
   *  the full delegate snapshot. */
  allowance() {
    return this.req<Allowance>("GET", "/billing/allowance");
  }

  /** Public — current spender pubkey + USDC mint + cluster. No auth. */
  spender() {
    return this.req<Spender>("GET", "/billing/spender", undefined, { auth: false });
  }

  /** Build an unsigned SPL Token Approve tx (base64). User must sign in
   *  their wallet (Phantom etc.) and submit. Direct user to
   *  `https://susurration.xyz/approve?amount=N` for the web signing flow. */
  approveTx(amount_usd: number = 100) {
    return this.req<ApproveTx>("POST", "/billing/approve-tx", { amount_usd });
  }

  /** List recent debits. Returns total_calls, total_cost_usd, items. */
  usage(opts: { since?: string; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (opts.since) q.set("since", opts.since);
    if (opts.limit) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return this.req<Usage>("GET", `/usage${qs ? `?${qs}` : ""}`);
  }

  // ── private ───────────────────────────────────────────────────────────

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { auth?: boolean } = {},
  ): Promise<T> {
    const url = this.apiUrl + path;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.auth !== false && this.token) headers.authorization = `Bearer ${this.token}`;
    const resp = await this.fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const ct = resp.headers.get("content-type") ?? "";
    const respBody: any = ct.includes("application/json") ? await resp.json() : await resp.text();
    if (!resp.ok) {
      if (resp.status === 402 && respBody?.error === "insufficient_allowance") {
        throw new InsufficientAllowanceError(
          respBody.allowance_usd ?? 0,
          respBody.required_usd ?? 0,
          respBody.approve_again_url ?? null,
          path,
        );
      }
      throw new SusurrationError(resp.status, respBody, path);
    }
    return respBody as T;
  }
}
