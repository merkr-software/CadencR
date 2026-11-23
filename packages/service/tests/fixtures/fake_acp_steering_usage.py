"""Three overlapping ACP prompts with recorded Antigravity usage."""

import json
import sys

def send(**message):
    print(json.dumps(dict(jsonrpc="2.0", **message)), flush=True)

def update(kind, **fields):
    send(method="session/update", params=dict(sessionId="usage-fixture",
         update=dict(sessionUpdate=kind, **fields)))

requests = {}
for line in sys.stdin:
    message = json.loads(line)
    method = message["method"]
    if method == "initialize":
        send(id=message["id"], result=dict(protocolVersion=1,
             agentCapabilities={"_meta": {"cadencr": {"promptSteering": True}}}))
    elif method == "session/new":
        send(id=message["id"], result=dict(sessionId="usage-fixture"))
    elif method == "session/prompt":
        label = message["params"]["prompt"][0]["text"]
        requests[label] = message
        assert list(requests) == ["P1", "P2", "P3"][:len(requests)]
        if len(requests) < 3:
            update("usage_update", used=len(requests), size=1048576)
            continue
        assert "messageId" not in requests["P1"]["params"]
        for label in ("P2", "P3"):
            assert "messageId" in requests[label]["params"]
        update("usage_update", used=11054, size=1048576)
        # Settle both identified follow-ups before the initial request.
        for label, tokens in [("P2", (2786, 6704, 298, 226, 9788)),
                              ("P3", (2730, 7456, 107, 103, 10293)),
                              ("P1", (8746, 0, 397, 325, 9143))]:
            input, cached, output, thought, total = tokens
            send(id=requests[label]["id"], result=dict(stopReason="end_turn",
                 usage=dict(inputTokens=input, cachedReadTokens=cached, outputTokens=output,
                            thoughtTokens=thought, totalTokens=total)))
