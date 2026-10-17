"""Read-only Codex account queries (no model call) via `codex app-server` over stdio.

    python codex_usage.py           # ChatGPT-plan rate-limit usage as JSON
"""

import json
import subprocess
import sys


def app_server_call(method, params):
    proc = subprocess.Popen(
        ["codex", "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, text=True,
    )

    def call(id_, method, params):
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": id_, "method": method, "params": params}) + "\n")
        proc.stdin.flush()
        for line in proc.stdout:
            msg = json.loads(line)
            if msg.get("id") == id_:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg["result"]
        raise RuntimeError(f"{method}: app-server closed")

    try:
        call(1, "initialize", {"clientInfo": {"name": "c2c-eval", "version": "0"}})
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "initialized"}) + "\n")
        proc.stdin.flush()
        return call(2, method, params)
    finally:
        proc.kill()


def read_rate_limits():
    return app_server_call("account/rateLimits/read", None)


def list_models():
    """{model id: [supported reasoning efforts]} for the logged-in account."""
    data = app_server_call("model/list", {})["data"]
    return {m["id"]: [e["reasoningEffort"] for e in m.get("supportedReasoningEfforts", [])] for m in data}


if __name__ == "__main__":
    json.dump(read_rate_limits(), sys.stdout, indent=2)
    print()
