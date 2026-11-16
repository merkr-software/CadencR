"""Closed, bounded failure metadata: never serialize exception messages or arguments."""
import json
import subprocess
import urllib.error


class Rejected(Exception):
    def __init__(self, message, *, code="GUARD_REJECTED", http_status=None):
        super().__init__(message)
        self.code = code
        self.http_status = http_status
        self.operations = []


def require(condition):
    if not condition:
        raise Rejected("qualification guard rejected input or observed state")


def failure_json(error):
    diagnostic = {"ok": False, "code": "QUALIFICATION_FAILED", "category": "UNKNOWN"}
    for kind, category in ((Rejected, "REJECTED"), (urllib.error.URLError, "NETWORK"),
                           (OSError, "OS"), (ValueError, "VALUE"), (KeyError, "KEY"),
                           (TypeError, "TYPE"), (subprocess.SubprocessError, "PROCESS")):
        if isinstance(error, kind):
            diagnostic["category"] = category
            break
    if isinstance(error, Rejected):
        diagnostic["code"] = (error.code if type(error.code) is str and error.code in
                              {"GUARD_REJECTED", "HTTP_READ_FAILED"} else "GUARD_REJECTED")
        status = error.http_status
        if type(status) is int and 100 <= status <= 599:
            diagnostic["http_status"] = status
        diagnostic["operations"] = [operation for operation in error.operations
            if type(operation) is str and operation in {"get", "identity", "inventory", "draft"}][:4]
    return json.dumps(diagnostic, sort_keys=True)
