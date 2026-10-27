/** Pure stdlib MCP stdio child. Only a private socket locator crosses exec. */
export const TASK_MCP_SHIM = String.raw`import sys, json, socket, uuid, hashlib
path = sys.argv[1]
boot = uuid.uuid4().hex

def reply(identity, result):
    print(json.dumps({"jsonrpc": "2.0", "id": identity, "result": result}), flush=True)

def call(identity, params):
    kind = params.get("name")
    args = params.get("arguments", {})
    if kind not in ("step", "question") or not isinstance(args, dict) or set(args) != {"text"}:
        return {"isError": True, "content": [{"type": "text", "text": "invalid_report"}]}
    request = {"id": hashlib.sha256((boot + json.dumps(identity)).encode()).hexdigest(), "kind": kind, "text": args["text"]}
    encoded = json.dumps(request, ensure_ascii=False).encode() + b"\n"
    if len(encoded) > 8192:
        return {"isError": True, "content": [{"type": "text", "text": "invalid_report"}]}
    try:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(15)
            connection.connect(path)
            connection.sendall(encoded)
            data = b""
            while b"\n" not in data:
                chunk = connection.recv(4096)
                if not chunk or len(data) + len(chunk) > 4096:
                    raise ValueError()
                data += chunk
        response = json.loads(data.split(b"\n")[0])
        return {"isError": "error" in response, "content": [{"type": "text", "text": json.dumps(response.get("result", response.get("error")))}]}
    except Exception:
        return {"isError": True, "content": [{"type": "text", "text": "report_unavailable"}]}

while True:
    line = sys.stdin.buffer.readline(65538)
    if not line:
        break
    if len(line) > 65536:
        raise SystemExit(1)
    try:
        message = json.loads(line)
        if "id" not in message:
            continue
        identity = message["id"]
        method = message.get("method")
        params = message.get("params", {})
        if method == "initialize":
            reply(identity, {"protocolVersion": params.get("protocolVersion", "2024-11-05"), "capabilities": {"tools": {}}, "serverInfo": {"name": "lifemodel-task", "version": "1"}})
        elif method == "tools/list":
            reply(identity, {"tools": [{"name": name, "description": description, "inputSchema": {"type": "object", "properties": {"text": {"type": "string", "maxLength": 1024}}, "required": ["text"], "additionalProperties": False}} for name, description in [("step", "Report one short progress line. Returns after durable ACK."), ("question", "Ask the coordinating agent. One unanswered question at a time. Returns after durable ACK, not the answer.")]]})
        elif method == "tools/call":
            reply(identity, call(identity, params))
        elif method == "ping":
            reply(identity, {})
        else:
            print(json.dumps({"jsonrpc": "2.0", "id": identity, "error": {"code": -32601, "message": "Method not supported"}}), flush=True)
    except Exception:
        raise SystemExit(1)
`;
