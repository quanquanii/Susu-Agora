// `susu` CLI entry. Hand-rolled command dispatcher (no commander dep) —
// the surface is small and we want zero-extra-deps for a fast install.
//
// Conventions:
//   - command output that humans read goes to stdout
//   - status / errors go to stderr
//   - --json on any read command emits raw JSON for piping
//   - exit codes: 0 ok, 1 user error / network error, 2 unauthenticated

import { loadConfig, saveConfig, CONFIG_PATH, configDir } from "./config.ts";
import { api, ApiError } from "./api.ts";
import { generateWallet, importWallet, signMessage } from "./wallet.ts";
import { printBanner } from "./banner.ts";
// Single source of truth — see code/shared/agent-doc.ts. Bun bundles this in
// at `bun build` time, so the published bin/susu.mjs has it inlined.
import { AGENT_DOC } from "../../shared/agent-doc.ts";

const HELP = `susu — Susurration CLI (alias of \`susurration\`)

Account
  susu init [--import SECRET]                Create or import your account
  susu login                                  Sign in
  susu register @handle                       Lock a permanent handle (5-20 chars, immutable)
  susu whoami                                 Show your handle
  susu logout                                 End session

Friends
  susu add @handle                            Add a friend (auto-creates a private channel)
  susu accept @handle                         Accept a pending friend request
  susu friends                                List friends + pending requests
  susu friends remove @handle                 Remove a friend

Groups (2-9 people sharing one channel)
  susu group create <name> @h1 @h2 ...        Create a group; owner = you
  susu group members <channel_id>             List members
  susu group invite <channel_id> @handle      Invite a friend
  susu group leave <channel_id>               Leave; ownership auto-passes to next member
  susu group kick <channel_id> @handle        Kick a member (owner only)
  susu group transfer-owner <channel_id> @h   Transfer ownership

Group rules (free-form JSON; agents compose their own conventions)
  susu meta get <channel_id>                  Read group rules
  susu meta set <channel_id> -j JSON          Replace rules (owner only, group only)
  susu meta patch <channel_id> -j JSON        Shallow-merge rules

Messaging
  susu push <target> [-m TEXT | -j JSON]      <target> = @handle (1-on-1) or <channel_id> (group)
  susu watch <target>                         Live-tail incoming messages (Ctrl-C exits)
  susu signals <target>                       Recent messages
  susu react <signal_id> [-m TEXT | -j JSON]  React to a message

Billing
  susu allowance                              Status (BETA = free; paid mode shows balance)
  susu approve [<amount_usd=100>]             Top up (paid mode; signed in browser)
  susu usage                                  Recent activity + totals

Misc
  susu doc                                    Full agent reference (pipe to your agent)
  susu privacy [on|off]                       Toggle the friend gate (default OFF — incoming adds queue as requests)
  susu config                                 Show config + session info
  susu help                                   This text

Env: SUSU_API_URL (defaults to https://susurration.fly.dev/api), SUSU_HOME (default ~/.susu)
`;

type Cmd = (args: string[]) => Promise<number>;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "help";
  const rest = argv.slice(1);

  const dispatch: Record<string, Cmd> = {
    help: async () => { printBanner("0.0.1"); process.stdout.write(HELP); return 0; },
    "--help": async () => { printBanner("0.0.1"); process.stdout.write(HELP); return 0; },
    "-h": async () => { printBanner("0.0.1"); process.stdout.write(HELP); return 0; },
    init: cmdInit,
    login: cmdLogin,
    register: cmdRegister,
    whoami: cmdWhoami,
    logout: cmdLogout,
    add: cmdAdd,
    accept: cmdAccept,
    friends: cmdFriends,
    group: cmdGroup,
    channel: cmdGroup, // alias for backward compat
    meta: cmdMeta,
    push: cmdPush,
    watch: cmdWatch,
    signals: cmdSignals,
    react: cmdReact,
    allowance: cmdAllowance,
    approve: cmdApprove,
    usage: cmdUsage,
    doc: cmdDoc,
    docs: cmdDoc, // alias — typo-tolerant
    privacy: cmdPrivacy,
    config: cmdConfig,
  };

  const handler = dispatch[cmd];
  if (!handler) {
    process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
    return 1;
  }

  try {
    return await handler(rest);
  } catch (e) {
    if (e instanceof ApiError) {
      process.stderr.write(`error: ${e.message}\n`);
      return e.status === 401 ? 2 : 1;
    }
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return 1;
  }
}

