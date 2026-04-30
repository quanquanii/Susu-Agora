// Per-target payload shapers. Each formatter takes a raw Susurration signal
// and returns the JSON body for that messaging webhook.
//
// Adding a new target = add a function here + a key in TARGET_FORMATTERS.

export interface SusurrationSignal {
  signal_id: string;
  channel_id: string;
  from_address: string;
  payload: any;
  created_at: string;
}

export type FormatterKey =
  | "openclaw"
  | "discord"
  | "slack"
  | "feishu"
  | "telegram"
  | "raw";

export type Formatter = (sig: SusurrationSignal, opts?: any) => any;

function shortAddr(addr: string): string {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function humanPayload(p: any): string {
  if (typeof p === "string") return p;
  if (p && typeof p === "object" && typeof p.text === "string") return p.text;
  // Shape into one-line summary for structured signals (signal-template-v0.1).
  if (p && typeof p === "object" && p.symbol && p.direction) {
    const tps = Array.isArray(p.tp) ? p.tp.join("/") : p.tp;
    return [
      `${p.symbol} ${String(p.direction).toUpperCase()}`,
      p.leverage ? `${p.leverage}x` : null,
      p.entry_price ? `entry ${p.entry_price}` : null,
      p.sl ? `SL ${p.sl}` : null,
      tps ? `TP ${tps}` : null,
      p.reasoning ? `· ${p.reasoning}` : null,
    ].filter(Boolean).join(" ");
  }
  return JSON.stringify(p);
}

// OpenClaw multi-channel send payload — generic envelope; OpenClaw plugin
// receives this and re-routes by `targets`. Shape is conservative since
// OpenClaw plugin SDK signatures may evolve.
export const formatOpenclaw: Formatter = (sig, opts: { targets?: string[] } = {}) => ({
  source: "susurration",
  signal_id: sig.signal_id,
  channel_id: sig.channel_id,
  from: sig.from_address,
  text: humanPayload(sig.payload),
  payload: sig.payload,
  created_at: sig.created_at,
  // Optional: plugin can read this to fan out further.
  targets: opts.targets,
});

// Discord incoming webhook
export const formatDiscord: Formatter = (sig) => ({
  username: "Susurration",
  content: `**${shortAddr(sig.from_address)}** · ${humanPayload(sig.payload)}`,
});

// Slack incoming webhook
export const formatSlack: Formatter = (sig) => ({
  text: `*${shortAddr(sig.from_address)}* — ${humanPayload(sig.payload)}`,
  attachments: [
    { footer: `signal_id ${sig.signal_id.slice(0, 8)} · ${sig.created_at}` },
  ],
});

// Feishu (Lark) custom bot incoming webhook
export const formatFeishu: Formatter = (sig) => ({
  msg_type: "text",
  content: { text: `[${shortAddr(sig.from_address)}] ${humanPayload(sig.payload)}` },
});

// Telegram bot sendMessage — caller passes chat_id via opts
export const formatTelegram: Formatter = (sig, opts: { chat_id?: string | number } = {}) => ({
  chat_id: opts.chat_id,
  text: `*${shortAddr(sig.from_address)}* — ${humanPayload(sig.payload)}`,
  parse_mode: "Markdown",
});

// Raw passthrough — useful when the target is a custom webhook that wants the full Susurration object.
export const formatRaw: Formatter = (sig) => sig;

export const TARGET_FORMATTERS: Record<FormatterKey, Formatter> = {
  openclaw: formatOpenclaw,
  discord: formatDiscord,
  slack: formatSlack,
  feishu: formatFeishu,
  telegram: formatTelegram,
  raw: formatRaw,
};
