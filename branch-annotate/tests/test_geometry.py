# -*- coding: utf-8 -*-
"""几何层测试：仿射/单应、裁剪坐标链、Viewport 缩放平移还原。"""

import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from geometry import (  # noqa: E402
    Frame, estimate_affine, estimate_homography, estimate_transform,
    crop_frame, chain_frame, Viewport, inverse3, matmul, residuals,
)


class TestFrame(unittest.TestCase):
    def test_affine_roundtrip(self):
        f = Frame.affine(2.0, 0.3, -0.1, -0.2, 1.5, 0.4)
        pt = (0.37, 0.81)
        back = f.inverse().apply(f.apply(pt))
        self.assertAlmostEqual(back[0], pt[0], places=10)
        self.assertAlmostEqual(back[1], pt[1], places=10)

    def test_homography_roundtrip_and_warp(self):
        h = [[0.9, 0.04, 0.05], [-0.03, 0.95, 0.02], [0.08, 0.02, 1.0]]
        f = Frame(h)
        for pt in [(0, 0), (1, 0), (0, 1), (1, 1), (0.37, 0.62)]:
            m = f.apply(pt)
            back = f.inverse().apply(m)
            self.assertAlmostEqual(back[0], pt[0], places=9)
            self.assertAlmostEqual(back[1], pt[1], places=9)

    def test_compose_order(self):
        a = Frame.affine(2, 0, 0.1, 0, 2, 0.2)      # 缩放+平移
        b = Frame.affine(1, 0, -0.05, 0, 1, 0.05)   # 再平移
        c = a.then(b)
        pt = (0.3, 0.4)
        self.assertEqual(tuple(round(v, 9) for v in c.apply(pt)),
                         tuple(round(v, 9) for v in b.apply(a.apply(pt))))

    def test_estimate_affine_exact(self):
        true_f = Frame.affine(0.8, -0.1, 0.2, 0.15, 1.1, -0.05)
        src = [(0.1, 0.2), (0.8, 0.3), (0.4, 0.9), (0.6, 0.5)]
        dst = true_f.apply_points(src)
        est = estimate_affine(src[:3], dst[:3])
        for p, d in zip(src, dst):
            m = est.apply(p)
            self.assertAlmostEqual(m[0], d[0], places=8)
            self.assertAlmostEqual(m[1], d[1], places=8)
        # 第 4 对点（共面）残差应极小
        self.assertLess(max(residuals(src, dst, est)), 1e-8)

    def test_estimate_homography_exact(self):
        true_h = [[1.2, 0.1, 0.05], [0.05, 0.9, 0.08], [0.1, 0.02, 1.0]]
        f = Frame(true_h)
        src = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0),
               (0.3, 0.4), (0.7, 0.2), (0.6, 0.8)]
        dst = f.apply_points(src)
        est = estimate_homography(src[:4], dst[:4])
        for p, d in zip(src, dst):
            m = est.apply(p)
            self.assertAlmostEqual(m[0], d[0], places=6)
            self.assertAlmostEqual(m[1], d[1], places=6)

    def test_estimate_homography_noisy_is_better_than_affine(self):
        # 5+ 对带噪声点，单应最小二乘 RMS 应为有限且较小
        true_h = [[0.9, 0.05, 0.02], [0.0, 1.05, 0.01], [0.05, 0.0, 1.0]]
        f = Frame(true_h)
        src = [(i / 4, j / 4) for i in range(5) for j in range(5)]
        dst = f.apply_points(src)
        est = estimate_transform(src, dst)
        rms = math.sqrt(sum(r * r for r in residuals(src, dst, est)) / len(src))
        self.assertLess(rms, 1e-6)

    def test_invalid_point_counts(self):
        with self.assertRaises(ValueError):
            estimate_transform([(0, 0), (1, 1)], [(0, 0), (1, 1)])
        with self.assertRaises(ValueError):
            estimate_homography([(0, 0)] * 3, [(0, 0)] * 3)


