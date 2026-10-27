#!/usr/bin/python3
"""Deterministic ACP agent. No model/network/config dependency."""
import json, sys, os, socket, threading, subprocess
if "--version" in sys.argv:
    print("scripted-acp 1")
    raise SystemExit(0)
scenario = sys.argv[1] if len(sys.argv) > 1 else open(os.environ["SCRIPTED_SCENARIO_FILE"]).read().strip()
if "SCRIPTED_CONFIG" in os.environ:
    assert json.load(open(os.environ["SCRIPTED_CONFIG"]))["fixture"] == "second-distinct-agent"
session = "scripted-session"
prompt_id = None
inbox = {}
lock = threading.Lock()
inserted_observed = threading.Event()
server = socket.socket(socket.AF_UNIX)
server.bind(os.path.join(os.getcwd(), ".launcher/steer.sock"))
server.listen()
def listen():
    while True:
        connection, _ = server.accept()
        with connection:
            raw = b""
            while b"\n" not in raw:
                raw += connection.recv(65536)
            request = json.loads(raw.split(b"\n")[0])
            with lock:
                if request["op"] == "steer":
                    inbox.setdefault(request["id"], {"text": request["text"], "status": "pending"})
                    data = {"id": request["id"]}
                else:
                    data = {"id": request["id"], "status": inbox.get(request["id"], {}).get("status", "unknown")}
            connection.sendall((json.dumps({"ok": True, "data": data}) + "\n").encode())
            if data.get("status") == "inserted":
                inserted_observed.set()
threading.Thread(target=listen, daemon=True).start()
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
        if scenario in ("steer-long", "steer-parallel", "steer-failure"):
            count = 2 if scenario == "steer-parallel" else 1
            processes = []
            for i in range(count):
                update({"sessionUpdate": "tool_call", "toolCallId": f"sleep-{i}", "status": "in_progress"})
                processes.append(subprocess.Popen(["sh", "-c", f"touch start-{i}; sleep {2+i}; touch done-{i}; echo done-{i}"], stdout=subprocess.DEVNULL))
            for i, process in enumerate(processes):
                assert process.wait() == 0
                update({"sessionUpdate": "tool_call_update", "toolCallId": f"sleep-{i}", "status": "completed"})
            with lock:
                for item in inbox.values():
                    item["status"] = "inserted"
            # Final response waits for the actual insertion-disposition read.
            assert inserted_observed.wait(30), "insertion disposition was never observed"
        if scenario == "barrier-gated":
            import time
            update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "First result"}})
            # Test owns this explicit event gate; no event sink blocks ACP dispatch.
            open("prompt-tail", "w").close()
            while not os.path.exists("release-prompt"):
                time.sleep(0.01)
            send({"id": prompt_id, "result": {"stopReason": "end_turn"}})
            continue
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
        result_text = "The task result is durable."
        if scenario in ("barrier", "barrier-tool"):
            with lock:
                if inbox:
                    result_text = "Steered terminal result."
                    for item in inbox.values():
                        item["status"] = "inserted"
            # ACP callback must observe final text before terminal closure.
        update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": result_text}})
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
