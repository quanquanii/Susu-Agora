// Normalize incoming signal payloads to the canonical Susurration schema.
//
// External trading systems use different field names for the same concepts.
// This layer maps common aliases to canonical names so the daemon's LLM
// and paper trading see a consistent shape.

export interface NormalizeResult {
  payload: Record<string, unknown>;
  warnings: string[];
}

const TOP_ALIASES: Record<string, string> = {
  symbol: "token",
  ticker: "token",
  pair: "token",
  side: "direction",
  dir: "direction",
};

const META_ALIASES: Record<string, string> = {
  sl: "stop_loss",
  stoploss: "stop_loss",
  stop: "stop_loss",
  tp: "take_profit",
  takeprofit: "take_profit",
  target: "take_profit",
  tp2: "take_profit_2",
  entry: "entry_price",
  price: "entry_price",
  lev: "leverage",
};

export function normalizeSignalPayload(raw: Record<string, unknown>): NormalizeResult {
  const warnings: string[] = [];
  const out: Record<string, unknown> = { ...raw };

  // Top-level alias mapping
  for (const [alias, canonical] of Object.entries(TOP_ALIASES)) {
    if (out[alias] !== undefined && out[canonical] === undefined) {
      out[canonical] = out[alias];
      delete out[alias];
    }
  }

  // Metadata alias mapping
  if (out.metadata && typeof out.metadata === "object") {
    const meta = { ...(out.metadata as Record<string, unknown>) };
    for (const [alias, canonical] of Object.entries(META_ALIASES)) {
      if (meta[alias] !== undefined && meta[canonical] === undefined) {
        meta[canonical] = meta[alias];
        delete meta[alias];
      }
    }
    // Flatten: if entry_price is top-level but not in metadata, copy down
    if (meta.entry_price === undefined && typeof out.entry_price === "number") {
      meta.entry_price = out.entry_price;
    }
    out.metadata = meta;
  } else if (out.entry_price !== undefined || out.stop_loss !== undefined || out.take_profit !== undefined) {
    // No metadata object but trade fields at top level — wrap into metadata
    const meta: Record<string, unknown> = {};
    for (const key of ["entry_price", "stop_loss", "take_profit", "leverage", "time_stop_hours", "position_pct"]) {
      if (out[key] !== undefined) {
        meta[key] = out[key];
      }
    }
    // Also check aliases at top level
    for (const [alias, canonical] of Object.entries(META_ALIASES)) {
      if (out[alias] !== undefined && meta[canonical] === undefined) {
        meta[canonical] = out[alias];
      }
    }
    if (Object.keys(meta).length > 0) {
      out.metadata = meta;
    }
  }

  // Validate required fields for paper trading
  if (!out.token) {
    warnings.push("missing token/symbol");
  }
  const meta = (out.metadata ?? {}) as Record<string, unknown>;
  if (!meta.entry_price || typeof meta.entry_price !== "number") {
    warnings.push("missing metadata.entry_price (paper trading will skip)");
  }

  return { payload: out, warnings };
}
