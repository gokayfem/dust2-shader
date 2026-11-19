from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
SimpleHTTPRequestHandler.extensions_map[".glsl"] = "text/plain; charset=utf-8"
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8155
print(f"Play Dust II at http://127.0.0.1:{port}/", flush=True)
ThreadingHTTPServer(("127.0.0.1", port), partial(SimpleHTTPRequestHandler, directory=str(Path(__file__).resolve().parent))).serve_forever()
