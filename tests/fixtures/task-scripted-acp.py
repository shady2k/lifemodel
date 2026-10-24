#!/usr/bin/python3
"""Deterministic ACP agent. No model/network/config dependency."""
import json, sys
scenario = sys.argv[1]
session = "scripted-session"
prompt_id = None
def send(value):
    print(json.dumps({"jsonrpc": "2.0", **value}), flush=True)
def update(value):
    send({"method": "session/update", "params": {"sessionId": session, "update": value}})
for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    if method == "initialize":
        send({"id": message["id"], "result": {"protocolVersion": 1, "agentCapabilities": {}}})
    elif method == "session/new":
        send({"id": message["id"], "result": {"sessionId": session}})
    elif method == "session/prompt":
        prompt_id = message["id"]
        if scenario == "permission":
            send({"id": "permission-1", "method": "session/request_permission", "params": {"sessionId": session, "toolCall": {"toolCallId": "ask"}, "options": [{"optionId": "once", "kind": "allow_once", "name": "Once"}]}})
            continue
        if scenario == "abort":
            update({"sessionUpdate": "tool_call", "toolCallId": "wait", "status": "in_progress"})
            continue
        if scenario == "backlog":
            for _ in range(200):
                update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "working"}})
            continue
        if scenario == "provider":
            send({"id": prompt_id, "error": {"code": -32603, "message": "provider failed"}})
            continue
        if scenario == "custom-failure":
            update({"sessionUpdate": "tool_call", "toolCallId": "required", "status": "completed", "rawOutput": {"customFailure": True}})
        if scenario == "tool":
            update({"sessionUpdate": "tool_call", "toolCallId": "required", "status": "failed"})
        update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "The task result is durable."}})
        if scenario in ("malformed", "late-tool"):
            final = json.dumps({"jsonrpc": "2.0", "id": prompt_id, "result": {"stopReason": "end_turn"}})
            late = "not-json" if scenario == "malformed" else json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session, "update": {"sessionUpdate": "tool_call", "toolCallId": "late", "status": "failed"}}})
            sys.stdout.write(final + "\n" + late + "\n")
            sys.stdout.flush()
        else:
            send({"id": prompt_id, "result": {"stopReason": "end_turn"}})
    elif method == "session/cancel" and prompt_id is not None:
        send({"id": prompt_id, "result": {"stopReason": "cancelled"}})
    elif message.get("id") == "permission-1":
        if message.get("result", {}).get("outcome", {}).get("outcome") != "cancelled":
            raise SystemExit(93)
        send({"id": prompt_id, "result": {"stopReason": "cancelled"}})
