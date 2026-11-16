"""Exact diagnostic and no-remote-mutation checks for every reviewed asset."""


def reject_changes(cli, home, stage, request, sha, token, network, c, assets,
                   before, invoke, require):
    args = ["--json", "plugin", "publish-release", "--request", str(request),
            "--directory", str(stage), "--confirm-request-sha256", sha]
    for name in sorted(assets):
        path = stage / name
        original = path.read_bytes()
        path.write_bytes(original + b"!")
        invoke(cli, args, home, token, success=False,
               expected_error="author release local validation failed")
        require(network.inventory(c, assets) == before)
        path.write_bytes(original)
    request.write_bytes(request.read_bytes() + b" ")
    invoke(cli, args, home, token, success=False,
           expected_error="request SHA-256 confirmation does not match")
    require(network.inventory(c, assets) == before)
