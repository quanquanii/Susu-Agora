// susu-bridge — subscribe to a Susurration channel's SSE stream and POST every
// signal to one or more webhooks (OpenClaw / Discord / Slack / Feishu / Telegram).
//
// Config-driven: pass --config path.json with an array of fanout rules, or
// use --channel/--webhook for a single rule. Auto-reconnects on disconnect.
//
// Why a standalone bridge instead of an OpenClaw-only plugin: OpenClaw's
// plugin SDK is one of N runtimes that consume webhooks. By emitting webhooks
// we cover OpenClaw + every webhook-capable messenger out of the box.
// `manifest/openclaw.json` is the OpenClaw-side stub for users who do want
// to install us as an OpenClaw plugin.

import { readFile } from "node:fs/promises";
import { TARGET_FORMATTERS, type FormatterKey, type SusurrationSignal } from "./formatters.ts";

interface FanoutRule {
  channel_id: string;
  webhook_url: string;
  /** which formatter to apply to the payload before POSTing */
  format: FormatterKey;
  /** extra options the formatter needs (e.g. telegram chat_id, openclaw targets) */
  format_opts?: Record<string, unknown>;
  /** optional bearer token / signature header to send with the webhook */
  auth_header?: string;
  /** human label, shown in logs */
  name?: string;
}

interface BridgeConfig {
  api_url: string;
  token: string;
  rules: FanoutRule[];
}

function parseArgs(argv: string[]): { config?: string; rule?: FanoutRule; apiUrl?: string; token?: string } {
  const out: any = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config") out.config = argv[++i];
    else if (a === "--api-url") out.apiUrl = argv[++i];
    else if (a === "--token") out.token = argv[++i];
    else if (a === "--channel") (out.rule ??= {} as FanoutRule).channel_id = argv[++i]!;
    else if (a === "--webhook") (out.rule ??= {} as FanoutRule).webhook_url = argv[++i]!;
    else if (a === "--format") (out.rule ??= {} as FanoutRule).format = argv[++i] as FormatterKey;
    else if (a === "--auth-header") (out.rule ??= {} as FanoutRule).auth_header = argv[++i];
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`susu-bridge — fan out Susurration signals to webhooks

Usage:
  susu-bridge --config bridge.config.json
  susu-bridge --api-url URL --token TOKEN --channel ID --webhook URL --format <openclaw|discord|slack|feishu|telegram|raw>

Env:
  SUSU_API_URL, SUSU_TOKEN — defaults if --api-url / --token not given.

Config file shape (.json):
  {
    "api_url": "https://susurration.xyz/api",
    "token": "<bearer from susu login>",
    "rules": [
      { "name": "team-discord", "channel_id": "...", "webhook_url": "https://discord.com/api/webhooks/...", "format": "discord" },
      { "name": "team-feishu",  "channel_id": "...", "webhook_url": "https://open.feishu.cn/...", "format": "feishu" }
    ]
  }
`);
}

async function loadConfig(args: ReturnType<typeof parseArgs>): Promise<BridgeConfig> {
  if (args.config) {
    const raw = await readFile(args.config, "utf8");
    return JSON.parse(raw) as BridgeConfig;
  }
  const apiUrl = args.apiUrl ?? process.env.SUSU_API_URL;
  const token = args.token ?? process.env.SUSU_TOKEN;
  if (!apiUrl || !token) throw new Error("missing --api-url / --token (or SUSU_API_URL / SUSU_TOKEN env)");
  if (!args.rule || !args.rule.channel_id || !args.rule.webhook_url || !args.rule.format) {
    throw new Error("missing --channel / --webhook / --format for single-rule mode");
  }
  return { api_url: apiUrl, token, rules: [args.rule] };
}

async function fanout(rule: FanoutRule, sig: SusurrationSignal): Promise<void> {
  const fmt = TARGET_FORMATTERS[rule.format];
  if (!fmt) throw new Error(`unknown formatter: ${rule.format}`);
  const body = fmt(sig, rule.format_opts ?? {});
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (rule.auth_header) {
    // Caller-supplied "Header-Name: value" string. Allow ":" anywhere after the name.
    const idx = rule.auth_header.indexOf(":");
    if (idx > 0) headers[rule.auth_header.slice(0, idx).trim()] = rule.auth_header.slice(idx + 1).trim();
  }
  const resp = await fetch(rule.webhook_url, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error(`[${rule.name ?? rule.format}] webhook ${resp.status}: ${text.slice(0, 200)}`);
    return;
  }
  console.log(`[${rule.name ?? rule.format}] sent ${sig.signal_id.slice(0, 8)}…`);
}

async function streamChannel(cfg: BridgeConfig, channelId: string, abortSignal: AbortSignal) {
  const rulesForChannel = cfg.rules.filter((r) => r.channel_id === channelId);
  console.log(`[${channelId.slice(0, 8)}…] subscribing — ${rulesForChannel.length} fanout rule(s)`);

  while (!abortSignal.aborted) {
    try {
      // R2: mint a fresh single-use stream_token for each (re)connect attempt.
      const stResp = await fetch(`${cfg.api_url.replace(/\/$/, "")}/auth/stream-token`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
      });
      if (!stResp.ok) {
        console.error(`[${channelId.slice(0, 8)}…] stream-token mint ${stResp.status} — retrying in 5s`);
        await sleep(5000);
        continue;
      }
      const { stream_token } = (await stResp.json()) as { stream_token: string };
      const url = `${cfg.api_url.replace(/\/$/, "")}/channels/${channelId}/signals/stream?stream_token=${encodeURIComponent(stream_token)}`;
      const resp = await fetch(url, { signal: abortSignal });
      if (!resp.ok || !resp.body) {
        console.error(`[${channelId.slice(0, 8)}…] stream ${resp.status} — retrying in 5s`);
        await sleep(5000);
        continue;
      }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (!abortSignal.aborted) {
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
          if (event !== "signal" || !data) continue;
          let sig: SusurrationSignal;
          try { sig = JSON.parse(data) as SusurrationSignal; } catch { continue; }
          for (const rule of rulesForChannel) {
            fanout(rule, sig).catch((e) => console.error(`[${rule.name ?? rule.format}] fanout error:`, e.message));
          }
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      console.error(`[${channelId.slice(0, 8)}…] stream error: ${(e as Error).message} — retrying in 5s`);
      await sleep(5000);
    }
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = await loadConfig(args);
  if (cfg.rules.length === 0) throw new Error("no fanout rules configured");

  const channels = Array.from(new Set(cfg.rules.map((r) => r.channel_id)));
  const ctrl = new AbortController();

  process.on("SIGINT", () => { console.log("\nshutting down…"); ctrl.abort(); });
  process.on("SIGTERM", () => ctrl.abort());

  await Promise.all(channels.map((id) => streamChannel(cfg, id, ctrl.signal)));
}

main().catch((e) => {
  console.error("fatal:", e.message);
  process.exit(1);
});
