# -*- coding: utf-8 -*-
"""HTTP 服务：零依赖（标准库 http.server）。

接口一览（全部 JSON，同域）::

    POST   /api/branches                       建株
    GET    /api/branches/:bid                  整株快照
    PUT    /api/branches/:bid/photos           新增/更新照片（含 frame、src dataURL）
    DELETE /api/branches/:bid/photos/:pid
    POST   /api/branches/:bid/photos/crop-info 由父图尺寸+裁剪框算 frame/子图尺寸
    POST   /api/align                           控制点配准 -> frame + 残差
    PUT    /api/branches/:bid/annotations/:aid/commit   三向合并提交
    POST   /api/branches/:bid/annotations/:aid/resolve  冲突人工裁决
    DELETE /api/branches/:bid/annotations/:aid
    GET    /api/branches/:bid/events?after=N            长轮询事件
    GET    /                                        静态前端

运行：python3 server.py [--port 8000]
"""

from __future__ import annotations

import argparse
import json
import math
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from store import Store
from geometry import estimate_transform, crop_frame, crop_pixel_dims, residuals

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
}

MAX_BODY = 32 * 1024 * 1024  # 演示图片走 dataURL，放宽到 32MB


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


STORE = Store()


class Handler(BaseHTTPRequestHandler):
    server_version = "BranchAnnotate/1.0"

    # ------------------------------------------------------------------ #
    # 工具
    # ------------------------------------------------------------------ #
    def _send_json(self, obj, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ApiError(413, "请求体过大")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            raise ApiError(400, "非法 JSON")
        if not isinstance(data, dict):
            raise ApiError(400, "请求体必须是 JSON 对象")
        return data

    def log_message(self, fmt, *args):  # 安静一点
        pass

    # ------------------------------------------------------------------ #
    # 路由
    # ------------------------------------------------------------------ #
    def do_GET(self) -> None:
        self._dispatch()

    def do_POST(self) -> None:
        self._dispatch()

    def do_PUT(self) -> None:
        self._dispatch()

    def do_DELETE(self) -> None:
        self._dispatch()

    def _dispatch(self) -> None:
        try:
            parsed = urlparse(self.path)
            path = parsed.path.rstrip("/") or "/"
            qs = parse_qs(parsed.query)
            method = self.command

            if method == "POST" and path == "/api/branches":
                data = self._read_json()
                branch = STORE.create_branch(data.get("name") or "未命名枝条")
                return self._send_json(branch, 201)

            if method == "POST" and path == "/api/align":
                return self._handle_align()

            m = _match(path, "/api/branches/<bid>")
            if m and method == "GET":
                return self._send_json(STORE.snapshot(m["bid"]))

            m = _match(path, "/api/branches/<bid>/events")
            if m and method == "GET":
                after = int(qs.get("after", ["0"])[0])
                ver = STORE.wait_version(m["bid"], after)
                return self._send_json({
                    "version": ver,
                    "event": STORE.last_event(m["bid"]),
                })

            m = _match(path, "/api/branches/<bid>/photos")
            if m and method == "PUT":
                return self._send_json(STORE.put_photo(m["bid"], self._read_json()), 201)

            m = _match(path, "/api/branches/<bid>/photos/crop-info")
            if m and method == "POST":
                return self._handle_crop_info(m["bid"])

            m = _match(path, "/api/branches/<bid>/photos/<pid>")
            if m and method == "DELETE":
                STORE.delete_photo(m["bid"], m["pid"])
                return self._send_json({"ok": True})

            m = _match(path, "/api/branches/<bid>/annotations/<aid>/commit")
            if m and method == "PUT":
                return self._handle_commit(m["bid"], m["aid"])

            m = _match(path, "/api/branches/<bid>/annotations/<aid>/resolve")
            if m and method == "POST":
                return self._handle_resolve(m["bid"], m["aid"])

            m = _match(path, "/api/branches/<bid>/annotations/<aid>")
            if m and method == "DELETE":
                STORE.delete_annotation(m["bid"], m["aid"])
                return self._send_json({"ok": True})

            if method == "GET":
                return self._serve_static(path)

            raise ApiError(404, "接口不存在")
        except ApiError as e:
            self._send_json({"error": e.message}, e.status)
        except KeyError:
            self._send_json({"error": "资源不存在"}, 404)
        except ValueError as e:
            self._send_json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            self._send_json({"error": f"服务器内部错误: {e}"}, 500)

    # ------------------------------------------------------------------ #
    # 各接口
    # ------------------------------------------------------------------ #
    def _handle_align(self) -> None:
        data = self._read_json()
        src = [(float(p[0]), float(p[1])) for p in data["srcPts"]]
        dst = [(float(p[0]), float(p[1])) for p in data["dstPts"]]
        frame = estimate_transform(src, dst)
        res = residuals(src, dst, frame)
        rms = math.sqrt(sum(r * r for r in res) / len(res))
        self._send_json({"frame": frame.to_list(), "residuals": res, "rms": rms})

    def _handle_crop_info(self, bid: str) -> None:
        data = self._read_json()
        parent = STORE.photos[bid][data["parentId"]]
        rect = tuple(float(v) for v in data["rect"])  # x,y,w,h 归一化
        frame = crop_frame(rect).to_list()
        w, h = crop_pixel_dims(parent["width"], parent["height"], rect)
        self._send_json({"frame": frame, "width": w, "height": h})

    def _handle_commit(self, bid: str, aid: str) -> None:
        data = self._read_json()
        required = ("clientId", "revision")
        for key in required:
            if key not in data:
                raise ApiError(400, f"缺少字段 {key}")
        result = STORE.commit_annotation(
            bid=bid,
            client_id=str(data["clientId"]),
            revision=int(data["revision"]),
            aid=aid,
            base=data.get("base"),
            proposed=data.get("proposed"),
            base_vv=data.get("baseVV"),
        )
        # 有冲突时用 409，客户端仍可读取完整合并结果；无冲突 200
        self._send_json(result, 409 if result["conflicts"] else 200)

    def _handle_resolve(self, bid: str, aid: str) -> None:
        data = self._read_json()
        result = STORE.resolve(
            bid, aid,
            client_id=str(data["clientId"]),
            revision=int(data["revision"]),
            path=str(data["path"]),
            value=data.get("value"),
        )
        self._send_json(result)

    # ------------------------------------------------------------------ #
    # 静态文件
    # ------------------------------------------------------------------ #
    def _serve_static(self, path: str) -> None:
        rel = "index.html" if path == "/" else path.lstrip("/")
        target = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not target.startswith(STATIC_DIR) or not os.path.isfile(target):
            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write("404".encode())
            return
        ext = os.path.splitext(target)[1]
        body = open(target, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def _match(path: str, pattern: str):
    """极简路径匹配：/api/branches/<bid>/... -> {bid: ...}。"""
    pa = [p for p in path.split("/") if p]
    pp = [p for p in pattern.split("/") if p]
    if len(pa) != len(pp):
        return None
    out = {}
    for a, p in zip(pa, pp):
        if p.startswith("<") and p.endswith(">"):
            out[p[1:-1]] = a
        elif a != p:
            return None
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"照片标注服务已启动: http://{args.host}:{args.port}/")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
