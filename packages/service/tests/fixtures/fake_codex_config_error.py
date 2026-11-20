#!/usr/bin/env python3
"""Codex app-server fixture whose `config/read` fails with a JSON-RPC error
that quotes the profile's $OPENAI_API_KEY, the way Codex quotes a value it
refuses. Everything else answers normally."""
import json
import os
import sys

if "--version" in sys.argv:
    print("codex-cli 0.154.0")
    sys.exit(0)

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if "id" not in msg or method is None:
        continue
    if method == "config/read":
        reason = ("invalid value for `model_provider`: no provider accepts the key "
                  + os.environ.get("OPENAI_API_KEY", "<unset>"))
        print(json.dumps({"id": msg["id"], "error": {"code": -32600, "message": reason}}),
              flush=True)
        continue
    result = {}
    if method == "initialize":
        result = {"userAgent": "codex-cli/0.154.0"}
    elif method == "model/list":
        result = {"data": [{"id": "qa-model", "model": "qa-model", "displayName": "QA model",
                            "isDefault": True, "supportedReasoningEfforts": [],
                            "defaultReasoningEffort": "low"}], "nextCursor": None}
    print(json.dumps({"id": msg["id"], "result": result}), flush=True)