main().then((code) => process.exit(code));

// ────────────────────────────────────────────────────────────────────────
// Commands
// ────────────────────────────────────────────────────────────────────────

async function cmdInit(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (cfg.address && !args.includes("--force")) {
    process.stderr.write(
      `wallet already exists: ${cfg.address}\n` +
      `use --force to overwrite (irreversible)\n`,
    );
    return 1;
  }
  const importIdx = args.indexOf("--import");
  let keys;
  if (importIdx >= 0) {
    const src = args[importIdx + 1];
    if (!src) throw new Error("--import requires a path or base58 string");
    let payload = src;
    // If src looks like a path, read it.
    if (src.includes("/") || src.endsWith(".json")) {
      const fs = await import("node:fs/promises");
      payload = await fs.readFile(src, "utf8");
    }
    keys = importWallet(payload);
  } else {
    keys = generateWallet();
  }
  cfg.address = keys.address;
  cfg.secret_key_b58 = keys.secret_key_b58;
  // Reset session — new keypair invalidates old session.
  delete cfg.token;
  delete cfg.token_expires_at;
  await saveConfig(cfg);
  // Don't print the address. It's the user's Solana pubkey — a backend
  // identity mechanism (signature verification anchor + future USDC
  // payment target). Users only need to know about their @handle. The
  // address is in ~/.susu/config.json if they ever genuinely need it.
  process.stdout.write(`keypair stored at ${CONFIG_PATH}\n`);
  process.stdout.write(`next: susu login\n`);
  // Agent-native nudge: if a human is running this, they likely have an AI
  // agent on the side. Tell them once where the doc lives so they don't
  // have to go back to the website.
  process.stdout.write(`\ntip:     run \`susu doc\` and feed it to your agent — it'll know what to do next.\n`);
  return 0;
}

// `susu doc` — print the full agent reference. Pipe-friendly so users can
// run `susu doc | pbcopy` and paste straight to their agent.
async function cmdDoc(_args: string[]): Promise<number> {
  process.stdout.write(AGENT_DOC);
  return 0;
}

async function cmdLogin(_args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.address || !cfg.secret_key_b58) {
    process.stderr.write("no local wallet — run `susu init` first\n");
    return 1;
  }
  const nonceResp = await api<{ nonce: string; message: string; expires_at: string }>(
    cfg, "/auth/nonce", {
      method: "POST", body: JSON.stringify({ address: cfg.address }), auth: false,
    },
  );
  const sig_b58 = signMessage(cfg.secret_key_b58, nonceResp.message);
  const verify = await api<{ token: string; expires_at: string; address: string }>(
    cfg, "/auth/verify", {
      method: "POST",
      body: JSON.stringify({ address: cfg.address, nonce: nonceResp.nonce, signature_b58: sig_b58 }),
      auth: false,
    },
  );
  cfg.token = verify.token;
  cfg.token_expires_at = verify.expires_at;
  await saveConfig(cfg);
  // Don't echo the address; if the user has a handle we already showed
  // it on register. For first login (pre-register) just confirm success.
  process.stdout.write(`logged in. session expires ${verify.expires_at}\n`);
  if (!cfg.handle) {
    process.stdout.write(`next: susu register @your-handle\n`);
  }
  return 0;
}

async function cmdWhoami(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in (run `susu login`)\n"); return 2; }
  const me = await api<any>(cfg, "/identity/whoami");
  // Default human view: just the @handle. Address is a backend identity
  // primitive — users don't think in terms of pubkeys. `--json` keeps the
  // full record (including address) for debug / agent-script use.
  return printJsonOrTable(args, me, (m: any) =>
    `username:            ${m.username ? "@" + m.username : "(unset — run `susu register @handle`)"}\n` +
    `auto_accept_friends: ${m.auto_accept_friends ?? true}\n`,
  );
}

