"""Minimal MCP (Model Context Protocol) JSON-RPC handling over HTTP."""

import json

PROTOCOL_VERSION = "2025-06-18"


def _ok(msg_id, result):
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def _err(msg_id, code, message):
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


def handle_mcp_payload(body, ctx):
    """ctx needs: list_tools() -> [tool dicts], call_tool(name, args) -> dict"""
    messages = body if isinstance(body, list) else [body]
    responses = []

    for msg in messages:
        if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
            responses.append(_err(None, -32600, "invalid JSON-RPC message"))
            continue

        method = msg.get("method")
        msg_id = msg.get("id")
        params = msg.get("params") or {}

        if msg_id is None:  # notification: no response
            continue

        if method == "initialize":
            responses.append(
                _ok(
                    msg_id,
                    {
                        "protocolVersion": PROTOCOL_VERSION,
                        "capabilities": {"tools": {"listChanged": False}},
                        "serverInfo": {"name": "arena-bridge", "version": "0.7.11"},
                        "instructions": (
                            "Tools operate the user's own machine. Dangerous operations may return "
                            "PROTECTED and require a local human approval."
                        ),
                    },
                )
            )
        elif method == "ping":
            responses.append(_ok(msg_id, {}))
        elif method == "tools/list":
            responses.append(_ok(msg_id, {"tools": ctx["list_tools"]()}))
        elif method == "tools/call":
            name = params.get("name")
            if not name:
                responses.append(_err(msg_id, -32602, "tool name is required"))
                continue
            result = ctx["call_tool"](name, params.get("arguments") or {})
            text = (
                json.dumps(result, indent=2, default=str)
                if result.get("ok")
                else f"ERROR {result.get('error')}\n{result.get('reason', '')}\n{json.dumps(result, indent=2, default=str)}"
            )
            responses.append(
                _ok(
                    msg_id,
                    {
                        "content": [{"type": "text", "text": text}],
                        "isError": not result.get("ok"),
                    },
                )
            )
        else:
            responses.append(_err(msg_id, -32601, f"method not found: {method}"))

    return responses
