"""Serve the original B-read reader and its native assistant on loopback."""
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from json import dumps, loads
from mimetypes import guess_type
from pathlib import Path
import errno
import shutil
import sys
from urllib.parse import unquote, urlsplit
from urllib.request import ProxyHandler, build_opener
import webbrowser

from chatgpt_plan import LocalVault, PlanConnection, PlanError
from native_host import answer
from website_bridge import WebsiteBridge, configured_website

SITE = Path(__file__).resolve().parent / "site"
HOST = "127.0.0.1"
PORT = 17463
WEBSITE_PORT = 17464
LIMIT = 160 * 1024
PREFIX = "/api/assistant"
ROUTES = frozenset(("/plan/status", "/plan/start", "/plan/logout", "/plan/models", "/explain", "/follow-up", "/example"))
BRIDGE_ROUTES = ROUTES | {"/pair", "/disconnect"}
SESSION_HEADER = "X-B-Read-Session"
CSP = ("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' blob: data:; font-src 'self' blob: data:; worker-src 'self' blob:; "
       "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")


def make_handler(plan, port, open_browser=webbrowser.open, bridge=None):
    local_origin = f"http://{HOST}:{port}"

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def log_message(self, *_):
            pass

        def response(self, status, mime, length, *, cache="no-store"):
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", cache)
            self.send_header("Content-Security-Policy", CSP)
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            if self.website_request():
                self.send_header("Access-Control-Allow-Origin", bridge.origin)
                self.send_header("Vary", "Origin")
                if self.command == "OPTIONS":
                    self.send_header("Access-Control-Allow-Methods", "POST")
                    self.send_header("Access-Control-Allow-Headers", "Content-Type, " + SESSION_HEADER)
            self.end_headers()

        def json(self, status, value):
            content = dumps(value, ensure_ascii=False).encode("utf-8")
            self.response(status, "application/json; charset=utf-8", len(content))
            if self.command != "HEAD":
                self.wfile.write(content)

        def valid_host(self):
            return self.headers.get("Host") == f"{HOST}:{port}"

        def assistant_route(self):
            return self.path.removeprefix(PREFIX) if self.path.startswith(PREFIX + "/") else ""

        def website_request(self):
            return bool(bridge and self.valid_host() and self.headers.get("Origin") == bridge.origin
                        and self.assistant_route() in BRIDGE_ROUTES)

        def do_OPTIONS(self):
            if not self.website_request() or self.headers.get("Access-Control-Request-Method") != "POST":
                return self.json(403, {"error": "该网站未获得本地助手访问权限。"})
            return self.response(204, "text/plain", 0)

        def page(self, message, status=200):
            back = bridge.address if bridge else "/"
            content = (
                '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>B-read</title>'
                '<main style="max-width:40rem;margin:4rem auto;padding:1rem;background:#fff7e7;font:16px/1.6 system-ui">'
                '<h1>B-read</h1><p>' + escape(message) + '</p>'
                '<p>请切回原来的 B-read 标签页继续，或<a href="' + escape(back, quote=True) +
                '">打开阅读器</a>。</p></main></html>'
            ).encode("utf-8")
            self.response(status, "text/html; charset=utf-8", len(content))
            self.wfile.write(content)

        def static(self, pathname):
            requested = "reader.html" if pathname == "/" else unquote(pathname[1:])
            if "\0" in requested or "\\" in requested:
                return self.json(404, {"error": "未找到文件。"})
            try:
                file = (SITE / requested).resolve()
                if not file.is_relative_to(SITE) or not file.is_file():
                    return self.json(404, {"error": "未找到文件。"})
                suffix = file.suffix.lower()
                mime = {
                    ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css",
                    ".html": "text/html", ".json": "application/json", ".wasm": "application/wasm",
                    ".tsv": "text/tab-separated-values",
                }.get(suffix) or guess_type(file.name)[0] or "application/octet-stream"
                if mime.startswith("text/") or suffix == ".json":
                    mime += "; charset=utf-8"
                with file.open("rb") as stream:
                    self.response(200, mime, file.stat().st_size, cache="no-cache")
                    if self.command != "HEAD":
                        shutil.copyfileobj(stream, self.wfile, length=64 * 1024)
            except OSError:
                self.close_connection = True

        def read(self):
            if not self.valid_host():
                return self.json(403, {"error": "请从 B-read 启动入口打开本地网站。"})
            url = urlsplit(self.path)
            if url.path == "/health":
                return self.json(200, {"app": "b-read-web", "version": "0.14-bookmarks",
                                       "website_mode": bool(bridge)})
            if self.command == "GET" and url.path == "/auth/callback":
                try:
                    plan.finish(url.query)
                except PlanError as exc:
                    return self.page(str(exc), 400)
                except (OSError, ValueError):
                    return self.page("本地助手无法完成授权，请检查网络后重试。", 502)
                self.send_response(303)
                self.send_header("Location", "/auth/done")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Referrer-Policy", "no-referrer")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if self.command == "GET" and url.path == "/auth/done":
                return self.page(plan.feedback)
            if bridge:
                if self.command == "GET" and url.path == "/":
                    return self.page("B-read 本地助手已启动。请在网页输入终端显示的配对码。")
                return self.json(404, {"error": "未找到文件。"})
            return self.static(url.path)

        do_GET = read
        do_HEAD = read

        def do_POST(self):
            hosted = self.website_request()
            local = (not bridge and self.valid_host() and self.headers.get("Origin") == local_origin and
                     self.headers.get("Sec-Fetch-Site", "same-origin") == "same-origin")
            if not hosted and not local:
                return self.json(403, {"error": "本地助手只响应 B-read 阅读页的请求。"})
            tail = self.assistant_route()
            if tail not in (BRIDGE_ROUTES if hosted else ROUTES):
                return self.json(404, {"error": "无此助手操作。"})
            session = self.headers.get(SESSION_HEADER)
            if hosted and tail != "/pair" and not bridge.authenticated(session):
                return self.json(403, {"error": "本地助手连接已过期，请重新配对。", "code": "setup_required"})
            if self.headers.get_content_type() != "application/json":
                return self.json(415, {"error": "请求须为 JSON。"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= LIMIT:
                    raise ValueError
                data = loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise ValueError
                if hosted and tail == "/pair":
                    token = bridge.pair(data.get("code"))
                    if not token:
                        return self.json(403, {"error": "配对码错误、已用过或已过期。请检查终端或重启助手。"})
                    return self.json(200, {"result": {"session": token}})
                if hosted and tail == "/disconnect":
                    bridge.disconnect(session)
                    return self.json(200, {"result": {"disconnected": True}})
                result = answer(plan, tail, data)
                if tail == "/plan/start":
                    url = urlsplit(result["url"])
                    if url.scheme != "https" or url.netloc != "auth.openai.com" or url.path != "/api/accounts/authorize":
                        raise PlanError("无法验证 OpenAI 的授权页地址。")
                    result["opened"] = open_browser(result["url"], new=2)
                self.json(200, {"result": result})
            except PlanError as exc:
                self.json(409, {"error": str(exc), "code": exc.code})
            except (ValueError, TypeError, KeyError, AttributeError):
                self.json(400, {"error": "精读请求格式无效。"})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except OSError:
                self.json(502, {"error": "本地助手暂时无法完成请求。请检查网络后重试。"})

    return Handler


def existing(url):
    try:
        with build_opener(ProxyHandler({})).open(url + "health", timeout=2) as response:
            return loads(response.read(1024)).get("app") == "b-read-web"
    except (OSError, ValueError):
        return False


def main():
    website_mode = "--website" in sys.argv
    port = WEBSITE_PORT if website_mode else PORT
    origin = f"http://{HOST}:{port}/"
    open_page = "--no-browser" not in sys.argv
    vault = LocalVault()
    vault.path = vault.path.with_name("chatgpt-plan-pages" if website_mode else "chatgpt-plan-web")
    bridge = None
    if website_mode:
        try:
            address = configured_website(vault.path.with_name("pages-website.txt"), "--change-website" in sys.argv)
        except (OSError, EOFError, KeyboardInterrupt):
            raise SystemExit("Unable to configure the B-read website.") from None
        bridge = WebsiteBridge(address, lambda code: print("Pairing code (valid for 10 minutes): " + code, flush=True))
    try:
        plan = PlanConnection(origin + "auth/callback", vault=vault)
    except (OSError, ValueError):
        raise SystemExit("Unable to open the local ChatGPT record.")
    try:
        server = ThreadingHTTPServer((HOST, port), make_handler(plan, port, bridge=bridge))
    except OSError as exc:
        if exc.errno in (errno.EADDRINUSE, 10048, 10013) and existing(origin):
            if website_mode:
                print("The assistant is already running. Use its current pairing code or close it and retry.")
            elif open_page:
                webbrowser.open(origin, new=2)
            return
        raise SystemExit("The B-read site could not listen on " + origin) from exc
    with server:
        print("B-read  " + origin, flush=True)
        print("Keep this window open. Ctrl+C stops B-read.", flush=True)
        if bridge:
            print("Website: " + bridge.address, flush=True)
            bridge.issue_code()
        if open_page:
            webbrowser.open(bridge.address if bridge else origin, new=2)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
