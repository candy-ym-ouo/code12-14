# -*- coding: utf-8 -*-
"""端到端：真实 HTTP 起服务，走通建株→照片→对齐→裁剪→并发标注→事件→裁决。"""

import json
import os
import sys
import threading
import time
import unittest
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server as srv  # noqa: E402


class ServerHarness:
    def __init__(self):
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *a):
        self.httpd.shutdown()
        self.httpd.server_close()

    def url(self, path):
        return f"http://127.0.0.1:{self.port}{path}"

    def req(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url(path), data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode())


class TestEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.h = ServerHarness()
        cls.h.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.h.__exit__()

    def setUp(self):
        self.h.req("POST", "/api/branches", {"name": "测试枝条"})
        # 上面建了但没记 id；重新建一个并保存
        st, self.branch = self.h.req("POST", "/api/branches", {"name": "测试枝条2"})
        self.bid = self.branch["id"]

    # ------------------------------------------------------------------ #
    def test_branch_snapshot_empty(self):
        st, snap = self.h.req("GET", f"/api/branches/{self.bid}")
        self.assertEqual(st, 200)
        self.assertEqual(snap["photos"], [])
        self.assertEqual(snap["annotations"], [])
        self.assertEqual(snap["version"], 1)

    def test_align_affine_and_homography(self):
        # 3 对 -> 仿射
        st, r = self.h.req("POST", "/api/align", {
            "srcPts": [[0, 0], [1, 0], [0, 1]],
            "dstPts": [[0.1, 0.2], [0.9, 0.25], [0.15, 0.9]],
        })
        self.assertEqual(st, 200)
        self.assertEqual(len(r["frame"]), 3)
        self.assertLess(r["rms"], 1e-9)

        # 4 对 -> 单应（已知 H 生成点对，必须高精度还原）
        H = [[1.1, 0.05, 0.02], [0.0, 0.95, 0.03], [0.07, 0.01, 1.0]]

        def apply(p):
            x, y = p
            w = H[2][0] * x + H[2][1] * y + 1
            return [(H[0][0] * x + H[0][1] * y + H[0][2]) / w,
                    (H[1][0] * x + H[1][1] * y + H[1][2]) / w]

        src = [[0, 0], [1, 0], [1, 1], [0, 1]]
        dst = [apply(p) for p in src]
        st, r = self.h.req("POST", "/api/align", {"srcPts": src, "dstPts": dst})
        self.assertEqual(st, 200)
        self.assertLess(r["rms"], 1e-6)
        self.assertNotAlmostEqual(r["frame"][2][0], 0.0)  # 确实是透视矩阵

    def test_full_photo_crop_annotation_flow(self):
        # 1) 底图
        st, base = self.h.req("PUT", f"/api/branches/{self.bid}/photos", {
            "year": "2023", "label": "2023", "width": 1200, "height": 800,
        })
        self.assertEqual(st, 201)
        base_id = base["id"]

        # 2) 2024 配准照片（单应，parent=base）
        H = [[0.9, 0.04, 0.05], [-0.03, 0.95, 0.02], [0.08, 0.02, 1.0]]
        st, y2024 = self.h.req("PUT", f"/api/branches/{self.bid}/photos", {
            "parentId": base_id, "year": "2024", "label": "2024",
            "width": 1080, "height": 780, "frame": H,
        })
        yid = y2024["id"]

        # 3) 2024 局部裁剪：服务端算 frame + 子尺寸
        rect = [0.2, 0.3, 0.5, 0.4]
        st, info = self.h.req("POST", f"/api/branches/{self.bid}/photos/crop-info",
                              {"parentId": yid, "rect": rect})
        self.assertEqual(st, 200)
        self.assertEqual((info["width"], info["height"]), (540, 312))
        st, crop = self.h.req("PUT", f"/api/branches/{self.bid}/photos", {
            "parentId": yid, "label": "特写", "year": "2024",
            "width": info["width"], "height": info["height"],
            "frame": info["frame"], "cropRect": rect,
        })
        cid = crop["id"]

        # 4) 标注写底图坐标
        doc = {"kind": "point", "label": "顶芽", "color": "#f00",
               "deleted": False, "geometry": {"x": 0.42, "y": 0.5}}
        st, r = self.h.req("PUT",
            f"/api/branches/{self.bid}/annotations/anno1/commit",
            {"clientId": "alice", "revision": 1, "base": None,
             "proposed": doc, "baseVV": None})
        self.assertEqual(st, 200)
        self.assertEqual(r["conflicts"], [])

        # 5) 快照中可见该标注
        st, snap = self.h.req("GET", f"/api/branches/{self.bid}")
        self.assertEqual(len(snap["annotations"]), 1)
        self.assertEqual(snap["vvs"]["anno1"], {"alice": 1})
        photo_ids = [p["id"] for p in snap["photos"]]
        self.assertEqual(set(photo_ids), {base_id, yid, cid})

    def test_concurrent_commits_and_resolve(self):
        doc = {"kind": "rect", "label": "区域", "color": "#00f",
               "deleted": False, "geometry": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.3}}
        st, r = self.h.req("PUT",
            f"/api/branches/{self.bid}/annotations/aX/commit",
            {"clientId": "alice", "revision": 1, "base": None,
             "proposed": doc, "baseVV": None})
        base_vv = r["vv"]

        # bob 先改 color
        st, rb = self.h.req("PUT",
            f"/api/branches/{self.bid}/annotations/aX/commit",
            {"clientId": "bob", "revision": 1, "base": doc,
             "proposed": {**doc, "color": "#0a0"}, "baseVV": base_vv})
        self.assertEqual(st, 200)

        # alice 在同一 base 改 label -> 自动合并
        st, ra = self.h.req("PUT",
            f"/api/branches/{self.bid}/annotations/aX/commit",
            {"clientId": "alice", "revision": 2, "base": doc,
             "proposed": {**doc, "label": "新区域"}, "baseVV": base_vv})
        self.assertEqual(st, 200)
        self.assertEqual(ra["annotation"]["color"], "#0a0")
        self.assertEqual(ra["annotation"]["label"], "新区域")

        # 同字段并发：carol 与 bob 基于当前 vv，改同一 label
        cur_doc = ra["annotation"]; cur_vv = ra["vv"]
        st, r1 = self.h.req("PUT",
            f"/api/branches/{self.bid}/annotations/aX/commit",
            {"clientId": "bob", "revision": 2, "base": cur_doc,
             "proposed": {**cur_doc, "label": "bob版"}, "baseVV": cur_vv})
        self.assertEqual(st, 200)
        st, r2 = self.h.req("PUT",
            f"/api/branches/{self.bid}/annotations/aX/commit",
            {"clientId": "carol", "revision": 1, "base": cur_doc,
             "proposed": {**cur_doc, "label": "carol版"}, "baseVV": cur_vv})
        self.assertEqual(st, 409)
        self.assertEqual(len(r2["conflicts"]), 1)
        self.assertEqual(r2["annotation"]["label"], "bob版")  # 先到先得

        # 裁决为 carol 的值
        st, rr = self.h.req("POST",
            f"/api/branches/{self.bid}/annotations/aX/resolve",
            {"clientId": "alice", "revision": 3,
             "path": r2["conflicts"][0]["path"], "value": "carol版"})
        self.assertEqual(st, 200)
        self.assertEqual(rr["annotation"]["label"], "carol版")

    def test_long_poll_event_unblocks_on_commit(self):
        doc = {"kind": "point", "label": "x", "color": "#111",
               "deleted": False, "geometry": {"x": 0.5, "y": 0.5}}
        st, snap = self.h.req("GET", f"/api/branches/{self.bid}")
        after = snap["version"]
        result = {}

        def wait():
            req = urllib.request.Request(
                self.h.url(f"/api/branches/{self.bid}/events?after={after}"))
            with urllib.request.urlopen(req, timeout=10) as r:
                result["data"] = json.loads(r.read().decode())

        t = threading.Thread(target=wait)
        t.start()
        time.sleep(0.4)  # 确保进入等待
        self.h.req("PUT", f"/api/branches/{self.bid}/annotations/ev1/commit",
                   {"clientId": "alice", "revision": 1, "base": None,
                    "proposed": doc, "baseVV": None})
        t.join(timeout=3)
        self.assertIn("data", result)
        self.assertGreater(result["data"]["version"], after)
        self.assertEqual(result["data"]["event"]["kind"], "annotation")

    def test_404_for_missing_branch_and_bad_input(self):
        st, _ = self.h.req("GET", "/api/branches/nope")
        self.assertEqual(st, 404)
        st, _ = self.h.req("POST", "/api/align",
                           {"srcPts": [[0, 0], [1, 1]], "dstPts": [[0, 0], [1, 1]]})
        self.assertEqual(st, 400)

    def test_static_index(self):
        with urllib.request.urlopen(self.h.url("/"), timeout=5) as r:
            body = r.read().decode()
        self.assertEqual(r.status, 200)
        self.assertIn("跨年份", body)


if __name__ == "__main__":
    unittest.main()