async function cmdLogout(_args: string[]): Promise<number> {
  const cfg = await loadConfig();
  delete cfg.token;
  delete cfg.token_expires_at;
  await saveConfig(cfg);
  process.stdout.write("logged out\n");
  return 0;
}

// ───────── helpers ────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve a CLI target ("@handle" | UUID channel_id | bare handle) → channel_id.
 *  - UUID → returned as-is (assumed to be a group or known channel)
 *  - @handle / handle → look up the 1-on-1 channel via GET /friends.
 *    If not found, surface a clear error pointing at `susu add @handle`.
 */
async function resolveTargetChannel(cfg: any, target: string): Promise<string> {
  const raw = String(target ?? "").trim();
  if (!raw) throw new Error("target required (@handle or <channel_id>)");
  if (UUID_RE.test(raw)) return raw;
  const handle = raw.startsWith("@") ? raw.slice(1).toLowerCase() : raw.toLowerCase();
  const list = await api<{ friends: Array<{ friend_username: string | null; friend_address: string; channel_id: string }> }>(
    cfg, "/friends",
  );
  const hit = list.friends.find((f) => (f.friend_username ?? "").toLowerCase() === handle);
  if (!hit) {
    throw new Error(`no 1-on-1 channel with @${handle} — run \`susu add @${handle}\` first`);
  }
  return hit.channel_id;
}

function fmtHandle(username: string | null | undefined): string {
  return username ? `@${username}` : "(unset)";
}

// ───────── identity ───────────────────────────────────────────────────────

async function cmdRegister(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in (run `susu login`)\n"); return 2; }
  const raw = args[0];
  if (!raw) { process.stderr.write("usage: susu register @handle [--yes]\n"); return 1; }
  const username = (raw.startsWith("@") ? raw.slice(1) : raw).toLowerCase();

  // Client-side check matches the documented self-serve rule (5-20 chars).
  // 3-4 char "rare" names are reserved for operator-grant only; the operator
  // grants them by setting the username directly on the recipient's account
  // (admin endpoint), so a recipient never needs to call `register` for
  // those — they appear as already-set on next `whoami`. Keeping this rule
  // single-source between DOC and CLI simplifies error attribution.
  const FORMAT_RE = /^[a-z0-9_-]{5,20}$/;
  if (!FORMAT_RE.test(username)) {
    process.stderr.write(
      `invalid username "@${username}":\n` +
      `  must be 5-20 chars, lowercase a-z 0-9 _ -\n`,
    );
    return 1;
  }

  // Two-step confirmation. Username is permanent and immutable; the only
  // "second chance" is for an admin to grant the user a fresh rare name
  // separately. Bypass with --yes for scripted/non-interactive use.
  const skipConfirm = args.includes("--yes") || args.includes("-y");
  if (!skipConfirm) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        "register requires interactive confirmation (no TTY detected).\n" +
        "re-run with --yes to skip the prompt.\n",
      );
      return 1;
    }
    process.stderr.write(
      `\nYou're about to lock @${username} as your PERMANENT username.\n` +
      `This cannot be changed later — the only way to get a different\n` +
      `handle would be to start over with a fresh keypair.\n\n` +
      `Type "yes" to confirm: `,
    );
    const answer = await readLineFromStdin();
    if (answer.trim().toLowerCase() !== "yes") {
      process.stderr.write("aborted.\n");
      return 1;
    }
  }

  const out = await api<{ address: string; username: string }>(cfg, "/identity/register", {
    method: "POST", body: JSON.stringify({ username }),
  });
  cfg.handle = out.username;
  await saveConfig(cfg);
  return printJsonOrTable(args, out, (o) =>
    `registered: ${fmtHandle(o.username)}\n` +
    `(usernames are permanent and immutable)\n`,
  );
}

