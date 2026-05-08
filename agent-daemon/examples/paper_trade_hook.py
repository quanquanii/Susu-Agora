#!/usr/bin/env python3
"""
Example on_decision hook — paper trading adapter.

Reads daemon decision JSON from stdin. Opens a paper trade when:
  - decision.kind == "react"
  - decision.payload.value == "+1"
  - decision.payload.size_factor >= MIN_SIZE_FACTOR

The daemon fires this script automatically on every decision — no separate
long-running process needed.

Usage in agent-config.json:
  "on_decision": "python3 ~/examples/paper_trade_hook.py"

Customize this file for your own trading system (live broker API, DEX
swap, alert webhook, etc.). The stdin JSON schema is stable.
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

MIN_SIZE_FACTOR = 0.5
TRADES_FILE = Path.home() / ".susu" / "paper_trades.json"
LOG_FILE = Path.home() / ".susu" / "paper_hook.log"


def log(msg: str) -> None:
    line = f"[{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}] {msg}"
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a") as f:
        f.write(line + "\n")


def load_book() -> dict:
    if TRADES_FILE.exists():
        return json.loads(TRADES_FILE.read_text())
    return {"balance": 100.0, "trades": []}


def save_book(book: dict) -> None:
    TRADES_FILE.write_text(json.dumps(book, indent=2))


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        return 0

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        log(f"invalid JSON on stdin: {raw[:200]}")
        return 1

    decision = data.get("decision", {})
    trigger = data.get("trigger", {})

    # Only act on react +1 with sufficient conviction.
    if decision.get("kind") != "react":
        return 0
    payload = decision.get("payload", {})
    if payload.get("value") != "+1":
        return 0
    sf = payload.get("size_factor", 0)
    if not isinstance(sf, (int, float)) or sf < MIN_SIZE_FACTOR:
        return 0

    # Extract trade params from the triggering signal.
    sig_payload = trigger.get("payload", {})
    token = sig_payload.get("token")
    direction = sig_payload.get("direction", "long")
    peer = trigger.get("from_username") or "?"

    if not token:
        log("no token in trigger payload, skip")
        return 0

    # Open paper trade.
    book = load_book()
    trade_id = f"{len(book['trades']) + 1:03d}"
    trade = {
        "id": trade_id,
        "token": token,
        "direction": direction,
        "size_factor": sf,
        "peer": peer,
        "signal_id": decision.get("signal_id"),
        "opened_at": datetime.now(timezone.utc).isoformat(),
        "status": "open",
    }
    book["trades"].append(trade)
    save_book(book)
    log(f"OPEN #{trade_id} {token} {direction} sf={sf} from {'@' + peer if not peer.startswith('@') else peer}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
