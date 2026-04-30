/**
 * Susurration CLI banner — TypeScript port of susurration_banner.py
 *
 * Exports BANNER_PLAIN, BANNER_DIM, BANNER_256, and printBanner(version).
 * Auto-detects terminal color support; degrades gracefully to plain for pipes/CI.
 *
 * Colors:
 *   - ANSI 240/244/248 for graduated gray breath cloud
 *   - ANSI 38;5;179 for whisper-amber version tag (matches --whisper: #C9A961)
 */

// ─── Plain — no escape codes, safe for pipes, logs, CI, Windows cmd ───────────

export const BANNER_PLAIN = (version: string) =>
  `
    s   s        s
  s     s    s     s
       s  s
       S      /sʊsəˈreɪʃ(ə)n/  v${version}
              trading signal protocol
`;

// ─── 8-color dim — uses \x1b[2m dim + \x1b[0m reset ──────────────────────────
// Compatible with every modern terminal including Windows Terminal

export const BANNER_DIM = (version: string) =>
  "\n" +
  "    \x1b[2ms\x1b[0m   \x1b[2ms\x1b[0m        \x1b[2ms\x1b[0m\n" +
  "  \x1b[2ms     s    s     s\x1b[0m\n" +
  "       \x1b[2ms\x1b[0m  s\n" +
  `       \x1b[1mS\x1b[0m      /sʊsəˈreɪʃ(ə)n/  v${version}\n` +
  "              \x1b[2mtrading signal protocol\x1b[0m\n";

// ─── 256-color — graduated grays + whisper-amber version ─────────────────────
// Compatible with: iTerm2, Alacritty, kitty, Windows Terminal, modern xterm
// 240 = mid gray, 244 = lighter, 248 = lightest, 179 = whisper amber

export const BANNER_256 = (version: string) =>
  "\n" +
  "    \x1b[38;5;248ms\x1b[0m   \x1b[38;5;244ms\x1b[0m        \x1b[38;5;248ms\x1b[0m\n" +
  "  \x1b[38;5;244ms     \x1b[38;5;240ms\x1b[0m    \x1b[38;5;240ms\x1b[0m     \x1b[38;5;248ms\x1b[0m\n" +
  "       \x1b[38;5;240ms\x1b[0m  \x1b[38;5;240ms\x1b[0m\n" +
  `       \x1b[1mS\x1b[0m      \x1b[3m/sʊsəˈreɪʃ(ə)n/\x1b[0m  \x1b[38;5;179mv${version}\x1b[0m\n` +
  "              \x1b[38;5;244mtrading signal protocol\x1b[0m\n";

// ─── Color detection ──────────────────────────────────────────────────────────

type ColorLevel = "plain" | "dim" | "256";

function detectColor(): ColorLevel {
  // Piped / redirected — no escape codes
  if (!process.stdout.isTTY) return "plain";
  if (process.env["NO_COLOR"]) return "plain";

  const colorterm = (process.env["COLORTERM"] ?? "").toLowerCase();
  const term = (process.env["TERM"] ?? "").toLowerCase();

  if (colorterm === "truecolor" || colorterm === "24bit" || term.includes("256")) return "256";
  if (term && term !== "dumb") return "dim";
  return "plain";
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Print the banner to stdout using the best variant for the current terminal.
 * Call once at the top of cmdHelp (or any command that needs the visual header).
 */
export function printBanner(version: string): void {
  const level = detectColor();
  const banner =
    level === "256" ? BANNER_256(version) :
    level === "dim" ? BANNER_DIM(version) :
    BANNER_PLAIN(version);
  process.stdout.write(banner);
}
