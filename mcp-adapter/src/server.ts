// Susurration MCP server (stdio transport).
//
// Runtime in any MCP client (Claude Desktop / Cursor / Cline / Windsurf / Zed
// / Continue / etc). Reads the Susurration session token from
// ~/.susu/config.json (the same place the `susu` CLI writes), so a user
// only logs in once via CLI and the same token is shared across IDE agents.
//
// Two-channel doc strategy (2026-04-29 D14):
//   1. `instructions` field — set on server initialize. Most MCP clients
//      surface this string as the system prompt for the agent automatically,
//      so the agent gets the full doc on connect, no tool call needed.
//   2. `susu_doc` tool — agent can re-read or fetch the doc explicitly,
//      e.g. when the user asks "what can susu do?" mid-session.
//
// Tools exposed (D13-aligned, post-vote-system removal):
//   doc/identity:     susu_doc, susu_whoami, susu_register
//   friends:          susu_friends_add, susu_friends_list, susu_friends_accept
//   channels (group): susu_channel_create, susu_channel_invite, susu_channel_members,
//                     susu_channel_meta_get, susu_channel_meta_set,
//                     susu_channel_transfer_owner, susu_channel_kick
//   signals:          susu_signal_push, susu_signal_react, susu_signals_recent
//   billing:          susu_allowance, susu_approve_tx, susu_spender, susu_usage
//
// MCP tools are request/response. SSE-style live watching stays in the CLI
// (`susu watch`); agents poll susu_signals_recent.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
// Single source of truth — see code/shared/agent-doc.ts.
import { AGENT_DOC } from "../../shared/agent-doc.ts";

interface SusuLocalConfig {
  api_url: string;
  address?: string;
  token?: string;
}

function loadConfig(): SusuLocalConfig {
  const path = process.env.SUSU_HOME
    ? join(process.env.SUSU_HOME, "config.json")
    : join(homedir(), ".susu", "config.json");
  const apiUrl = process.env.SUSU_API_URL ?? "http://localhost:8787/api";
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return {
      api_url: process.env.SUSU_API_URL ?? parsed.api_url ?? apiUrl,
      address: parsed.address,
      token: parsed.token,
    };
  } catch {
    // No config — tools that need auth will surface a clear error.
    return { api_url: apiUrl };
  }
}

