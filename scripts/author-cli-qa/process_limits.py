"""Linux exec wrapper: no post-thread fork callbacks."""
from pathlib import Path


def bounded_command(cli, args, limit):
    wrapper = Path("/usr/bin/prlimit")
    if not wrapper.is_file():
        raise OSError("Linux prlimit is required for bounded CLI execution")
    return [str(wrapper), "--fsize=" + str(limit) + ":" + str(limit), "--", str(cli), *args]
