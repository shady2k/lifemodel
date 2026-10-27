/** Pure stdlib MCP stdio child. Only a private socket locator crosses exec. */
export const TASK_MCP_SHIM = String.raw`import sys, json, socket, uuid, hashlib
path = sys.argv[1]
boot = uuid.uuid4().hex
versions = ("2024-11-05", "2025-06-18")

def error(identity, code, message):
    print(json.dumps({"jsonrpc": "2.0", "id": identity, "error": {"code": code, "message": message}}), flush=True)

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
    submitted = False
    try:
        with socket.socket(socket.AF_UNIX) as connection:
            # Above 3 x 5 s sends plus the shared 30 s startup-connect window.
            connection.settimeout(60)
            connection.connect(path)
            submitted = True
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
        return {"isError": True, "content": [{"type": "text", "text": "report_uncertain" if submitted else "report_unavailable"}]}

while True:
    line = sys.stdin.buffer.readline(65538)
    if not line:
        break
    if len(line) > 65536:
        while not line.endswith(b"\n"):
            line = sys.stdin.buffer.readline(65538)
            if not line:
                break
        error(None, -32600, "Request too large")
        continue
    try:
        message = json.loads(line)
    except Exception:
        error(None, -32700, "Parse error")
        continue
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
        error(None, -32600, "Invalid request")
        continue
    if "id" not in message:
        continue
    identity = message["id"]
    if identity is not None and (isinstance(identity, bool) or not isinstance(identity, (str, int, float))):
        error(None, -32600, "Invalid request")
        continue
    method = message["method"]
    params = message.get("params", {})
    if not isinstance(params, dict):
        error(identity, -32602, "Invalid params")
        continue
    try:
        if method == "initialize":
            requested = params.get("protocolVersion")
            reply(identity, {"protocolVersion": requested if requested in versions else versions[-1], "capabilities": {"tools": {}}, "serverInfo": {"name": "lifemodel-task", "version": "1"}})
        elif method == "tools/list":
            reply(identity, {"tools": [{"name": name, "description": description, "inputSchema": {"type": "object", "properties": {"text": {"type": "string", "maxLength": 1024}}, "required": ["text"], "additionalProperties": False}} for name, description in [("step", "Report one short progress line. Returns after durable ACK."), ("question", "Ask the coordinating agent. One unanswered question at a time. Returns after durable ACK, not the answer.")]]})
        elif method == "tools/call":
            reply(identity, call(identity, params))
        elif method == "ping":
            reply(identity, {})
        else:
            error(identity, -32601, "Method not supported")
    except Exception:
        error(identity, -32602, "Invalid params")
`;
