"""Local launcher and durable storage for IELTS 自习室."""
import argparse
import base64
import json
import secrets
import sqlite3
import threading
import webbrowser
import zipfile
from subprocess import TimeoutExpired
from xml.etree.ElementTree import ParseError
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from importer import answer_key, extract, source_groups
from coach import CoachError, analyze, key
from aligner import align

ROOT = Path(__file__).resolve().parent
TOKEN = secrets.token_urlsafe(32)
MAX_BODY = 20 * 1024 * 1024
ALIGN_JOB = threading.Lock()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "web"), **kwargs)

    def send_json(self, status, body):
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def valid_host(self):
        return self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}"

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; media-src 'self' data: blob:; img-src 'self' data: blob:; "
                         "object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        super().end_headers()

    def do_GET(self):
        if not self.valid_host():
            return self.send_error(403)
        if self.path == "/api/coach":
            return self.send_json(200, {"configured": bool(key())})
        if self.path != "/api/state":
            return super().do_GET()
        with sqlite3.connect(self.server.database) as db:
            revision, payload = db.execute("SELECT revision, payload FROM state").fetchone()
        self.send_json(200, {"token": TOKEN, "revision": revision, "state": json.loads(payload)})

    def do_PUT(self):
        if (self.path != "/api/state" or not self.valid_host()
                or self.headers.get("X-Local-Token") != TOKEN):
            return self.send_error(403)
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= MAX_BODY:
                return self.send_json(413, {"error": "资料超过本次保存上限"})
            body = json.loads(self.rfile.read(size))
            revision = body["revision"]
            state = body["state"]
            if type(revision) is not int or state.get("version") != 1:
                raise ValueError
        except (ValueError, TypeError, AttributeError, KeyError):
            return self.send_json(400, {"error": "无法读取学习数据"})
        with sqlite3.connect(self.server.database) as db:
            changed = db.execute(
                "UPDATE state SET revision = revision + 1, payload = ? WHERE revision = ?",
                (json.dumps(state, ensure_ascii=False), revision),
            ).rowcount
        if not changed:
            return self.send_json(409, {"error": "另一页面已更新记录，请导出当前更改或刷新页面"})
        self.send_json(200, {"revision": revision + 1})

    def do_POST(self):
        if (self.path not in {"/api/import", "/api/coach", "/api/align"} or not self.valid_host()
                or self.headers.get("X-Local-Token") != TOKEN):
            return self.send_error(403)
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= MAX_BODY:
                return self.send_json(413, {"error": "原卷与配套文档合计过大"})
            body = json.loads(self.rfile.read(size))
            if self.path == "/api/coach":
                return self.send_json(200, analyze(body))
            if self.path == "/api/align":
                if not ALIGN_JOB.acquire(blocking=False):
                    return self.send_json(409, {"error": "正在处理另一组录音，请稍后重试"})
                try:
                    return self.send_json(200, align(body))
                finally:
                    ALIGN_JOB.release()

            def read(role):
                file = body.get(role)
                if file is None:
                    return [], False
                return extract(file["name"], base64.b64decode(file["base64"], validate=True))

            pages, uncertain = read("paper")
            answers, answers_uncertain = read("answers")
            transcript, transcript_uncertain = read("transcript")
            if not pages:
                raise ValueError("请选择题卷文件")
            title = body["title"].strip()
            if not title:
                raise ValueError("填写套题名称")
            groups = source_groups(title, body["skill"], pages, answer_key("\n".join(answers)),
                                   "\n".join(transcript), uncertain or answers_uncertain or transcript_uncertain)
        except CoachError as error:
            return self.send_json(error.status, {"error": str(error)})
        except TimeoutExpired:
            return self.send_json(422, {"error": "提取超时，试着把文件按科目拆分后重新导入"})
        except (ValueError, TypeError, AttributeError, KeyError, ParseError, zipfile.BadZipFile) as error:
            return self.send_json(422, {"error": str(error) or "文档格式无法读取"})
        self.send_json(200, {"groups": groups})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", default=8765, type=int)
    parser.add_argument("--data", type=Path, default=ROOT / "data")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    args.data.mkdir(parents=True, exist_ok=True)
    database = args.data / "study.sqlite3"
    with sqlite3.connect(database) as db:
        db.execute("CREATE TABLE IF NOT EXISTS state (revision INTEGER, payload TEXT)")
        if db.execute("SELECT COUNT(*) FROM state").fetchone()[0] == 0:
            db.execute("INSERT INTO state VALUES (0, 'null')")
    with ThreadingHTTPServer(("127.0.0.1", args.port), Handler) as server:
        server.database = database
        url = f"http://127.0.0.1:{server.server_port}/"
        print(url, flush=True)
        if not args.no_browser:
            threading.Timer(0.3, partial(webbrowser.open, url)).start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