class TestCropChain(unittest.TestCase):
    def test_crop_maps_region_to_unit_square(self):
        rect = (0.2, 0.3, 0.5, 0.4)
        f = crop_frame(rect)
        # 裁剪区四角 -> 子图四角
        for (px, py), (ex, ey) in zip(
            [(0.2, 0.3), (0.7, 0.3), (0.7, 0.7), (0.2, 0.7)],
            [(0, 0), (1, 0), (1, 1), (0, 1)],
        ):
            m = f.apply((px, py))
            self.assertAlmostEqual(m[0], ex, places=10)
            self.assertAlmostEqual(m[1], ey, places=10)

    def test_chain_base_to_year_then_crop_back(self):
        # 底图 -> 2024 单应 -> 2024 局部裁剪；标注经两跳映射再回来必须还原
        photos = {
            "base": {"id": "base", "parentId": None, "frame": None},
            "y2024": {"id": "y2024", "parentId": "base",
                      "frame": [[0.9, 0.04, 0.05], [-0.03, 0.95, 0.02],
                                [0.08, 0.02, 1.0]]},
            "crop": {"id": "crop", "parentId": "y2024",
                     "frame": crop_frame((0.2, 0.3, 0.5, 0.4)).to_list()},
        }
        f = chain_frame(photos, "crop")
        finv = f.inverse()
        # 选裁剪区 [0.2,0.7]x[0.3,0.7] 内部的点：映射后应落在子图 [0,1]^2
        for pt in [(0.31, 0.42), (0.40, 0.50), (0.55, 0.45)]:
            m = f.apply(pt)
            self.assertTrue(0.0 - 1e-9 <= m[0] <= 1.0 + 1e-9
                            and 0.0 - 1e-9 <= m[1] <= 1.0 + 1e-9,
                            f"{pt} -> {m} 应在裁剪图内")
            back = finv.apply(m)
            self.assertAlmostEqual(back[0], pt[0], places=9)
            self.assertAlmostEqual(back[1], pt[1], places=9)
        # 裁剪区外的点：虽不显示在子图中，数学上映射仍可往返还原
        for pt in [(0.9, 0.9), (0.05, 0.05)]:
            back = finv.apply(f.apply(pt))
            self.assertAlmostEqual(back[0], pt[0], places=9)
            self.assertAlmostEqual(back[1], pt[1], places=9)

    def test_chain_identity_for_base(self):
        photos = {"base": {"id": "base", "parentId": None, "frame": None}}
        f = chain_frame(photos, "base")
        self.assertEqual(f.apply((0.25, 0.75)), (0.25, 0.75))

    def test_cycle_detection(self):
        photos = {
            "a": {"id": "a", "parentId": "b", "frame": None},
            "b": {"id": "b", "parentId": "a", "frame": None},
        }
        with self.assertRaises(ValueError):
            chain_frame(photos, "a")


class TestViewport(unittest.TestCase):
    def setUp(self):
        self.vp = Viewport(1000, 800, 500, 400)

    def test_roundtrip(self):
        for s in [(0, 0), (250, 200), (12.5, 380.2)]:
            n = self.vp.screen_to_norm(*s)
            self.assertEqual(tuple(round(x, 9) for x in self.vp.norm_to_screen(*n)),
                             tuple(round(x, 9) for x in s))

    def test_zoom_anchor_keeps_image_point_fixed(self):
        # 锚点缩放：屏幕 (210,150) 下的归一化图像点在缩放前后不变
        before = self.vp.screen_to_norm(210, 150)
        self.vp.zoom_at(1.6, 210, 150)
        after = self.vp.screen_to_norm(210, 150)
        self.assertAlmostEqual(before[0], after[0], places=10)
        self.assertAlmostEqual(before[1], after[1], places=10)

    def test_pan_and_fit(self):
        # pan(dx,dy) 把图像内容在屏幕上向右下拖动 (dx,dy)：
        # pan 前屏幕 (100,100) 的内容，pan(30,-20) 后出现在 (130,80)
        n_before = self.vp.screen_to_norm(100, 100)
        self.vp.pan(30, -20)
        n_after = self.vp.screen_to_norm(130, 80)
        self.assertAlmostEqual(n_before[0], n_after[0], places=10)
        self.assertAlmostEqual(n_before[1], n_after[1], places=10)
        self.vp.fit()
        self.assertLess(self.vp.scale, 1)

    def test_storage_coords_immune_to_view_changes(self):
        # 标注存在归一化坐标里，任何 viewport 操作后语义坐标仍是原值
        anno = (0.42, 0.57)
        for factor in (0.5, 2.0, 3.3):
            self.vp.zoom_at(factor, 250, 200)
            self.vp.pan(17, -9)
            s = self.vp.norm_to_screen(*anno)
            back = self.vp.screen_to_norm(*s)
            self.assertAlmostEqual(back[0], anno[0], places=9)
            self.assertAlmostEqual(back[1], anno[1], places=9)


class TestMatrixUtils(unittest.TestCase):
    def test_inverse_identity(self):
        self.assertEqual(inverse3([[1, 0, 0], [0, 1, 0], [0, 0, 1]]),
                         [[1, 0, 0], [0, 1, 0], [0, 0, 1]])

    def test_matmul_known(self):
        a = [[1, 2, 3], [4, 5, 6], [7, 8, 9]]
        b = identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
        self.assertEqual(matmul(a, b), a)


if __name__ == "__main__":
    unittest.main()
