"""Susurration Python SDK.

Mirrors the TS SDK at @susurration/sdk; same auth flow, same endpoint shapes.

Quickstart::

    import os
    from susurration import SusuClient, InsufficientAllowanceError

    with SusuClient(
        api_url="https://susurration.xyz/api",
        secret_key_b58=os.environ["SUSU_SECRET"],
        address=os.environ["SUSU_ADDRESS"],
    ) as susu:
        susu.login()
        susu.register("@your-handle")          # one-time, permanent

        # Path A — 1-on-1
        added = susu.friends_add(username="@alice")
        susu.push_signal(added["channel_id"], {
            "symbol": "ETH", "direction": "LONG", "leverage": 3,
            "entry_price": 3500, "sl": 3400, "tp": 3700,
        })

        # Path B — group
        ch = susu.create_channel("alpha-circle")
        susu.invite(ch["channel_id"], "<peer wallet address>")

        # receive
        for sig in susu.stream_signals(added["channel_id"]):
            print(sig["from_address"], sig["payload"])

For the full reference (endpoints, payload shapes, onboarding playbook,
error codes, pricing) install the CLI and run ``susu doc``.
"""
from .client import SusuClient
from .errors import SusurrationError, InsufficientAllowanceError

__all__ = ["SusuClient", "SusurrationError", "InsufficientAllowanceError"]
__version__ = "0.0.2"
