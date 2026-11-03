#!/usr/bin/env python3
"""Local-only editing server for this static site.

Run from anywhere:   python3 tools/site-editor/serve.py
Then open:           http://localhost:4000/

View mode (default) serves the site as-is plus a small "Edit page" button.
Edit mode (?edit) serves the page with its own scripts turned off, marks the
editable blocks with their exact source spans, and loads the editor UI.

Saving replaces only spans this server offered for the file's current
content, so bytes outside the edited blocks never change. The editor code is
injected at serve time only; the files on disk (and GitHub Pages) never
reference it. Standard library only.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import re
import sys
import webbrowser
from html.parser import HTMLParser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

TOOL_DIR = Path(__file__).resolve().parent
ROOT = TOOL_DIR.parent.parent
UPLOAD_DIR = "images/uploads"
MAX_UPLOAD = 25 * 1024 * 1024
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"}

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "param", "source", "track", "wbr"}
# Elements that may become an editable block.
CANDIDATE = {"main", "article", "section", "header", "footer", "nav", "aside",
             "div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
             "figure", "figcaption", "blockquote", "table", "thead", "tbody",
             "tr", "td", "th", "dl", "dt", "dd", "details", "summary", "pre"}
# Nothing inside these elements is ever an editable block.
OPAQUE = {"head", "script", "style", "svg", "math", "template", "noscript",
          "textarea", "select", "iframe", "object", "canvas"}
UNTAGGED = {"html", "head", "body"}

WS = re.compile(r"\s+")


def text_len(s: str) -> int:
    return len(WS.sub(" ", s).strip())


class Scan(HTMLParser):
    """Record every body element's exact source span.

    Each element gets (outer_start, inner_start, inner_end, outer_end, text_len,
    is_block). Spans exist only for explicitly closed, properly nested elements
    (and void/self-closing ones), so a span is exactly the source of what the
    browser parses as that element. The client checks text_len to catch the
    rare case where the browser restructured the markup anyway.

    is_block marks elements that can become an editable block: a CANDIDATE tag,
    not inside OPAQUE content, and with no <script> inside it.
    """

    def __init__(self, src: str):
        super().__init__(convert_charrefs=True)
        self.src = src
        self.line_starts = [0]
        for m in re.finditer("\n", src):
            self.line_starts.append(m.end())
        self.stack: list[dict] = []
        self.elements: list[tuple] = []  # (tag_insert_at, os, is, ie, oe, n, is_block)
        self.scripts: list[int] = []  # offsets just after '<script'
        self.head_end: int | None = None
        self.body_end: int | None = None
        self.site_style: tuple[int, int] | None = None
        self.has_katex_css = False

    def _off(self) -> int:
        line, col = self.getpos()
        return self.line_starts[line - 1] + col

    def _in_head(self) -> bool:
        return any(e["tag"] == "head" for e in self.stack)

    def _open(self, tag, attrs, self_closing: bool):
        a = dict(attrs)
        start = self._off()
        text = self.get_starttag_text() or ""
        if tag == "script":
            self.scripts.append(start + len("<script"))
            for e in self.stack:
                e["script"] = True
        if tag == "link" and "katex" in (a.get("href") or ""):
            self.has_katex_css = True
        insert_at = start + len(text) - (2 if text.endswith("/>") else 1)
        tagged = tag not in UNTAGGED and not self._in_head()
        if tag in VOID or self_closing:
            if tagged:
                end = start + len(text)
                self.elements.append((insert_at, start, end, end, end, 0, False))
            return
        opaque = tag in OPAQUE or (bool(self.stack) and self.stack[-1]["opaque"])
        self.stack.append({"tag": tag, "start": start, "inner": start + len(text),
                           "insert_at": insert_at, "tagged": tagged, "opaque": opaque,
                           "script": False, "text": [], "id": a.get("id")})

    def handle_starttag(self, tag, attrs):
        self._open(tag, attrs, False)

    def handle_startendtag(self, tag, attrs):
        self._open(tag, attrs, True)

    def handle_data(self, data):
        for e in self.stack:
            e["text"].append(data)

    def handle_endtag(self, tag):
        pos = self._off()
        if tag == "head":
            self.head_end = pos
        if tag == "body":
            self.body_end = pos
        idx = next((i for i in range(len(self.stack) - 1, -1, -1)
                    if self.stack[i]["tag"] == tag), None)
        if idx is None:
            return
        e = self.stack[idx]
        del self.stack[idx:]  # unclosed children above it are dropped, never tagged
        end = self.src.index(">", pos) + 1
        if tag == "style" and e["id"] == "site-style":
            self.site_style = (e["start"], end)
        if e["tagged"]:
            block = e["tag"] in CANDIDATE and not e["opaque"] and not e["script"]
            self.elements.append((e["insert_at"], e["start"], e["inner"], pos, end,
                                  text_len("".join(e["text"])), block))

    @property
    def blocks(self) -> list[tuple[int, int]]:
        return [(i, j) for _, _, i, j, _, _, b in self.elements if b]


def scan(src: str) -> Scan:
    s = Scan(src)
    s.feed(src)
    s.close()
    return s


def allowed_spans(s: Scan) -> set[tuple[int, int]]:
    spans = set(s.blocks)
    if s.site_style:
        spans.add(s.site_style)
    if s.head_end is not None:
        spans.add((s.head_end, s.head_end))
    return spans


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def inject(src: str, rel: str, digest: str, edit: bool) -> str:
    s = scan(src)
    inserts: list[tuple[int, str]] = []
    meta = {"mode": "edit" if edit else "view", "path": rel}
    if edit:
        for at, os_, is_, ie, oe, n, block in s.elements:
            inserts.append((at, f' data-edit="{os_}:{is_}:{ie}:{oe}:{n}:{int(block)}"'))
        for off in s.scripts:
            inserts.append((off, ' type="text/x-site-editor-off"'))
        meta.update(hash=digest, headEnd=s.head_end, siteStyle=s.site_style,
                    hasKatexCss=s.has_katex_css)
    payload = json.dumps(meta).replace("</", "<\\/")
    tail = (f'<script id="__site-editor-meta" type="application/json">{payload}</script>'
            '<link rel="stylesheet" href="/__edit/editor.css">'
            '<script src="/__edit/editor.js"></script>\n')
    inserts.append((s.body_end if s.body_end is not None else len(src), tail))
    out = src
    for off, text in sorted(inserts, key=lambda t: t[0], reverse=True):
        out = out[:off] + text + out[off:]
    return out


def apply_edits(src: str, edits: list[dict], allowed: set[tuple[int, int]]) -> str:
    spans = []
    for e in edits:
        a, b, h = int(e["start"]), int(e["end"]), e["html"]
        if not isinstance(h, str):
            raise ValueError("html must be a string")
        if (a, b) not in allowed:
            raise ValueError(f"span {a}:{b} is not an editable block of this file")
        spans.append((a, b, h))
    spans.sort(key=lambda t: (t[0], t[1]))
    for (a1, b1, _), (a2, b2, _) in zip(spans, spans[1:]):
        if a2 < b1 or (a1 == b1 == a2 == b2):
            raise ValueError("edits overlap")
    out = src
    for a, b, h in reversed(spans):
        out = out[:a] + h + out[b:]
    return out


def slug(name: str) -> str:
    stem, ext = os.path.splitext(name)
    stem = re.sub(r"[^a-zA-Z0-9]+", "-", stem).strip("-").lower()[:60] or "image"
    return stem, ext.lower()


class Handler(SimpleHTTPRequestHandler):
    server_version = "SiteEditor/1"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    # -- guards -----------------------------------------------------------
    def _local_host(self) -> bool:
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        return host in {"localhost", "127.0.0.1", "::1"}

    def _local_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        host = (urlsplit(origin).hostname or "").lower()
        return host in {"localhost", "127.0.0.1", "::1"}

    def _resolve(self, url_path: str) -> Path | None:
        rel = unquote(url_path).lstrip("/")
        if any(part.startswith(".") for part in Path(rel).parts):
            return None  # never serve .git, .env, ...
        p = (ROOT / rel).resolve()
        if p != ROOT and ROOT not in p.parents:
            return None
        return p

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj).encode(), "application/json")

    # -- GET --------------------------------------------------------------
    def do_GET(self):
        if not self._local_host():
            return self._send(403, b"Forbidden host", "text/plain")
        parts = urlsplit(self.path)
        if parts.path in ("/__edit/editor.js", "/__edit/editor.css"):
            f = TOOL_DIR / parts.path.rsplit("/", 1)[1]
            ctype = "text/javascript" if f.suffix == ".js" else "text/css"
            return self._send(200, f.read_bytes(), ctype + "; charset=utf-8")
        if parts.path == "/__edit/source":
            try:
                p = self._page(parse_qs(parts.query)["path"][0])
            except (ValueError, KeyError) as exc:
                return self._json(400, {"error": str(exc)})
            raw = p.read_bytes()
            return self._json(200, {"text": raw.decode("utf-8"), "hash": sha(raw)})
        p = self._resolve(parts.path)
        if p is None:
            return self._send(404, b"Not found", "text/plain")
        if p.is_dir():
            if not parts.path.endswith("/"):
                self.send_response(HTTPStatus.MOVED_PERMANENTLY)
                self.send_header("Location", parts.path + "/" + (f"?{parts.query}" if parts.query else ""))
                self.end_headers()
                return
            p = p / "index.html"
        if p.suffix == ".html" and p.is_file():
            raw = p.read_bytes()
            edit = "edit" in parse_qs(parts.query, keep_blank_values=True)
            rel = p.relative_to(ROOT).as_posix()
            body = inject(raw.decode("utf-8"), rel, sha(raw), edit).encode("utf-8")
            return self._send(200, body, "text/html; charset=utf-8")
        return super().do_GET()

    def end_headers(self):
        if not self.path.startswith("/__edit/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # -- POST -------------------------------------------------------------
    def do_POST(self):
        if not (self._local_host() and self._local_origin()
                and self.headers.get("X-Site-Editor") == "1"):
            return self._json(403, {"error": "Requests must come from the local editor."})
        parts = urlsplit(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_UPLOAD:
            return self._json(413, {"error": "File is larger than 25 MB."})
        body = self.rfile.read(length)
        try:
            if parts.path == "/__edit/save":
                return self._save(json.loads(body))
            if parts.path == "/__edit/upload":
                return self._upload(parse_qs(parts.query), body)
        except (ValueError, KeyError, TypeError) as exc:
            return self._json(400, {"error": str(exc)})
        return self._json(404, {"error": "Unknown endpoint"})

    def _page(self, rel: str) -> Path:
        p = self._resolve("/" + rel)
        if p is None or p.suffix != ".html" or not p.is_file():
            raise ValueError(f"{rel} is not an HTML file in the site")
        return p

    def _save(self, req: dict):
        p = self._page(req["path"])
        raw = p.read_bytes()
        if sha(raw) != req["hash"]:
            return self._json(409, {"error": "This file changed on disk after the page loaded. "
                                             "Copy your unsaved text, then reload."})
        src = raw.decode("utf-8")
        out = apply_edits(src, req["edits"], allowed_spans(scan(src)))
        data = out.encode("utf-8")
        tmp = p.with_name(f".{p.name}.site-editor.tmp")
        tmp.write_bytes(data)
        os.replace(tmp, p)
        print(f"  saved {req['path']} ({len(req['edits'])} block(s))", flush=True)
        return self._json(200, {"hash": sha(data)})

    def _upload(self, q: dict, body: bytes):
        page = self._page(q["page"][0])
        stem, ext = slug(q["name"][0])
        if ext not in IMAGE_EXT:
            raise ValueError(f"Unsupported image type {ext or '(none)'}")
        if not body:
            raise ValueError("Empty file")
        folder = ROOT / UPLOAD_DIR
        folder.mkdir(parents=True, exist_ok=True)
        base = f"{_dt.date.today():%Y%m%d}-{stem}"
        target = folder / f"{base}{ext}"
        n = 2
        while target.exists():
            target = folder / f"{base}-{n}{ext}"
            n += 1
        target.write_bytes(body)
        src = os.path.relpath(target, page.parent).replace(os.sep, "/")
        print(f"  uploaded {target.relative_to(ROOT).as_posix()}", flush=True)
        return self._json(200, {"src": src})

    def log_message(self, fmt, *args):
        if os.environ.get("SITE_EDITOR_VERBOSE"):
            super().log_message(fmt, *args)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=4000)
    ap.add_argument("--open", action="store_true", help="open the site in your browser")
    args = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://localhost:{args.port}/"
    print(f"Site editor serving {ROOT}\n  {url}  (add ?edit to any page, or click 'Edit page')\n  Ctrl+C to stop",
          flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
