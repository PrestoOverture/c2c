"""Local HTTP(S) proxy that refuses hosts where an upstream fix could be found.

Agents run with HTTP(S)_PROXY pointing here, so their shell commands (curl,
wget, git, urllib…) cannot reach GitHub, code search, Q&A or search engines,
while the model APIs the CLIs talk to pass through untouched (CONNECT tunnel,
no TLS interception). Every refused request is appended to a log the run audit
reads.

    python blockproxy.py [port]     # standalone, for testing
"""

import re
import select
import socket
import socketserver
import sys
import threading
import time
from pathlib import Path

BLOCKED = re.compile(
    r"(^|\.)("
    r"github\.com|githubusercontent\.com|githubassets\.com|github\.io|gitlab\.com|bitbucket\.org"
    r"|sourcegraph\.com|grep\.app|searchcode\.com|codeberg\.org"
    r"|stackoverflow\.com|stackexchange\.com|google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.brave\.com"
    r"|kagi\.com|yandex\.[a-z]+|baidu\.com|perplexity\.ai|you\.com"
    r")$",
    re.I,
)


class _Handler(socketserver.StreamRequestHandler):
    def handle(self):
        line = self.rfile.readline(65536).decode("latin-1")
        parts = line.split()
        if len(parts) < 2:
            return
        method, target = parts[0], parts[1]
        headers = []
        while True:
            h = self.rfile.readline(65536)
            if h in (b"\r\n", b"\n", b""):
                break
            headers.append(h)
        if method == "CONNECT":
            host, _, port = target.rpartition(":")
            port = int(port or 443)
        else:
            m = re.match(r"https?://([^/:]+)(?::(\d+))?", target)
            if not m:
                return
            host, port = m.group(1), int(m.group(2) or 80)
        if BLOCKED.search(host):
            self.server.log(f"{time.strftime('%H:%M:%S')} BLOCKED {method} {host}")
            self.wfile.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            return
        try:
            upstream = socket.create_connection((host, port), timeout=30)
        except OSError:
            self.wfile.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            return
        if method == "CONNECT":
            self.wfile.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        else:  # plain HTTP: forward the request as received
            upstream.sendall(line.encode("latin-1") + b"".join(headers) + b"\r\n")
        self._pipe(self.connection, upstream)

    @staticmethod
    def _pipe(a, b):
        socks = [a, b]
        try:
            while True:
                r, _, x = select.select(socks, [], socks, 300)
                if x or not r:
                    return
                for s in r:
                    data = s.recv(65536)
                    if not data:
                        return
                    (b if s is a else a).sendall(data)
        except OSError:  # either side reset the connection: normal end of a tunnel
            return
        finally:
            b.close()


class BlockProxy(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, port=0, log_path=None):
        super().__init__(("127.0.0.1", port), _Handler)
        self.log_path = Path(log_path) if log_path else None
        self._lock = threading.Lock()

    def handle_error(self, request, client_address):
        pass  # a dropped client connection is not worth a traceback in the run log

    def log(self, msg):
        if self.log_path:
            with self._lock, self.log_path.open("a") as f:
                f.write(msg + "\n")

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server_address[1]}"

    def start(self):
        threading.Thread(target=self.serve_forever, daemon=True).start()
        return self


if __name__ == "__main__":
    p = BlockProxy(int(sys.argv[1]) if len(sys.argv) > 1 else 8899, "/dev/stdout")
    print("listening on", p.url, flush=True)
    p.serve_forever()
