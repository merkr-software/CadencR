"""One-shot fake-provider checkpoints armed by tests/common/provider_gate.rs."""
from pathlib import Path
from time import monotonic, sleep


def pause_at(name):
    armed = Path(f".provider-{name}.armed")
    reached = armed.with_suffix(".reached")
    try:
        armed.rename(reached)
    except FileNotFoundError:
        return

    deadline = monotonic() + 30
    while reached.exists():
        if monotonic() >= deadline:
            raise TimeoutError(f"test did not release provider checkpoint {name}")
        sleep(0.01)
