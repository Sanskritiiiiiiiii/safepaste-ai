"""
SafePaste AI — Python worker.

Long-lived process spawned by the VS Code extension (see Option C in
ARCHITECTURE.md). Speaks JSON Lines over stdin/stdout: one JSON object per
line in, one JSON object per line out.

Handles three message types so far: "ping" (Milestone 0, proves the pipe
works), "index" and "check_duplicates" (Milestone 2, semantic duplicate
detection via sentence-transformers + ChromaDB — see handlers.py).

This file's own job is narrow on purpose: route `type` to a handler
function and keep the process alive. It has no idea what embeddings or
vector search are — that's handlers.py's job, imported lazily inside those
handlers so this file starts instantly regardless of whether the ML
dependencies are installed yet.
"""

import json
import sys

from handlers import handle_index, handle_check_duplicates


def handle_ping(payload: dict) -> dict:
    """Milestone 0's handler. Echoes back what it received."""
    return {
        "pong": True,
        "received": payload.get("message", ""),
    }


# type -> handler. Adding a new feature means adding one entry here and one
# handler function — the transport loop below never changes.
HANDLERS = {
    "ping": handle_ping,
    "index": handle_index,
    "check_duplicates": handle_check_duplicates,
}


def make_error(message_id, code: str, message: str) -> dict:
    return {
        "id": message_id,
        "ok": False,
        "error": {"code": code, "message": message},
    }


def handle_line(line: str) -> dict:
    try:
        request = json.loads(line)
    except json.JSONDecodeError as exc:
        # No id available since we couldn't even parse the envelope.
        return make_error(None, "PARSE_ERROR", str(exc))

    message_id = request.get("id")
    msg_type = request.get("type")
    payload = request.get("payload", {})

    handler = HANDLERS.get(msg_type)
    if handler is None:
        return make_error(message_id, "UNKNOWN_TYPE", f"No handler for type '{msg_type}'")

    try:
        result = handler(payload)
    except Exception as exc:  # noqa: BLE001 - deliberately broad: any handler
        # bug should come back as a structured error, not kill the process.
        return make_error(message_id, "HANDLER_ERROR", str(exc))

    return {"id": message_id, "ok": True, "result": result}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        response = handle_line(line)
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()  # critical: without this, output sits in a
        # buffer and the extension hangs waiting for a reply that already
        # "happened" from Python's point of view.


if __name__ == "__main__":
    main()
