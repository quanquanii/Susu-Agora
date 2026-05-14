import { createHmac, randomBytes } from "node:crypto";
import { sql } from "../db.ts";
import { clipSignalEventForViewer } from "./paid_signals.ts";

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

export function signPayload(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export async function deliverWebhook(
  address: string,
  event: Record<string, unknown>,
): Promise<void> {
  const rows = await sql<{ webhook_url: string; webhook_secret: string }[]>`
    SELECT webhook_url, webhook_secret FROM identities
    WHERE address = ${address} AND webhook_url IS NOT NULL
  `;
  if (!rows.length) return;
  const { webhook_url, webhook_secret } = rows[0]!;

  // Webhook delivery is also an API egress path; paid signals must be clipped
  // with the same viewer-specific rule as feed/SSE responses.
  const clippedEvent =
    event.kind === "signal" && typeof event.from_address === "string"
      ? clipSignalEventForViewer(event as any, address)
      : event;
  const body = JSON.stringify(clippedEvent);
  const signature = signPayload(webhook_secret, body);

  fetch(webhook_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Susu-Signature": signature,
      "X-Susu-Event": String(clippedEvent.kind ?? "unknown"),
    },
    body,
    signal: AbortSignal.timeout(10_000),
  }).catch((e: unknown) => {
      console.warn(`[webhook] delivery failed: ${(e as Error).message ?? e}`);
    });
}

export async function deliverToChannelMembers(
  channelId: string,
  senderAddress: string,
  event: Record<string, unknown>,
): Promise<void> {
  const members = await sql<{ address: string; webhook_url: string; webhook_secret: string }[]>`
    SELECT cm.address, i.webhook_url, i.webhook_secret FROM channel_members cm
    JOIN identities i ON i.address = cm.address
    WHERE cm.channel_id = ${channelId}
      AND cm.address != ${senderAddress}
      AND i.webhook_url IS NOT NULL
  `;
  for (const m of members) {
    // Each recipient gets a payload clipped for that recipient's address.
    const clippedEvent =
      event.kind === "signal" && typeof event.from_address === "string"
        ? clipSignalEventForViewer(event as any, m.address)
        : event;
    const body = JSON.stringify(clippedEvent);
    const signature = signPayload(m.webhook_secret, body);
    fetch(m.webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Susu-Signature": signature,
        "X-Susu-Event": String(clippedEvent.kind ?? "unknown"),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    }).catch((e: unknown) => {
      console.warn(`[webhook] delivery failed: ${(e as Error).message ?? e}`);
    });
  }
}
