"""Fake Anthropic Messages API (streaming) for testing Claude Code through Jolty.

Scenario: when the prompt contains "RUN_TOOL" and no tool_result was sent yet, the model
asks to run Bash `echo jolty-tool-ok`; otherwise it answers with plain text.
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = sys.argv[2] if len(sys.argv) > 2 else None


def sse(handler, event, data):
    handler.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
    handler.wfile.flush()


def flatten(content):
    if isinstance(content, str):
        return content
    out = []
    for c in content or []:
        if c.get("type") == "text":
            out.append(c.get("text", ""))
        elif c.get("type") == "image":
            out.append("IMAGE_BLOCK")
        elif c.get("type") == "tool_result":
            out.append("TOOL_RESULT:" + json.dumps(c.get("content")))
    return "\n".join(out)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        req = json.loads(self.rfile.read(n) or b"{}")
        path = self.path.split("?")[0]
        msgs = req.get("messages", [])
        last = flatten(msgs[-1]["content"]) if msgs else ""
        all_text = "\n".join(flatten(m.get("content")) for m in msgs)
        if LOG:
            with open(LOG, "a") as f:
                f.write(json.dumps({"path": path, "model": req.get("model"), "auth": (self.headers.get("authorization") or self.headers.get("x-api-key") or "")[:14],
                                    "stream": req.get("stream"), "n_tools": len(req.get("tools") or []), "last": last[:200], "has_image": "IMAGE_BLOCK" in all_text, "desc_in_prompt": "Imagine atașată" in all_text, "handoff": "Preiei o conversa" in all_text,
                                    "dash_rule": "U+2014" in json.dumps(req.get("system"))}) + "\n")
        if path.endswith("/count_tokens"):
            body = json.dumps({"input_tokens": 42}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        # the user's turn = every message after the last assistant message
        idx = max([i for i, m in enumerate(msgs) if m.get("role") == "assistant"], default=-1)
        tail = "\n".join(flatten(m.get("content")) for m in msgs[idx + 1:])
        want_tool = "RUN_TOOL" in tail and "TOOL_RESULT:" not in tail and req.get("tools")
        want_write = "RUN_WRITE" in tail and "TOOL_RESULT:" not in tail and req.get("tools")
        model = req.get("model")
        if not req.get("stream"):
            content = [{"type": "text", "text": "Titlu test"}]
            body = json.dumps({"id": "msg_nostream", "type": "message", "role": "assistant", "model": model, "content": content,
                               "stop_reason": "end_turn", "stop_sequence": None, "usage": {"input_tokens": 5, "output_tokens": 2}}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        mid = "msg_mock_%d" % (abs(hash(all_text)) % 10**8)
        sse(self, "message_start", {"type": "message_start", "message": {"id": mid, "type": "message", "role": "assistant", "model": model, "content": [],
            "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 100, "output_tokens": 1, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}})
        if want_write:
            content = "\n".join(f"line {i}: jolty live code" for i in range(1, 41))
            payload = json.dumps({"file_path": "live_demo.txt", "content": content})
            sse(self, "content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "toolu_w" + mid, "name": "Write", "input": {}}})
            step = max(1, len(payload) // 12)
            for k in range(0, len(payload), step):
                sse(self, "content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": payload[k:k + step]}})
                time.sleep(0.08)
            sse(self, "content_block_stop", {"type": "content_block_stop", "index": 0})
            sse(self, "message_delta", {"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 50}})
        elif want_tool:
            sse(self, "content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
            sse(self, "content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Rulez comanda."}})
            sse(self, "content_block_stop", {"type": "content_block_stop", "index": 0})
            sse(self, "content_block_start", {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "toolu_" + mid, "name": "Bash", "input": {}}})
            sse(self, "content_block_delta", {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": json.dumps({"command": "echo jolty-tool-ok > jolty-proof.txt && cat jolty-proof.txt", "description": "test"})}})
            sse(self, "content_block_stop", {"type": "content_block_stop", "index": 1})
            sse(self, "message_delta", {"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 20}})
        else:
            reply = "Gata: " + ("am vazut rezultatul " + tail.split("TOOL_RESULT:")[1][:60] if "TOOL_RESULT:" in tail else "salut din mock")
            sse(self, "content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
            for chunk in [reply[: len(reply) // 2], reply[len(reply) // 2:]]:
                sse(self, "content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": chunk}})
            sse(self, "content_block_stop", {"type": "content_block_stop", "index": 0})
            sse(self, "message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 12}})
        sse(self, "message_stop", {"type": "message_stop"})


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
