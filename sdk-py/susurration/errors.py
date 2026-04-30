"""Errors raised by SusuClient."""
from __future__ import annotations

from typing import Any


class SusurrationError(Exception):
    """Non-2xx response from the API."""

    def __init__(self, status: int, body: Any, path: str) -> None:
        self.status = status
        self.body = body
        self.path = path
        super().__init__(f"HTTP {status} {path}: {body!r}")


class InsufficientAllowanceError(SusurrationError):
    """402 — caller's on-chain SPL allowance is below the per-call rate.

    Catch separately to surface a "sign an Approve in Phantom" prompt to the
    user. ``approve_again_url`` is the web flow that builds + signs the tx.
    """

    def __init__(
        self,
        allowance_usd: float,
        required_usd: float,
        approve_again_url: str | None,
        path: str,
    ) -> None:
        self.allowance_usd = allowance_usd
        self.required_usd = required_usd
        self.approve_again_url = approve_again_url
        super().__init__(
            402,
            {
                "error": "insufficient_allowance",
                "allowance_usd": allowance_usd,
                "required_usd": required_usd,
                "approve_again_url": approve_again_url,
            },
            path,
        )
