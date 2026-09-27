"""Fake OpenAI Responses API (streaming) for testing Codex through Jolty.

When the input contains RUN_TOOL and no function_call_output yet, the model calls the shell tool
with `echo jolty-codex-ok`; otherwise it answers with text.
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = sys.argv[2] if len(sys.argv) > 2 else None
COUNTER = [0]


def sse(h, data):
    h.wfile.write(f"event: {data['type']}\ndata: {json.dumps(data)}\n\n".encode())
    h.wfile.flush()


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        body = json.dumps({"object": "list", "data": [], "models": []}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        raw = self.rfile.read(n) or b"{}"
        req = json.loads(raw)
        inp = req.get("input") or []
        text = json.dumps(inp)
        tools = req.get("tools") or []
        tool_names = [t.get("name") or t.get("type") for t in tools]
        has_output = any(isinstance(i, dict) and i.get("type") in ("function_call_output", "custom_tool_call_output") for i in inp)
        if LOG:
            with open(LOG, "a") as f:
                f.write(json.dumps({"path": self.path, "model": req.get("model"), "tools": tool_names, "has_output": has_output, "stream": req.get("stream")}) + "\n")
        COUNTER[0] += 1
        rid = f"resp_{COUNTER[0]}"
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        sse(self, {"type": "response.created", "response": {"id": rid, "object": "response", "created_at": int(time.time()), "status": "in_progress", "model": req.get("model"), "output": []}})
        shell = next((t for t in tools if t.get("name") in ("shell", "exec_command", "shell_command")), None)
        if "RUN_TOOL" in text and not has_output and shell:
            name = shell["name"]
            params = shell.get("parameters", {}).get("properties", {})
            if "cmd" in params:
                args = {"cmd": "echo jolty-codex-ok"}
            elif "command" in params and params["command"].get("type") == "array":
                args = {"command": ["bash", "-lc", "echo jolty-codex-ok"]}
            else:
                args = {"command": "echo jolty-codex-ok"}
            item = {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": name, "arguments": json.dumps(args), "status": "completed"}
            sse(self, {"type": "response.output_item.added", "output_index": 0, "item": {**item, "arguments": "", "status": "in_progress"}})
            sse(self, {"type": "response.output_item.done", "output_index": 0, "item": item})
            output = [item]
        else:
            reply = "ok from mock responses" + (" (am rulat comanda)" if has_output else "")
            mid = f"msg_{COUNTER[0]}"
            sse(self, {"type": "response.output_item.added", "output_index": 0, "item": {"type": "message", "id": mid, "role": "assistant", "status": "in_progress", "content": []}})
            sse(self, {"type": "response.content_part.added", "item_id": mid, "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []}})
            for chunk in [reply[:10], reply[10:]]:
                sse(self, {"type": "response.output_text.delta", "item_id": mid, "output_index": 0, "content_index": 0, "delta": chunk})
            done = {"type": "message", "id": mid, "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": reply, "annotations": []}]}
            sse(self, {"type": "response.output_text.done", "item_id": mid, "output_index": 0, "content_index": 0, "text": reply})
            sse(self, {"type": "response.output_item.done", "output_index": 0, "item": done})
            output = [done]
        sse(self, {"type": "response.completed", "response": {"id": rid, "object": "response", "status": "completed", "model": req.get("model"), "output": output,
            "usage": {"input_tokens": 120, "input_tokens_details": {"cached_tokens": 20}, "output_tokens": 15, "output_tokens_details": {"reasoning_tokens": 0}, "total_tokens": 135}}})


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
