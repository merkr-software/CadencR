"""Drain a process pipe without permitting unbounded retained or emitted output."""
import os
import signal
import threading


OUTPUT_BUDGET = 8 * 1024 * 1024
RUNTIME_FILE_LIMIT = 2 ** 41  # CoreCLR's sparse anonymous doublemapper reservation.


class BoundedOutput:
    def __init__(self, process, stream, budget=OUTPUT_BUDGET, retained=5000, destination=None, label="server stderr"):
        self.process, self.stream = process, stream
        self.budget, self.retained = budget, retained
        self.total, self.tail, self.exceeded = 0, b"", False
        self.error = None
        self.destination = destination
        self.label = label
        self.thread = threading.Thread(target=self.drain, daemon=True)
        self.thread.start()

    def drain(self):
        try:
            while chunk := self.stream.read(65536):
                if self.destination is not None:
                    remaining = max(0, self.budget - self.total)
                    self.destination.write(chunk[:remaining])
                self.total += len(chunk)
                self.tail = (self.tail + chunk)[-self.retained:]
                if self.total > self.budget:
                    self.exceeded = True
                    self.stop()
                    return
        except OSError as error:
            self.error = str(error)
            self.stop()
        finally:
            self.stream.close()

    def stop(self):
        try:
            os.killpg(self.process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def finish(self):
        self.thread.join(timeout=10)
        if self.thread.is_alive():
            raise ValueError(self.label + " pipe did not close after cleanup")
        if self.error:
            raise ValueError(self.label + " collection failed: " + self.error)
        if self.exceeded:
            raise ValueError(self.label + " exceeded the output byte budget")
