type JsonObject = Record<string, unknown>;

export type LockedSignalSkipInfo = {
  signal_id: string;
  price: string | null;
  currency: string | null;
};

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asDisplayValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function getLockedSignalSkipInfo(evt: unknown): LockedSignalSkipInfo | null {
  if (!isRecord(evt) || evt.kind !== "signal") return null;
  const payload = isRecord(evt.payload) ? evt.payload : null;
  if (!payload || payload.locked !== true) return null;
  if (isRecord(payload.private_payload)) return null;

  return {
    signal_id: typeof evt.signal_id === "string" ? evt.signal_id : "",
    price: asDisplayValue(payload.price),
    currency: typeof payload.currency === "string" && payload.currency.trim()
      ? payload.currency.trim()
      : null,
  };
}
