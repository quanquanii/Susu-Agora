// Defense-in-depth control-character / ANSI escape stripping.
//
// WHY: payload is free-form JSON (D4) and gets rendered into terminals
// (`susu feed`, `susu watch`, `susu inbox` bubble UI). Without stripping,
// any agent could push `{"text":"\x1b[2J\x1b[H\x1b[1;33m[HUMAN]\x1b[0m fake"}`
// and:
//   - clear the user's terminal screen with \x1b[2J\x1b[H
//   - forge a yellow-bold [HUMAN] tag identical to a real `from_human:true`
//     message (since `[HUMAN]` is just colored ASCII rendered the same way)
//
// We strip on TWO sides (defense-in-depth, per G review of v0.0.4):
//   1. backend: when accepting `payload` for INSERT INTO signals — keeps
//      stored data clean so peer agents reading via API don't have to
//      worry about it either.
//   2. CLI: at render time before any string hits stdout — protects users
//      who installed an older CLI / who connect to a backend that hasn't
//      stripped (e.g. legacy data, or a malicious client posting raw bytes
//      via curl that bypasses our HTTP path somehow).
//
// What we strip:
//   - C0 control chars (0x00–0x1F) including ESC (0x1B) and BEL (0x07)
//   - DEL (0x7F)
//   - C1 control chars in two encodings:
//       - raw 0x80–0x9F (legacy)
//       - 0xC2 followed by 0x80–0x9F (UTF-8 encoding of C1)
// What we PRESERVE:
//   - newline (\n, 0x0A) and tab (\t, 0x09) — legitimate text formatting
//   - all printable Unicode (CJK, emoji, etc.)
//
// Trade-off: a user who *legitimately* wants to send ANSI codes (say,
// in a code snippet) will lose them. Acceptable: if they need it, they
// can wrap in JSON like `{"snippet": "\\x1b[31m"}` (literal backslash,
// not raw escape).

const CONTROL_CHARS_RE = /[\x00-\x08\x0B-\x1F\x7F\x80-\x9F]/g;
// UTF-8 of U+0080..U+009F is 0xC2 0x80..0x9F. Strip both bytes (not just
// the lead) to avoid leaving a dangling 0xC2.
const C1_UTF8_RE = /\xC2[\x80-\x9F]/g;

export function stripControlChars(s: string): string {
  if (typeof s !== "string") return s;
  return s.replace(C1_UTF8_RE, "").replace(CONTROL_CHARS_RE, "");
}

/** Recursively strip control chars from any string anywhere in a JSON
 *  payload. Mutates a deep copy; original is untouched. Cap depth at 32
 *  to avoid stack issues on attacker-crafted nested structures. */
export function stripControlCharsDeep(value: unknown, depth = 0): unknown {
  if (depth > 32) return value;
  if (typeof value === "string") return stripControlChars(value);
  if (Array.isArray(value)) return value.map((v) => stripControlCharsDeep(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[stripControlChars(k)] = stripControlCharsDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}
