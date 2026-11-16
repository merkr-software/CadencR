"""Bounded TLS-blind QA gate. Never inspects or records TLS bytes or credentials."""
import select
import socket
import socketserver
import threading
import time


class Gate(socketserver.ThreadingTCPServer):
    allow_reuse_address = False
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), Tunnel)
        self.api_seen = threading.Event()
        self.upload_held = threading.Event()
        self.stop = threading.Event()
        self.transport_failed = threading.Event()
        self.slots = threading.BoundedSemaphore(16)
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.stop.set()
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=3)

    def environment(self, env):
        # Explicitly remove every proxy alias and NO_PROXY bypass.
        clean = {k: v for k, v in env.items() if "proxy" not in k.lower()}
        clean["HTTPS_PROXY"] = "http://127.0.0.1:" + str(self.server_address[1])
        return clean


class Tunnel(socketserver.BaseRequestHandler):
    def handle(self):
        if not self.server.slots.acquire(blocking=False):
            return
        try:
            self.tunnel()
        except (OSError, ValueError):
            self.server.transport_failed.set()
        finally:
            self.server.slots.release()

    def tunnel(self):
        self.request.settimeout(5)
        head = b""
        while b"\r\n\r\n" not in head and len(head) < 8192:
            part = self.request.recv(1024)
            if not part:
                return
            head += part
        first = head.split(b"\r\n", 1)[0]
        if first == b"CONNECT uploads.github.com:443 HTTP/1.1":
            self.server.upload_held.set()
            self.server.stop.wait(90)
            return
        if first != b"CONNECT api.github.com:443 HTTP/1.1":
            self.request.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            return
        with socket.create_connection(("api.github.com", 443), timeout=10) as upstream:
            self.server.api_seen.set()
            self.request.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
            tail = head.split(b"\r\n\r\n", 1)[1]
            if tail:
                upstream.sendall(tail)
            deadline = time.monotonic() + 90
            total = 0
            while not self.server.stop.is_set() and time.monotonic() < deadline:
                ready, _, _ = select.select([self.request, upstream], [], [], 0.2)
                for source in ready:
                    data = source.recv(65536)
                    if not data:
                        return
                    total += len(data)
                    if total > 32 * 1024 * 1024:
                        return
                    (upstream if source is self.request else self.request).sendall(data)
