#!/usr/bin/env python3
"""Codex app-server fixture for profile probes: answers config and models, and
appends one line per launch to $CADENCR_FAKE_CODEX_LAUNCHES. `model/list`
fails in a directory holding a `fail-model-list` file."""
import json
import os
import sys

if "--version" in sys.argv:
    print("codex-cli 0.154.0")
    sys.exit(0)

with open(os.environ["CADENCR_FAKE_CODEX_LAUNCHES"], "a") as launches:
    launches.write("app-server\n")

for line in sys.stdin:
    msg = json.loads(line)
    if "id" not in msg:
        continue
    method = msg["method"]
    result = {}
    if method == "initialize":
        result = {"userAgent": "codex-cli/0.154.0"}
    elif method == "config/read":
        result = {"config": {"model": "qa-model", "model_reasoning_effort": "low"}}
    elif method == "model/list" and os.path.exists("fail-model-list"):
        print(json.dumps({"id": msg["id"], "error": {"code": -32000, "message": "MODEL_LIST_FAILED"}}),
              flush=True)
        continue
    elif method == "model/list":
        result = {"data": [{"id": "qa-model", "model": "qa-model", "displayName": "QA model",
                            "isDefault": True, "supportedReasoningEfforts": [],
                            "defaultReasoningEffort": "low"}], "nextCursor": None}
    print(json.dumps({"id": msg["id"], "result": result}), flush=True)