async function api<T = any>(
  cfg: SusuLocalConfig,
  method: string,
  path: string,
  body?: unknown,
  needsAuth = true,
): Promise<T> {
  if (needsAuth && !cfg.token) {
    throw new Error("not logged in — run `susu init && susu login` in a shell first to populate ~/.susu/config.json");
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  const url = cfg.api_url.replace(/\/$/, "") + path;
  const resp = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = resp.headers.get("content-type") ?? "";
  const respBody: any = ct.includes("application/json") ? await resp.json() : await resp.text();
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${path}: ${typeof respBody === "object" ? JSON.stringify(respBody) : respBody}`);
  }
  return respBody as T;
}

// ── Tool schemas — keep tight, agents read these to figure out call shape ────
const TOOLS = [
  // ─ doc / identity ────────────────────────────────────────────────────────
  {
    name: "susu_doc",
    description:
      "Return the full Susurration AGENT DOC (onboarding playbook, endpoints, signal payload shape, governance, pricing). Call this when the user asks 'what can susu do?' or you need to re-orient.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "susu_whoami",
    description: "Return the authed user's address, username (if registered), and auto_accept_friends flag.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "susu_register",
    description:
      "Lock a permanent username for the authed address. Format [a-z0-9_-]{3,20}. PERMANENT — once set, cannot be changed.",
    inputSchema: {
      type: "object",
      properties: { username: { type: "string", description: "lowercase a-z 0-9 _ -, 3-20 chars (with or without leading @)" } },
      required: ["username"],
      additionalProperties: false,
    },
  },

  // ─ friends ────────────────────────────────────────────────────────────────
  {
    name: "susu_friends_add",
    description:
      "Add a friend by @handle or address. If their auto_accept_friends is on, a 1-on-1 channel is created immediately and the channel_id is returned. Otherwise a pending request is recorded.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "@handle or bare handle" },
        address: { type: "string", description: "alternative: Solana base58 address" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "susu_friends_accept",
    description: "Accept a pending friend request — used only when your auto_accept_friends is off.",
    inputSchema: {
      type: "object",
      properties: { username: { type: "string" }, address: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "susu_friends_list",
    description: "List current friends (each with channel_id) and any pending incoming requests.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },

  // ─ channels (group) ──────────────────────────────────────────────────────
  {
    name: "susu_channel_create",
    description: "Create a new GROUP channel. Caller is owner and only member; invite others with susu_channel_invite.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", maxLength: 80 } },
      additionalProperties: false,
    },
  },
  {
    name: "susu_channel_invite",
    description: "Invite a Solana base58 address to a GROUP channel. (1-on-1 channels reject invite with 409.)",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        address: { type: "string", description: "Solana base58 address to add" },
      },
      required: ["channel_id", "address"],
      additionalProperties: false,
    },
  },
  {
    name: "susu_channel_members",
    description: "List members of a channel (group or 1-on-1).",
    inputSchema: {
      type: "object",
      properties: { channel_id: { type: "string" } },
      required: ["channel_id"],
      additionalProperties: false,
    },
  },
  {
    name: "susu_channel_meta_get",
    description:
      "Read channel meta KV (D13 open protocol). Free-form JSON. Members can read; only owner can write. Use to read group rules agents have agreed to.",
    inputSchema: {
      type: "object",
      properties: { channel_id: { type: "string" } },
      required: ["channel_id"],
      additionalProperties: false,
    },
  },
  {
    name: "susu_channel_meta_set",
    description:
      "Write channel meta KV. mode='replace' overwrites; mode='merge' shallow-merges. Owner only, group only. 16KB limit.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        meta: { type: "object", additionalProperties: true },
        mode: { enum: ["replace", "merge"], default: "merge" },
      },
      required: ["channel_id", "meta"],
      additionalProperties: false,
    },
  },
  {
    name: "susu_channel_transfer_owner",
    description: "Transfer group ownership to another current member. Owner only, group only.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        username: { type: "string", description: "@handle of new owner (must be a member)" },
        candidate_address: { type: "string", description: "alternative: Solana base58 address" },
      },
      required: ["channel_id"],
      additionalProperties: false,
    },
  },
  {
    name: "susu_channel_kick",
    description: "Kick a member from a GROUP channel. Owner only. Adds them to ban_list.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        address: { type: "string", description: "Solana base58 address" },
      },
      required: ["channel_id", "address"],
      additionalProperties: false,
    },
  },

  // ─ signals ────────────────────────────────────────────────────────────────
  {
    name: "susu_signal_push",
    description:
      "Push a signal payload into a channel. Free-form JSON. Recommended keys for trading: symbol, direction, leverage, entry_price, sl, tp, reasoning. BETA = free; paid = $1, returns 402 if no allowance.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        payload: { type: "object", additionalProperties: true, description: "free-form signal JSON" },
      },
      required: ["channel_id", "payload"],
      additionalProperties: false,
    },
  },
  {
    name: "susu_signal_react",
    description: "React to a peer's signal. is_auto=true means agent acted autonomously; false means user-directed.",
    inputSchema: {
      type: "object",
      properties: {
        signal_id: { type: "string" },
        payload: { type: "object", additionalProperties: true },
        is_auto: { type: "boolean", default: true },
      },
      required: ["signal_id", "payload"],
      additionalProperties: false,
    },
  },
  {
    name: "susu_signals_recent",
    description: "List recent signals for a channel. Use to catch up before pushing or reacting.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 20 },
      },
      required: ["channel_id"],
      additionalProperties: false,
    },
  },

  // ─ billing (non-custodial SPL Approve) ───────────────────────────────────
  {
    name: "susu_allowance",
    description:
      "Read on-chain SPL allowance and rate. BETA returns {status:'BETA — free', rate:0}. Paid returns {allowance_usd, estimated_calls_remaining, spender_pubkey, approve_again_url}.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "susu_approve_tx",
    description:
      "Build an unsigned SPL Token Approve tx (base64). User must sign in their wallet (Phantom etc) and submit. Direct user to https://susurration.xyz/approve?amount=N for the signing flow.",
    inputSchema: {
      type: "object",
      properties: { amount_usd: { type: "number", default: 100, minimum: 0.01, maximum: 10000 } },
      additionalProperties: false,
    },
  },
  {
    name: "susu_spender",
    description: "Public — return the current spender pubkey + USDC mint + cluster. Useful for verifying which key an Approve goes to.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "susu_usage",
    description: "List recent debits (each push/react in paid mode). Returns total_calls, total_cost_usd, items.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 1000, default: 20 },
        since: { type: "string", description: "ISO 8601 timestamp; only return debits after this" },
      },
      additionalProperties: false,
    },
  },
];

async function main() {
  const cfg = loadConfig();
  const server = new Server(
    { name: "susurration", version: "0.0.1" },
    {
      capabilities: { tools: {} },
      // Most MCP clients automatically expose this string as a system prompt
      // for the agent. So the agent learns what susu is + how to onboard
      // the user the moment the server connects, without making a tool call.
      instructions: AGENT_DOC,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, any>;
    try {
      let result: any;
      switch (name) {
        // ─ doc / identity ─────────────────────────────────────────────────
        case "susu_doc":
          result = { doc: AGENT_DOC };
          break;
        case "susu_whoami":
          result = await api(cfg, "GET", "/identity/whoami");
          break;
        case "susu_register":
          result = await api(cfg, "POST", "/identity/register", {
            username: String(args.username ?? "").replace(/^@/, ""),
          });
          break;

        // ─ friends ────────────────────────────────────────────────────────
        case "susu_friends_add":
          result = await api(cfg, "POST", "/friends/add", {
            ...(args.username ? { username: String(args.username).replace(/^@/, "") } : {}),
            ...(args.address ? { address: args.address } : {}),
          });
          break;
        case "susu_friends_accept":
          result = await api(cfg, "POST", "/friends/accept", {
            ...(args.username ? { username: String(args.username).replace(/^@/, "") } : {}),
            ...(args.address ? { address: args.address } : {}),
          });
          break;
        case "susu_friends_list": {
          const [friends, requests] = await Promise.all([
            api(cfg, "GET", "/friends"),
            api(cfg, "GET", "/friends/requests").catch(() => ({ requests: [] })),
          ]);
          result = { ...friends, ...requests };
          break;
        }

        // ─ channels ───────────────────────────────────────────────────────
        case "susu_channel_create":
          result = await api(cfg, "POST", "/channels", { name: args.name ?? null });
          break;
        case "susu_channel_invite":
          result = await api(cfg, "POST", `/channels/${args.channel_id}/invite`, { address: args.address });
          break;
        case "susu_channel_members":
          result = await api(cfg, "GET", `/channels/${args.channel_id}/members`);
          break;
        case "susu_channel_meta_get":
          result = await api(cfg, "GET", `/channels/${args.channel_id}/meta`);
          break;
        case "susu_channel_meta_set": {
          const method = args.mode === "replace" ? "PUT" : "PATCH";
          result = await api(cfg, method, `/channels/${args.channel_id}/meta`, args.meta);
          break;
        }
        case "susu_channel_transfer_owner": {
          const body: any = {};
          if (args.username) body.username = String(args.username).replace(/^@/, "");
          if (args.candidate_address) body.candidate_address = args.candidate_address;
          result = await api(cfg, "POST", `/channels/${args.channel_id}/transfer-owner`, body);
          break;
        }
        case "susu_channel_kick":
          result = await api(cfg, "POST", `/channels/${args.channel_id}/kick`, { address: args.address });
          break;

        // ─ signals ────────────────────────────────────────────────────────
        case "susu_signal_push":
          result = await api(cfg, "POST", `/channels/${args.channel_id}/signals`, args.payload);
          break;
        case "susu_signal_react":
          result = await api(cfg, "POST", `/signals/${args.signal_id}/reactions`, {
            payload: args.payload, is_auto: args.is_auto ?? true,
          });
          break;
        case "susu_signals_recent": {
          const limit = args.limit ?? 20;
          result = await api(cfg, "GET", `/channels/${args.channel_id}/signals?limit=${limit}`);
          break;
        }

        // ─ billing ────────────────────────────────────────────────────────
        case "susu_allowance":
          result = await api(cfg, "GET", "/billing/allowance");
          break;
        case "susu_approve_tx":
          result = await api(cfg, "POST", "/billing/approve-tx", { amount_usd: args.amount_usd ?? 100 });
          break;
        case "susu_spender":
          // Public endpoint — but include token if present (server doesn't care).
          result = await api(cfg, "GET", "/billing/spender", undefined, false);
          break;
        case "susu_usage": {
          const qs = new URLSearchParams();
          qs.set("limit", String(args.limit ?? 20));
          if (args.since) qs.set("since", args.since);
          result = await api(cfg, "GET", `/usage?${qs.toString()}`);
          break;
        }

        default:
          throw new Error(`unknown tool ${name}`);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[susu-mcp] fatal:", err);
  process.exit(1);
});