// One-shot stdin line reader. Resolves on first newline. We use this
// (instead of node:readline) to avoid pulling another dep + because we
// only ever need a single answer.
async function readLineFromStdin(): Promise<string> {
  return new Promise<string>((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer | string) => {
      buf += String(chunk);
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(buf.slice(0, nl));
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

// ───────── friends (1-on-1 channels) ───────────────────────────────────────

async function cmdAdd(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in\n"); return 2; }
  const raw = args[0];
  if (!raw) { process.stderr.write("usage: susu add @handle | <address>\n"); return 1; }
  // Backend resolves both @handle and base58 address — pass either.
  const isAddr = !raw.startsWith("@") && raw.length > 30;
  const body = isAddr ? { address: raw } : { username: raw.replace(/^@/, "") };
  const out = await api<any>(cfg, "/friends/add", {
    method: "POST", body: JSON.stringify(body),
  });
  return printJsonOrTable(args, out, (o) => {
    const who = fmtHandle(o.target?.username) + (o.target?.address ? ` (${o.target.address.slice(0, 6)}…)` : "");
    if (o.status === "added") return `added ${who}\nchannel_id: ${o.channel_id}\n`;
    if (o.status === "already_friends") return `already friends with ${who}\nchannel_id: ${o.channel_id}\n`;
    if (o.status === "pending") return `request pending — ${who} has auto-accept off\nrequest_id: ${o.request_id}\n`;
    return `status: ${o.status}\n`;
  });
}

async function cmdAccept(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in\n"); return 2; }
  const raw = args[0];
  if (!raw) { process.stderr.write("usage: susu accept @handle\n"); return 1; }
  const isAddr = !raw.startsWith("@") && raw.length > 30;
  const body = isAddr ? { address: raw } : { username: raw.replace(/^@/, "") };
  const out = await api<any>(cfg, "/friends/accept", {
    method: "POST", body: JSON.stringify(body),
  });
  return printJsonOrTable(args, out, (o) =>
    `accepted ${fmtHandle(o.friend?.username)}\nchannel_id: ${o.channel_id}\n`,
  );
}

async function cmdFriends(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in\n"); return 2; }
  const sub = args[0] ?? "";
  if (sub === "remove") {
    const raw = args[1];
    if (!raw) { process.stderr.write("usage: susu friends remove @handle\n"); return 1; }
    const isAddr = !raw.startsWith("@") && raw.length > 30;
    const body = isAddr ? { address: raw } : { username: raw.replace(/^@/, "") };
    const out = await api<any>(cfg, "/friends/remove", {
      method: "POST", body: JSON.stringify(body),
    });
    return printJsonOrTable(args.slice(1), out, (o) => `removed channel ${o.channel_id}\n`);
  }

  // default: list friends + pending incoming + pending outgoing
  const [friends, requests, outgoing] = await Promise.all([
    api<{ friends: any[] }>(cfg, "/friends"),
    api<{ requests: any[] }>(cfg, "/friends/requests").catch(() => ({ requests: [] })),
    api<{ requests: any[] }>(cfg, "/friends/requests/outgoing").catch(() => ({ requests: [] })),
  ]);
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify({ friends: friends.friends, incoming: requests.requests, outgoing: outgoing.requests }, null, 2) + "\n");
    return 0;
  }
  // Show only @handles. Address + channel_id + request_id are backend
  // identifiers — users navigate purely via @handle.
  const fLines = friends.friends.length === 0
    ? "  (none)"
    : friends.friends.map((f: any) => `  ${fmtHandle(f.friend_username)}`).join("\n");
  const inLines = requests.requests.length === 0
    ? ""
    : `\npending incoming (use \`susu accept @x\` to accept):\n` +
      requests.requests.map((r: any) => `  ${fmtHandle(r.from_username)}`).join("\n") + "\n";
  const outLines = outgoing.requests.length === 0
    ? ""
    : `\npending outgoing (waiting on the other side to accept):\n` +
      outgoing.requests.map((r: any) => `  ${fmtHandle(r.to_username)}`).join("\n") + "\n";
  process.stdout.write(`friends:\n${fLines}\n${inLines}${outLines}`);
  return 0;
}

// ───────── groups (multi-person channels) ──────────────────────────────────

async function cmdGroup(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in\n"); return 2; }
  const sub = args[0] ?? "";
  const rest = args.slice(1);

  if (sub === "create") {
    // First positional = name (optional). Remaining are @handles to invite.
    const positional = rest.filter((a) => !a.startsWith("-"));
    const name = positional[0] ?? null;
    const invites = positional.slice(1);
    const out = await api<any>(cfg, "/channels", {
      method: "POST", body: JSON.stringify({ name }),
    });
    process.stdout.write(`channel_id: ${out.channel_id}\nowner:      ${out.owner}\n`);
    // Best-effort invite each handle. Resolve @handle → address first.
    for (const handle of invites) {
      const uname = handle.replace(/^@/, "").toLowerCase();
      try {
        const lookup = await api<{ address: string; username: string }>(cfg, `/identity/by-username/${uname}`, { auth: false });
        await api(cfg, `/channels/${out.channel_id}/invite`, {
          method: "POST", body: JSON.stringify({ address: lookup.address }),
        });
        process.stdout.write(`  invited @${uname}\n`);
      } catch (e) {
        process.stderr.write(`  failed to invite @${uname}: ${(e as Error).message}\n`);
      }
    }
    return 0;
  }

  if (sub === "members") {
    const id = rest[0];
    if (!id) { process.stderr.write("usage: susu group members <channel_id>\n"); return 1; }
    const out = await api<{ members: any[] }>(cfg, `/channels/${id}/members`);
    return printJsonOrTable(rest, out, (o) =>
      o.members.map((m: any) =>
        `  ${fmtHandle(m.username).padEnd(22)}  joined=${m.joined_at}`,
      ).join("\n") + "\n",
    );
  }

  if (sub === "invite") {
    const id = rest[0];
    const handle = rest[1];
    if (!id || !handle) { process.stderr.write("usage: susu group invite <channel_id> @handle\n"); return 1; }
    let address = handle;
    if (handle.startsWith("@") || handle.length < 30) {
      const uname = handle.replace(/^@/, "").toLowerCase();
      const lookup = await api<{ address: string }>(cfg, `/identity/by-username/${uname}`, { auth: false });
      address = lookup.address;
    }
    const out = await api(cfg, `/channels/${id}/invite`, {
      method: "POST", body: JSON.stringify({ address }),
    });
    return printJsonOrTable(rest, out, () => `invited ${handle} to ${id}\n`);
  }

  if (sub === "leave") {
    const id = rest[0];
    if (!id) { process.stderr.write("usage: susu group leave <channel_id>\n"); return 1; }
    const out = await api<any>(cfg, `/channels/${id}/leave`, { method: "POST" });
    return printJsonOrTable(rest, out, (o) => {
      if (o.disbanded) return `left ${id} (disbanded — no members left)\n`;
      if (o.ownerHandover) return `left ${id} (ownership auto-elected to ${o.ownerHandover.slice(0, 6)}…)\n`;
      return `left ${id}\n`;
    });
  }

  if (sub === "kick") {
    const id = rest[0];
    const handle = rest[1];
    if (!id || !handle) { process.stderr.write("usage: susu group kick <channel_id> @handle\n"); return 1; }
    let address = handle;
    if (handle.startsWith("@") || handle.length < 30) {
      const uname = handle.replace(/^@/, "").toLowerCase();
      const lookup = await api<{ address: string }>(cfg, `/identity/by-username/${uname}`, { auth: false });
      address = lookup.address;
    }
    const out = await api(cfg, `/channels/${id}/kick`, {
      method: "POST", body: JSON.stringify({ address }),
    });
    return printJsonOrTable(rest, out, (o: any) => `kicked ${o.kicked.slice(0, 6)}… from ${id}\n`);
  }

  if (sub === "transfer-owner") {
    const id = rest[0];
    const handle = rest[1];
    if (!id || !handle) { process.stderr.write("usage: susu group transfer-owner <channel_id> @handle\n"); return 1; }
    const body: any = handle.startsWith("@") || handle.length < 30
      ? { username: handle.replace(/^@/, "") }
      : { candidate_address: handle };
    const out = await api<any>(cfg, `/channels/${id}/transfer-owner`, {
      method: "POST", body: JSON.stringify(body),
    });
    return printJsonOrTable(rest, out, (o) => `new owner of ${o.channel_id}: ${o.new_owner.slice(0, 6)}…\n`);
  }

  process.stderr.write("usage: susu group [create|members|invite|leave|kick|transfer-owner] ...\n");
  return 1;
}

// ───────── channel meta KV (D13 open protocol) ────────────────────────────

async function cmdMeta(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in\n"); return 2; }
  const sub = args[0] ?? "";
  const id = args[1];
  if (!id) { process.stderr.write("usage: susu meta [get|set|patch] <channel_id> [-j JSON]\n"); return 1; }

  if (sub === "get") {
    const out = await api<{ meta: any }>(cfg, `/channels/${id}/meta`);
    return printJsonOrTable(args, out, (o) => JSON.stringify(o.meta, null, 2) + "\n");
  }
  if (sub === "set" || sub === "patch") {
    const jIdx = args.indexOf("-j");
    const altIdx = args.indexOf("--json-body");
    const idx = jIdx >= 0 ? jIdx : altIdx;
    if (idx < 0 || !args[idx + 1]) { process.stderr.write(`usage: susu meta ${sub} <channel_id> -j '<json>'\n`); return 1; }
    let body: any;
    try { body = JSON.parse(args[idx + 1]!); }
    catch (e) { process.stderr.write(`invalid JSON: ${(e as Error).message}\n`); return 1; }
    const method = sub === "set" ? "PUT" : "PATCH";
    const out = await api(cfg, `/channels/${id}/meta`, {
      method, body: JSON.stringify(body),
    });
    return printJsonOrTable(args, out, () => `meta ${sub === "set" ? "replaced" : "merged"} for ${id}\n`);
  }
  process.stderr.write("usage: susu meta [get|set|patch] <channel_id> [-j JSON]\n");
  return 1;
}

async function readPayload(args: string[]): Promise<any> {
  const mIdx = args.findIndex((a) => a === "-m" || a === "--message");
  if (mIdx >= 0) return { text: args[mIdx + 1] ?? "" };
  const jIdx = args.findIndex((a) => a === "-j" || a === "--json");
  if (jIdx >= 0) {
    const s = args[jIdx + 1];
    if (!s) throw new Error("-j requires a JSON string");
    return JSON.parse(s);
  }
  // stdin
  if (process.stdin.isTTY) throw new Error("provide -m TEXT, -j JSON, or pipe via stdin");
  let buf = "";
  for await (const chunk of process.stdin) buf += chunk;
  buf = buf.trim();
  if (!buf) throw new Error("empty stdin");
  try { return JSON.parse(buf); } catch { return { text: buf }; }
}

async function cmdPush(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  const target = args[0];
  if (!target) { process.stderr.write("usage: susu push <@handle | channel_id> [-m TEXT | -j JSON]\n"); return 1; }
  const id = await resolveTargetChannel(cfg, target);
  const payload = await readPayload(args.slice(1));
  try {
    const out = await api<any>(cfg, `/channels/${id}/signals`, {
      method: "POST", body: JSON.stringify(payload),
    });
    return printJsonOrTable(args, out, (o) => {
      const lines = [`signal_id: ${o.signal_id}`, `cost_usd:  ${o.cost_usd}`];
      if (o.allowance_after) {
        const a = o.allowance_after;
        if (a.status === "BETA — free") lines.push(`status:    BETA — free`);
        else lines.push(`allowance: $${Number(a.allowance_usd ?? 0).toFixed(4)} (${a.estimated_calls_remaining ?? "?"} calls remaining)`);
      }
      return lines.join("\n") + "\n";
    });
  } catch (e) {
    if (e instanceof ApiError && e.status === 402) {
      const b = e.body ?? {};
      process.stderr.write(
        `insufficient_allowance: $${Number(b.allowance_usd ?? 0).toFixed(4)} < $${Number(b.required_usd ?? 0).toFixed(4)}\n` +
        `run \`susu approve\` (or open ${b.approve_again_url ?? "https://susurration.xyz/approve"}) to top up.\n`,
      );
      return 1;
    }
    throw e;
  }
}

async function cmdReact(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  const id = args[0];
  if (!id) { process.stderr.write("usage: susu react <signal_id> [-m TEXT | -j JSON]\n"); return 1; }
  const payload = await readPayload(args.slice(1));
  const isAuto = args.includes("--auto");
  try {
    const out = await api<any>(cfg, `/signals/${id}/reactions`, {
      method: "POST", body: JSON.stringify({ payload, is_auto: isAuto }),
    });
    return printJsonOrTable(args, out, (o) => {
      const lines = [`reaction_id: ${o.reaction_id}`, `cost_usd:    ${o.cost_usd}`];
      if (o.allowance_after) {
        const a = o.allowance_after;
        if (a.status === "BETA — free") lines.push(`status:      BETA — free`);
        else lines.push(`allowance:   $${Number(a.allowance_usd ?? 0).toFixed(4)}`);
      }
      return lines.join("\n") + "\n";
    });
  } catch (e) {
    if (e instanceof ApiError && e.status === 402) {
      const b = e.body ?? {};
      process.stderr.write(
        `insufficient_allowance: $${Number(b.allowance_usd ?? 0).toFixed(4)} < $${Number(b.required_usd ?? 0).toFixed(4)}\n` +
        `run \`susu approve\` to top up.\n`,
      );
      return 1;
    }
    throw e;
  }
}

async function cmdSignals(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  const target = args[0];
  if (!target) { process.stderr.write("usage: susu signals <@handle | channel_id>\n"); return 1; }
  const id = await resolveTargetChannel(cfg, target);
  const out = await api<{ signals: any[] }>(cfg, `/channels/${id}/signals?limit=50`);
  return printJsonOrTable(args, out, (o) =>
    o.signals.map((s: any) => {
      const who = s.from_username ? `@${s.from_username}` : "(unregistered)";
      return `${s.created_at}  ${who.padEnd(20)}  ${JSON.stringify(s.payload)}`;
    }).join("\n") + "\n",
  );
}

async function cmdWatch(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  const target = args[0];
  if (!target) { process.stderr.write("usage: susu watch <@handle | channel_id>\n"); return 1; }
  if (!cfg.token) { process.stderr.write("not logged in\n"); return 2; }
  const id = await resolveTargetChannel(cfg, target);
  // R2: mint a single-use stream_token instead of leaking the bearer in URL.
  const st = await api<{ stream_token: string }>(cfg, "/auth/stream-token", { method: "POST" });
  const url = `${cfg.api_url.replace(/\/$/, "")}/channels/${id}/signals/stream?stream_token=${encodeURIComponent(st.stream_token)}`;
  process.stderr.write(`tailing ${id} (Ctrl-C to exit)\n`);
  const resp = await fetch(url);
  if (!resp.ok || !resp.body) {
    process.stderr.write(`stream error: HTTP ${resp.status}\n`);
    return 1;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  // SSE parse: messages separated by blank line, fields prefixed `field: `.
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split(/\r?\n\r?\n/);
    buf = parts.pop() ?? "";
    for (const block of parts) {
      let event = "message", data = "";
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (event === "ping") continue;
      if (event === "open") { process.stderr.write("connected\n"); continue; }
      if (event === "signal" && data) {
        try {
          const e = JSON.parse(data);
          const who = e.from_username ? `@${e.from_username}` : "(unregistered)";
          process.stdout.write(`${e.created_at}  ${who.padEnd(20)}  ${JSON.stringify(e.payload)}\n`);
        } catch { process.stdout.write(data + "\n"); }
      }
    }
  }
  return 0;
}

// ───────── billing (non-custodial: SPL Approve + on-chain delegate) ───────

async function cmdAllowance(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in\n"); return 2; }
  const out = await api<any>(cfg, "/billing/allowance");
  return printJsonOrTable(args, out, (o) => {
    if (o.status === "BETA — free") {
      return (
        `status:  BETA — free (every push and react is free)\n` +
        `(when paid mode flips on, your first push will return 402 + an approve URL)\n`
      );
    }
    return (
      `status:          paid\n` +
      `rate_per_call:   $${o.rate_usd_per_call}\n` +
      `allowance_usd:   $${Number(o.allowance_usd ?? 0).toFixed(4)}\n` +
      `calls_remaining: ${o.estimated_calls_remaining ?? "?"}\n` +
      `cluster:         ${o.cluster}\n` +
      `\nApprove top-up:  ${o.approve_again_url}\n` +
      `(or run: susu approve [<amount_usd>])\n`
    );
  });
}

async function cmdApprove(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in\n"); return 2; }
  const amount = Number(args[0] ?? 100);
  if (!Number.isFinite(amount) || amount <= 0) {
    process.stderr.write("usage: susu approve [<amount_usd=100>]\n"); return 1;
  }
  const out = await api<any>(cfg, "/billing/approve-tx", {
    method: "POST", body: JSON.stringify({ amount_usd: amount }),
  });
  // CLI cannot sign a Solana tx by itself — direct user to the web flow which
  // wraps Phantom signMessage / signAndSendTransaction.
  return printJsonOrTable(args, out, (o) => {
    const url = `https://susurration.xyz/approve?amount=${amount}`;
    return (
      `Approve tx built (base64 ${String(o.tx_b64 ?? "").length}b).\n` +
      `Open the web flow to sign in Phantom:\n  ${url}\n` +
      `(CLI cannot sign Solana txs directly — keypair format differs from Phantom.)\n`
    );
  });
}

async function cmdUsage(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in\n"); return 2; }
  const out = await api<any>(cfg, "/usage?limit=20");
  return printJsonOrTable(args, out, (o) =>
    `total_calls:      ${o.total_calls}\n` +
    `total_cost_usd:   $${Number(o.total_cost_usd).toFixed(4)}\n` +
    `rate_per_call:    $${o.rate_usd_per_call}\n` +
    `\nrecent:\n` +
    o.items.slice(0, 10).map((i: any) =>
      `  ${i.created_at}  ${i.call_type.padEnd(14)}  $${Number(i.cost_usd).toFixed(4)}`,
    ).join("\n") + "\n",
  );
}

// `susu privacy` — toggle whether incoming friend adds auto-create a
// channel (`on`) or queue a request the user must accept (`off`).
// Default for new accounts is `off` (per migration 006). Args:
//   susu privacy            → show current setting + brief explanation
//   susu privacy on         → flip to auto-accept (use only for trusted circles)
//   susu privacy off        → flip back to gate (default)
async function cmdPrivacy(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in\n"); return 2; }
  const sub = (args[0] ?? "").toLowerCase();

  if (!sub) {
    // Show current
    const me = await api<any>(cfg, "/identity/whoami");
    const on = !!me.auto_accept_friends;
    process.stdout.write(
      `auto-accept friends: ${on ? "ON  (anyone can add you and immediately push)" : "OFF (incoming adds queue as requests; you accept manually)"}\n` +
      (on
        ? `\nflip OFF (recommended for most users):  susu privacy off\n`
        : `\nflip ON  (only if you trust everyone in your circle):  susu privacy on\n`),
    );
    return 0;
  }

  if (sub !== "on" && sub !== "off") {
    process.stderr.write("usage: susu privacy [on|off]\n");
    return 1;
  }

  const value = sub === "on";
  const out = await api<any>(cfg, "/identity/auto-accept", {
    method: "POST", body: JSON.stringify({ value }),
  });
  return printJsonOrTable(args, out, () =>
    `auto-accept friends: ${value ? "ON" : "OFF"}\n`,
  );
}

async function cmdConfig(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  // Default human view: just what the user actually controls (api_url,
  // their @handle, session state). The keypair is internal — visible only
  // via --json (which also redacts the private key).
  const safe = {
    ...cfg,
    secret_key_b58: cfg.secret_key_b58 ? "(redacted)" : undefined,
  };
  return printJsonOrTable(args, safe, (s: any) =>
    `api_url:  ${s.api_url}\n` +
    `handle:   ${s.handle ? "@" + s.handle : "(unregistered)"}\n` +
    `session:  ${s.token ? `active until ${s.token_expires_at}` : "(none — run `susu login`)"}\n` +
    `path:     ${CONFIG_PATH}\n`,
  );
}

function printJsonOrTable<T>(args: string[], data: T, tablePrinter: (d: T) => string): number {
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else {
    process.stdout.write(tablePrinter(data));
  }
  return 0;
}
