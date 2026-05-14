type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Step 1 security model for paid signals:
// - Writers may store both public_payload and private_payload in signals.payload.
// - Read paths must clip private_payload unless the viewer is the signal author.
// - Purchase-based reveal is intentionally absent here; that arrives in a later step.
export function isLockedSignalPayload(payload: unknown): payload is JsonObject & { locked: true } {
  return isJsonObject(payload) && payload.locked === true;
}

export function clipSignalPayloadForViewer(
  payload: unknown,
  viewerAddress: string,
  authorAddress: string,
): unknown {
  if (!isLockedSignalPayload(payload)) return payload;
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
