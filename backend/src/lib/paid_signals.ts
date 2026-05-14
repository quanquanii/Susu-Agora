import { sql } from "../db.ts";

type JsonObject = Record<string, unknown>;
type PaidSignalViewerRole = "author" | "buyer" | "locked";
type SignalVisibilityRow = {
  signal_id: string;
  from_address: string;
  payload: unknown;
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Paid-signal read model:
// - Writers store both public_payload and private_payload in signals.payload.
// - Authors always see the full payload.
// - pay_to_reveal buyers with a paid purchase see the full payload.
// - Everyone else gets only public sale metadata + public_payload.
export function isLockedSignalPayload(payload: unknown): payload is JsonObject & { locked: true } {
  return isJsonObject(payload) && payload.locked === true;
}

function isPayToRevealSignalPayload(
  payload: unknown,
): payload is JsonObject & { locked: true; unlock_policy: "pay_to_reveal" } {
  return isLockedSignalPayload(payload) && payload.unlock_policy === "pay_to_reveal";
}

function buildLockedSignalEnvelope(
  payload: JsonObject & { locked: true },
  viewerRole: PaidSignalViewerRole,
  purchased: boolean,
): JsonObject {
  if (viewerRole === "author" || viewerRole === "buyer") {
    return { ...payload, purchased, viewer_role: viewerRole };
  }

  const clipped: JsonObject = {
    locked: true,
    purchased,
    viewer_role: viewerRole,
    public_payload: isJsonObject(payload.public_payload) ? payload.public_payload : {},
  };
  if (typeof payload.price === "string") clipped.price = payload.price;
  if (typeof payload.currency === "string") clipped.currency = payload.currency;
  if (typeof payload.unlock_policy === "string") clipped.unlock_policy = payload.unlock_policy;
  if (typeof payload.expires_at === "string") clipped.expires_at = payload.expires_at;
  return clipped;
}

export function clipSignalPayloadForViewer(
  payload: unknown,
  viewerAddress: string,
  authorAddress: string,
  opts: { hasPaidPurchase?: boolean } = {},
): unknown {
  if (!isLockedSignalPayload(payload)) return payload;
  const hasPaidPurchase = opts.hasPaidPurchase === true;

  if (isPayToRevealSignalPayload(payload)) {
    if (viewerAddress === authorAddress) {
      return buildLockedSignalEnvelope(payload, "author", false);
    }
    if (hasPaidPurchase) {
      return buildLockedSignalEnvelope(payload, "buyer", true);
    }
    return buildLockedSignalEnvelope(payload, "locked", false);
  }
  if (viewerAddress === authorAddress) return payload;

  // Non-authors only get the sale metadata plus the teaser/public payload.
  const clipped: JsonObject = {
    locked: true,
    public_payload: isJsonObject(payload.public_payload) ? payload.public_payload : {},
  };
  if (typeof payload.price === "string") clipped.price = payload.price;
  if (typeof payload.currency === "string") clipped.currency = payload.currency;
  if (payload.unlock_policy === "pay_to_reveal") clipped.unlock_policy = payload.unlock_policy;
  if (typeof payload.expires_at === "string") clipped.expires_at = payload.expires_at;
  return clipped;
}

export function clipSignalEventForViewer<T extends { kind: "signal"; from_address: string; payload: unknown }>(
  event: T,
  viewerAddress: string,
): T {
  // Preserve the outer event shape; only payload visibility changes by viewer.
  const payload = clipSignalPayloadForViewer(event.payload, viewerAddress, event.from_address);
  return payload === event.payload ? event : { ...event, payload };
}

export async function loadPaidPurchaseSignalIdsForViewer(
  viewerAddress: string,
  rows: SignalVisibilityRow[],
): Promise<Set<string>> {
  const candidates = rows.filter((row) =>
    row.from_address !== viewerAddress &&
    typeof row.signal_id === "string" &&
    isPayToRevealSignalPayload(row.payload)
  );
  if (candidates.length === 0) return new Set();

  const viewerRows = await sql<{ username: string | null }[]>`
    SELECT username FROM identities WHERE address = ${viewerAddress}
  `;
  const viewerUsername = viewerRows[0]?.username ?? null;
  if (!viewerUsername) return new Set();

  const buyerHandle = `@${viewerUsername}`;
  const signalIds = [...new Set(candidates.map((row) => row.signal_id))];
  const purchaseRows = await sql<{ signal_id: string }[]>`
    SELECT signal_id
    FROM purchases
    WHERE buyer_handle = ${buyerHandle}
      AND status = 'paid'
      AND signal_id IN ${sql(signalIds)}
  `;
  return new Set(purchaseRows.map((row) => row.signal_id));
}
