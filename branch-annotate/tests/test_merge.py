# -*- coding: utf-8 -*-
"""三向合并测试：字段自动合并、同值收敛、同字段冲突、删除/裁决。"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from merge import (  # noqa: E402
    flatten, unflatten, merge_annotation, resolve_conflict,
    changed_paths, DELETED,
)


def make_doc(**over):
    doc = {"id": "a1", "kind": "polygon", "label": "新芽",
           "color": "#f00", "deleted": False,
           "geometry": {"points": [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]]}}
    doc.update(over)
    return doc


class TestFlatten(unittest.TestCase):
    def test_roundtrip(self):
        doc = make_doc()
        self.assertEqual(unflatten(flatten(doc)), doc)

    def test_changed_paths(self):
        base = make_doc()
        prop = make_doc(label="改了")
        changed = changed_paths(base, prop)
        self.assertIn(("label",), changed)
        self.assertNotIn(("color",), changed)


class TestMerge(unittest.TestCase):
    def test_single_writer(self):
        base = make_doc()
        cur, vv, conflicts = merge_annotation(
            None, None, None, base, None, "alice", 1)
        self.assertFalse(conflicts)
        self.assertEqual(vv, {"alice": 1})
        self.assertEqual(cur["label"], "新芽")

    def test_non_concurrent_edit(self):
        base = make_doc()
        cur, vv, _ = merge_annotation(None, None, None, base, None, "alice", 1)
        prop = make_doc(label="新名")
        cur2, vv2, conflicts = merge_annotation(
            cur, vv, base, prop, {"alice": 1}, "alice", 2)
        self.assertFalse(conflicts)
        self.assertEqual(cur2["label"], "新名")
        self.assertEqual(vv2, {"alice": 2})

    def test_concurrent_different_fields_auto_merge(self):
        base = make_doc()
        cur, vv, _ = merge_annotation(None, None, None, base, None, "alice", 1)

        # bob 在 alice 之后提交改 color（基于 v1 base）
        bob_prop = make_doc(color="#0a0")
        cur_b, vv_b, cf_b = merge_annotation(
            cur, vv, base, bob_prop, {"alice": 1}, "bob", 1)
        self.assertFalse(cf_b)

        # alice 在同一 base 上改 label —— 不同叶子，自动合并
        alice_prop = make_doc(label="顶芽")
        cur_a, vv_a, cf_a = merge_annotation(
            cur_b, vv_b, base, alice_prop, {"alice": 1}, "alice", 2)
        self.assertFalse(cf_a)
        self.assertEqual(cur_a["label"], "顶芽")      # alice 的
        self.assertEqual(cur_a["color"], "#0a0")     # bob 的保留
        # 版本向量收敛
        self.assertEqual(vv_a, {"alice": 2, "bob": 1})

    def test_concurrent_same_value_converges(self):
        base = make_doc()
        cur, vv, _ = merge_annotation(None, None, None, base, None, "alice", 1)
        bob_prop = make_doc(label="同名")
        cur_b, vv_b, _ = merge_annotation(
            cur, vv, base, bob_prop, {"alice": 1}, "bob", 1)
        alice_prop = make_doc(label="同名")
        cur_a, _, cf_a = merge_annotation(
            cur_b, vv_b, base, alice_prop, {"alice": 1}, "alice", 2)
        self.assertFalse(cf_a)
        self.assertEqual(cur_a["label"], "同名")

    def test_concurrent_same_field_conflict_first_wins(self):
        base = make_doc()
        cur, vv, _ = merge_annotation(None, None, None, base, None, "alice", 1)
        bob_prop = make_doc(label="bob名")
        cur_b, vv_b, _ = merge_annotation(
            cur, vv, base, bob_prop, {"alice": 1}, "bob", 1)
        alice_prop = make_doc(label="alice名")
        cur_a, vv_a, cf = merge_annotation(
            cur_b, vv_b, base, alice_prop, {"alice": 1}, "alice", 2)
        self.assertEqual(len(cf), 1)
        self.assertEqual(cf[0]["path"], "label")
        self.assertEqual(cf[0]["winner"], "bob名")
        self.assertEqual(cf[0]["loser"], "alice名")
        self.assertEqual(cf[0]["winnerClient"], "bob")
        self.assertEqual(cf[0]["loserClient"], "alice")
        # 先提交者的值留在文档里
        self.assertEqual(cur_a["label"], "bob名")
        # 输家的写入尝试也进入版本向量
        self.assertEqual(vv_a, {"alice": 2, "bob": 1})

    def test_concurrent_vertex_edits_auto_merge(self):
        # bob 拖第 0 个顶点，alice 同时拖第 1 个顶点 -> 不同叶子，自动合并
        base = make_doc()
        cur, vv, _ = merge_annotation(None, None, None, base, None, "alice", 1)
        bob_doc = make_doc()
        bob_doc["geometry"]["points"][0] = [0.11, 0.22]
        cur_b, vv_b, cf = merge_annotation(
            cur, vv, base, bob_doc, {"alice": 1}, "bob", 1)
        self.assertFalse(cf)
        alice_doc = make_doc()
        alice_doc["geometry"]["points"][1] = [0.33, 0.44]
        cur_a, vv_a, cf = merge_annotation(
            cur_b, vv_b, base, alice_doc, {"alice": 1}, "alice", 2)
        self.assertFalse(cf)
        self.assertEqual(cur_a["geometry"]["points"][0], [0.11, 0.22])
        self.assertEqual(cur_a["geometry"]["points"][1], [0.33, 0.44])

    def test_delete_is_just_field_write(self):
        base = make_doc()
        cur, vv, _ = merge_annotation(None, None, None, base, None, "alice", 1)
        cur_b, vv_b, _ = merge_annotation(
            cur, vv, base, make_doc(label="改名"), {"alice": 1}, "bob", 1)
        # alice 同时删除
        cur_a, _, cf = merge_annotation(
            cur_b, vv_b, base, make_doc(deleted=True), {"alice": 1}, "alice", 2)
        # label 被 bob 改、deleted 被 alice 改：不同叶子，自动合并成“改名了的已删除”
        self.assertFalse(cf)
        self.assertTrue(cur_a["deleted"])
        self.assertEqual(cur_a["label"], "改名")

    def test_resolve_conflict(self):
        base = make_doc()
        cur, vv, _ = merge_annotation(None, None, None, base, None, "alice", 1)
        cur_b, vv_b, _ = merge_annotation(
            cur, vv, base, make_doc(label="bob名"), {"alice": 1}, "bob", 1)
        cur_a, vv_a, cf = merge_annotation(
            cur_b, vv_b, base, make_doc(label="alice名"),
            {"alice": 1}, "alice", 2)
        self.assertTrue(cf)
        # 仲裁：改用 alice 的值
        resolved, rvv = resolve_conflict(
            cur_a, vv_a, "label", "alice名", "carol", 1)
        self.assertEqual(resolved["label"], "alice名")
        self.assertEqual(rvv, {"alice": 2, "bob": 1, "carol": 1})

    def test_geometry_delete_marker(self):
        flat = flatten(make_doc())
        self.assertIn(("geometry", "points", 0, 0), flat)
        doc, _ = resolve_conflict(make_doc(), {"alice": 1},
                                  "geometry.points.2.1", DELETED, "alice", 2)
        self.assertEqual(len(doc["geometry"]["points"]), 3)
        # 第 3 个点的 y 被删除后该点只剩 x（数组尾部裁剪语义）
        self.assertEqual(doc["geometry"]["points"][2], [0.5])


if __name__ == "__main__":
    unittest.main()
