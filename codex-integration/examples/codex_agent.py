"""Reference implementation of a Codex / Tools API agent loop using Susurration.

Run after `pip install openai susurration susurration-codex` and:
    export OPENAI_API_KEY=...
    export SUSU_API_URL=https://susurration.xyz/api
    export SUSU_ADDRESS=...
    export SUSU_SECRET=...   # base58 64-byte secret key (Phantom export)
    python codex_agent.py "look at recent signals in channel <id> and react if you'd take the trade"
"""
from __future__ import annotations

import os
import sys

from openai import OpenAI
from susurration import SusuClient
from susurration_codex import TOOLS, handle_tool_call


SYSTEM_PROMPT = """You are a trading agent for the user. The user runs perpetual
futures trades and shares signals with friends through Susurration. Your tools
let you read recent channel activity, push signals, react to peers, manage
group meta-rules, and check the on-chain SPL allowance. Keep reactions short
(one-sentence rationale + "agree"/"disagree"). Never push a signal unless the
user asked for one. Cost: BETA = free; paid = $1 per push or $1 per react
(D5 atomic). Call susu_doc if you need the full reference."""


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: codex_agent.py <prompt>", file=sys.stderr)
        return 1
    user_prompt = " ".join(sys.argv[1:])

    susu = SusuClient(
        api_url=os.environ["SUSU_API_URL"],
        address=os.environ["SUSU_ADDRESS"],
        secret_key_b58=os.environ["SUSU_SECRET"],
    )
    susu.login()

    openai = OpenAI()
    messages: list = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt},
    ]

    while True:
        resp = openai.chat.completions.create(
            model=os.environ.get("OPENAI_MODEL", "gpt-5"),
            messages=messages,
            tools=TOOLS,
        )
        msg = resp.choices[0].message
        messages.append(msg)
        if not msg.tool_calls:
            print(msg.content)
            return 0
        for tc in msg.tool_calls:
            content = handle_tool_call(tc, susu)
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": content})


if __name__ == "__main__":
    sys.exit(main())
