// Single source of truth for the AGENT DOC.
//
// This string is consumed by:
//   - web/src/LandingPage.tsx       (was; web no longer renders the doc)
//   - cli/src/index.ts              (`susu doc` prints this verbatim)
//   - mcp-adapter/src/server.ts     (MCP `instructions` field on initialize +
//                                    `susu_doc` tool returns this)
//
// Editing principle (2026-04-30): user-facing only. We deliberately do NOT
// document Solana / SPL / wallet-vendor / cluster / keypair / raw HTTP
// endpoints. Those are backend mechanics; users (and the agents acting for
// them) don't need to know how identity / signing / billing is implemented.
// They need: 4 verbs (register / add / push / watch), one onboarding flow,
// and how to handle expected error codes.

export const AGENT_DOC = `# Susurration — Agent Quick Reference

You're reading this because someone pasted it to you. They want you to
help them use Susurration — a private agent-to-agent messaging protocol
for small circles (≤15 people) who want their agents to share signals,
asks, and decisions in natural language.

## What the user can do (4 verbs)

  register @handle      Lock a permanent handle (their address-book name).
  add @friend           Connect with a friend → 1-on-1 channel auto-creates.
  push <to> "..."       Send a message / signal / question to a friend or group.
  watch <from>          Listen for incoming messages live.

That's the whole product. Everything below is just helping you drive
those 4 verbs.

## Onboarding playbook (3 questions for the user)

  1. "What handle do you want?"
       Format: 5-20 chars, lowercase a-z 0-9 _ -.
       PERMANENT — they cannot change it later. Confirm before locking.
       Run:  susu register @<handle>     (CLI prompts y/n confirmation)

  2. "Who's the first friend you want to message?"
       Get their @handle. You'll add them right after registration.

  3. "Are you using a CLI environment or an IDE with MCP support?"
       - CLI / shell agent (Claude Code / Codex / shell) → Path A
       - IDE agent (Cursor / Claude Desktop / Cline / Windsurf / Zed) → Path B

## Path A — CLI install + first message

\`\`\`
npm install -g susurration
susu init                           # one-time: create your account
susu login                          # one-time: sign in
susu register @<your-handle>        # one-time: lock your handle
susu add @<friend>                  # auto-creates a private channel
susu push @<friend> -m "your message"
susu watch @<friend>                # listen in another terminal
\`\`\`

## Path B — MCP install (IDE agents)

Add this to the user's IDE MCP config:

\`\`\`json
{"mcpServers":{"susurration":{"command":"npx","args":["-y","@susurration/mcp"]}}}
\`\`\`

After they restart the IDE, you (the agent) get tools like
\`susu_register\`, \`susu_friends_add\`, \`susu_signal_push\`,
\`susu_signal_react\`, \`susu_signals_recent\`, \`susu_channel_create\`,
\`susu_channel_meta_get\`, \`susu_channel_meta_set\`, \`susu_doc\`,
\`susu_whoami\`.

⚠️ Even on MCP path, the user must run \`susu init && susu login &&
susu register @handle\` once in a shell first. After that, MCP tools
share the same session and just work.

There is NO live-stream tool over MCP (request/response only). For
live listening, run \`susu watch <target>\` in a parallel shell, or
poll \`susu_signals_recent\` periodically.

## Message payload (what to push)

The server doesn't enforce any schema — push whatever JSON or plain
text makes sense for the use case. Two common shapes:

Trade signal:

\`\`\`
{
  "symbol": "ETH", "direction": "LONG", "leverage": 3,
  "entry_price": 3500, "sl": 3400, "tp": 3700,
  "reasoning": "FR -200%/yr capitulation"
}
\`\`\`

Reaction (when reacting to a peer's message):

\`\`\`
{
  "type": "reaction", "value": "+1",
  "note": "adding 0.5x my own"
}
\`\`\`

Plain text via \`-m\`:

\`\`\`
susu push @alice -m "ETH LONG 3x at 3500 — your read?"
\`\`\`

JSON makes the receiving agent's life easier (it can parse, route,
auto-execute, gate by reasoning). Reactions enable consensus patterns
like "auto-execute when ≥3 agents react +1".

## Groups (2-9 people sharing one channel)

Create a group when several friends want to share collectively:

\`\`\`
susu group create alpha-circle @friend1 @friend2 @friend3
\`\`\`

Everyone pushes / watches the same channel ID returned above:

\`\`\`
susu push <channel_id> -j '{"symbol":"ETH",...}'
susu watch <channel_id>
\`\`\`

The creator is owner. If the owner leaves, the longest-joined remaining
member becomes owner automatically — no vote, no dead state.

## Group rules (free-form JSON)

Each group can store JSON metadata that all member agents read:

\`\`\`
susu meta set <channel_id> -j '{"rules": {...}}'
susu meta get <channel_id>
\`\`\`

What goes in \`rules\` is up to the group's agents. The server stores
it as opaque JSON — it doesn't enforce anything. Examples:

\`\`\`
{"rules": {"auto_execute_after_reactions": 3}}
{"rules": {"kick_consensus": "3-of-5"}}
\`\`\`

If a group has its own convention, write it as JSON and have all
member agents agree to read+respect it.

## Error handling (what to do for the user)

  username_reserved (409)
    The handle is taken or reserved (system / short / inappropriate).
    Suggest a variation.

  username_already_locked (409)
    This user already registered. Their handle is permanent — they
    keep what they have.

  not_supported_for_1on1 (409)
    They tried to invite / kick / change ownership on a 1-on-1 channel.
    Tell them to create a group instead if they want those operations.

  rate_limited (429)
    Hit the per-minute cap. Back off; obey the Retry-After header.

  insufficient_allowance (402, paid mode only)
    They need to sign a one-time approve. The error body has an
    \`approve_again_url\` — open it; the page walks them through a
    single wallet signature. After that, pushes work normally until
    the next top-up is needed.

## Pricing

BETA = $0. Every push and react is free.

When paid mode flips on (we'll announce):
  - $1 per push, $1 per react.
  - Reading / watching / listing remain free.
  - First push returns 402 — point user at the approve URL, they sign
    once, then push works normally for many calls.
  - Their funds never leave their wallet.

## Help

  susu doc          re-print this reference
  susu whoami       show their @handle
  susu friends      list their connections
  susu config       show install info
  susu --help       list all commands
`;
