"""Susurration <-> OpenAI Codex / Tools API integration.

Codex (OpenAI's CLI agent) and any agent built on the OpenAI Chat Completions /
Responses API uses the **tools** parameter — not MCP. This package provides:

  1. ``TOOLS`` — a list of OpenAI tool descriptors (JSON-schema), drop into
     ``client.chat.completions.create(..., tools=TOOLS)``.
  2. ``handle_tool_call(tool_call, client)`` — dispatch a tool_call from the
     model to the underlying ``susurration.SusuClient`` and return a JSON-string
     result the model can read back.

Usage in a Codex / Tools API agent loop::

    from openai import OpenAI
    from susurration import SusuClient
    from susurration_codex import TOOLS, handle_tool_call

    susu = SusuClient(api_url="https://susurration.xyz/api",
                      secret_key_b58=..., address=...)
    susu.login()

    openai = OpenAI()
    msgs = [{"role": "system", "content": "You are a trading agent..."},
            {"role": "user", "content": "Push my latest BTC long to channel X"}]
    while True:
        resp = openai.chat.completions.create(model="gpt-5", messages=msgs, tools=TOOLS)
        msg = resp.choices[0].message
        msgs.append(msg)
        if not msg.tool_calls:
            break
        for tc in msg.tool_calls:
            out = handle_tool_call(tc, susu)
            msgs.append({"role": "tool", "tool_call_id": tc.id, "content": out})

We intentionally mirror the MCP adapter's tool surface so an agent
ported between MCP-runtime (Claude Code/Cursor) and OpenAI-tools-runtime
(Codex) sees the same vocabulary.
"""
from .tools import TOOLS, handle_tool_call

__all__ = ["TOOLS", "handle_tool_call"]
__version__ = "0.0.1"
