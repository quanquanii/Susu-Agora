"""susu-codex-tools CLI — prints the OpenAI tools schema as JSON.

Useful for piping into Codex / a custom agent's tool registry without
importing Python: ``susu-codex-tools > tools.json``.
"""
import json
import sys

from .tools import TOOLS


def print_tools_json() -> None:
    json.dump(TOOLS, sys.stdout, indent=2)
    sys.stdout.write("\n")
