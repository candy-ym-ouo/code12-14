# -*- coding: utf-8 -*-
"""坐标几何：3x3 坐标变换（仿射 / 单应）、配准估计、Viewport 映射。

坐标空间约定
============
一张照片(photo)记录一个归一化坐标系：左上角 (0,0)，右下角 (1,1)，
与像素分辨率无关。

* 每年照片 / 裁剪照片相对父图保存一个 3x3 矩阵 ``frame``，
  方向固定为 **父图归一化坐标 -> 本图归一化坐标**::

        [x']   [h00 h01 h02] [x]
        [y'] = [h10 h11 h12] [y]
        [w ]   [h20 h21 h22] [1]   再除以 w（仿射时恒为 1）

* base 底图没有父图。沿 parent 链把 frame 串起来，就得到
  “底图坐标 -> 当前照片坐标”的映射；标注全部存在底图坐标系，
  因此跨年份、跨裁剪共用同一套标注。

* Viewport 负责“本图像素坐标 <-> 屏幕 CSS 像素”，缩放/平移只改
  viewport 参数，绝不修改标注本身，所以任何视图操作都可无损还原。

本文件零第三方依赖：齐次 3x3 求逆、高斯消元、Jacobi 特征分解
（用于 DLT 单应估计的最小奇异向量）全部手写。
"""

from __future__ import annotations

import math
from typing import List, Sequence, Tuple

Point = Tuple[float, float]
Matrix3 = List[List[float]]


# --------------------------------------------------------------------------- #
# 基础线性代数
# --------------------------------------------------------------------------- #
def identity3() -> Matrix3:
    return [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]


def matmul(a: Matrix3, b: Matrix3) -> Matrix3:
    """3x3 相乘 a·b（点先经过 b 再经过 a 的调用方请自行注意顺序）。"""
    return [
        [sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)]
        for i in range(3)
    ]


def inverse3(h: Matrix3) -> Matrix3:
    """一般 3x3 求逆（伴随矩阵法），仿射/单应都适用。"""
    (a, b, c), (d, e, f), (g, i, j) = h[0], h[1], h[2]
    det = (
        a * (e * j - f * i)
        - b * (d * j - f * g)
        + c * (d * i - e * g)
    )
    if abs(det) < 1e-15:
        raise ValueError("矩阵不可逆（控制点可能共线/重复）")
    inv_det = 1.0 / det
    return [
        [(e * j - f * i) * inv_det, (c * i - b * j) * inv_det,
         (b * f - c * e) * inv_det],
        [(f * g - d * j) * inv_det, (a * j - c * g) * inv_det,
         (c * d - a * f) * inv_det],
        [(d * i - e * g) * inv_det, (b * g - a * i) * inv_det,
         (a * e - b * d) * inv_det],
    ]


def _solve_linear(a: List[List[float]], b: List[float]) -> List[float]:
    """高斯消元（列主元）解 A x = b，n 很小（<=9）。"""
    n = len(a)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(m[r][col]))
        if abs(m[pivot][col]) < 1e-12:
            raise ValueError("线性方程组奇异")
        m[col], m[pivot] = m[pivot], m[col]
        pv = m[col][col]
        m[col] = [v / pv for v in m[col]]
        for r in range(n):
            if r == col:
                continue
            factor = m[r][col]
            if factor:
                m[r] = [rv - factor * cv for rv, cv in zip(m[r], m[col])]
    return [m[i][n] for i in range(n)]


def _jacobi_eigen(
    a: List[List[float]], tol: float = 1e-13, max_sweeps: int = 100
) -> Tuple[List[float], List[List[float]]]:
    """对称矩阵 Jacobi 特征分解 -> (特征值, V)，V 的第 k 列是第 k 个特征向量。"""
    n = len(a)
    a = [row[:] for row in a]
    v = identity3() if n == 3 else [[1.0 if i == j else 0.0 for j in range(n)]
                                    for i in range(n)]
    for _ in range(max_sweeps):
        off = math.sqrt(sum(a[p][q] ** 2 for p in range(n) for q in range(p + 1, n)))
        if off < tol:
            break
        for p in range(n):
            for q in range(p + 1, n):
                if abs(a[p][q]) < 1e-15:
                    continue
                theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q])
                t = (1.0 if theta >= 0 else -1.0) / (
                    abs(theta) + math.sqrt(theta * theta + 1.0)
                )
                c = 1.0 / math.sqrt(t * t + 1.0)
                s = t * c
                for k in range(n):
                    akp, akq = a[k][p], a[k][q]
                    a[k][p] = c * akp - s * akq
                    a[k][q] = s * akp + c * akq
                for k in range(n):
                    apk, apq = a[p][k], a[q][k]
                    a[p][k] = c * apk - s * apq
                    a[q][k] = s * apk + c * apq
                for k in range(n):
                    vkp, vkq = v[k][p], v[k][q]
                    v[k][p] = c * vkp - s * vkq
                    v[k][q] = s * vkp + c * vkq
    return [a[i][i] for i in range(n)], v


# --------------------------------------------------------------------------- #
# Frame：父图归一化坐标 -> 本图归一化坐标
# --------------------------------------------------------------------------- #
class Frame:
    __slots__ = ("h",)

    def __init__(self, h: Matrix3 | None = None):
        self.h = [row[:] for row in (h or identity3())]

    @staticmethod
    def affine(a: float, b: float, c: float,
               d: float, e: float, f: float) -> "Frame":
        """x' = a x + b y + c ; y' = d x + e y + f。"""
        return Frame([[a, b, c], [d, e, f], [0.0, 0.0, 1.0]])

    def apply(self, pt: Sequence[float]) -> Point:
        x, y = pt[0], pt[1]
        h = self.h
        w = h[2][0] * x + h[2][1] * y + h[2][2]
        return (
            (h[0][0] * x + h[0][1] * y + h[0][2]) / w,
            (h[1][0] * x + h[1][1] * y + h[1][2]) / w,
        )

    def apply_points(self, pts: Sequence[Sequence[float]]) -> List[Point]:
        return [self.apply(p) for p in pts]

    def inverse(self) -> "Frame":
        return Frame(inverse3(self.h))

    def then(self, other: "Frame") -> "Frame":
        """复合：先 self 再 other（self: A->B, other: B->C，返回 A->C）。"""
        return Frame(matmul(other.h, self.h))

    def to_list(self) -> Matrix3:
        return [row[:] for row in self.h]


# --------------------------------------------------------------------------- #
# 配准估计：由控制点对求 frame
# --------------------------------------------------------------------------- #
def _normalizing_transform(pts: Sequence[Point]) -> Tuple[Matrix3, List[Point]]:
    """Hartley 归一化：质心移到原点，平均距离 sqrt(2)，显著提升 DLT 精度。"""
    n = len(pts)
    mx = sum(p[0] for p in pts) / n
    my = sum(p[1] for p in pts) / n
    mean_dist = sum(math.hypot(p[0] - mx, p[1] - my) for p in pts) / n
    s = math.sqrt(2.0) / mean_dist if mean_dist > 1e-12 else 1.0
    t = [[s, 0.0, -s * mx], [0.0, s, -s * my], [0.0, 0.0, 1.0]]
    return t, [((x - mx) * s, (y - my) * s) for x, y in pts]


def estimate_affine(src: Sequence[Point], dst: Sequence[Point]) -> Frame:
    """>=3 对点最小二乘拟合仿射（3 对恰好定解）。"""
    if len(src) != len(dst) or len(src) < 3:
        raise ValueError("仿射配准至少需要 3 对控制点")
    a_rows: List[List[float]] = []
    b_rows: List[float] = []
    for (x, y), (xp, yp) in zip(src, dst):
        a_rows.append([x, y, 1.0, 0.0, 0.0, 0.0])
        b_rows.append(xp)
        a_rows.append([0.0, 0.0, 0.0, x, y, 1.0])
        b_rows.append(yp)
    # 法方程 (A^T A) p = A^T b
    ata = [[sum(a_rows[r][i] * a_rows[r][j] for r in range(len(a_rows)))
            for j in range(6)] for i in range(6)]
    atb = [sum(a_rows[r][i] * b_rows[r] for r in range(len(a_rows)))
           for i in range(6)]
    p = _solve_linear(ata, atb)
    return Frame.affine(p[0], p[1], p[2], p[3], p[4], p[5])


def estimate_homography(src: Sequence[Point], dst: Sequence[Point]) -> Frame:
    """>=4 对点，归一化 DLT 估计单应矩阵。"""
    if len(src) != len(dst) or len(src) < 4:
        raise ValueError("单应配准至少需要 4 对控制点")

    t_src, s_pts = _normalizing_transform(src)
    t_dst, d_pts = _normalizing_transform(dst)

    rows: List[List[float]] = []
    for (x, y), (xp, yp) in zip(s_pts, d_pts):
        rows.append([-x, -y, -1.0, 0.0, 0.0, 0.0, xp * x, xp * y, xp])
        rows.append([0.0, 0.0, 0.0, -x, -y, -1.0, yp * x, yp * y, yp])

    # A h = 0：取 A^T A 最小特征值对应的特征向量
    ata = [[sum(rows[r][i] * rows[r][j] for r in range(len(rows)))
            for j in range(9)] for i in range(9)]
    eigvals, eigvecs = _jacobi_eigen(ata)
    k = min(range(9), key=lambda i: abs(eigvals[i]))
    h_norm = [eigvecs[r][k] for r in range(9)]
    h_norm_m = [h_norm[0:3], h_norm[3:6], h_norm[6:9]]

    # 反归一化：H = T_dst^-1 · H_norm · T_src
    h = matmul(matmul(inverse3(t_dst), h_norm_m), t_src)
    scale = h[2][2] if abs(h[2][2]) > 1e-15 else 1.0
    return Frame([[v / scale for v in row] for row in h])


def estimate_transform(src: Sequence[Point], dst: Sequence[Point]) -> Frame:
    """3 对 -> 仿射；>=4 对 -> 单应。"""
    if len(src) < 3:
        raise ValueError("至少需要 3 对控制点")
    if len(src) == 3:
        return estimate_affine(src, dst)
    return estimate_homography(src, dst)


def residuals(src: Sequence[Point], dst: Sequence[Point], h: Frame) -> List[float]:
    """各控制点经 H 映射后与目标点的像素/归一化距离（RMS 用）。"""
    return [
        math.hypot(m[0] - d[0], m[1] - d[1])
        for m, d in zip(h.apply_points(src), dst)
    ]


# --------------------------------------------------------------------------- #
# 裁剪：父图归一化矩形 -> 裁剪图 frame（纯平移缩放，仍用 3x3 表示）
# --------------------------------------------------------------------------- #
def crop_frame(rect: Tuple[float, float, float, float]) -> Frame:
    """rect=(x,y,w,h) 为父图归一化坐标中的裁剪区域。

    裁剪图把该区域铺满自己的 [0,1]^2，所以::

        x_child = (x_parent - x) / w
    """
    x, y, w, h = rect
    if w <= 0 or h <= 0:
        raise ValueError("裁剪区域宽高必须为正")
    return Frame.affine(1.0 / w, 0.0, -x / w, 0.0, 1.0 / h, -y / h)


def crop_pixel_dims(
    src_w: int, src_h: int, rect: Tuple[float, float, float, float]
) -> Tuple[int, int]:
    _, _, w, h = rect
    return max(1, round(src_w * w)), max(1, round(src_h * h))


# --------------------------------------------------------------------------- #
# 坐标链：底图 -> 指定照片
# --------------------------------------------------------------------------- #
def chain_frame(photos: dict, photo_id: str) -> Frame:
    """沿 parent 链复合 frame，返回 base 归一化 -> photo 归一化。

    photos[id] 需含 parentId(可空) 与 frame(3x3 list)。
    """
    chain: List[Frame] = []
    cur = photos.get(photo_id)
    seen = set()
    while cur is not None:
        if cur["id"] in seen:
            raise ValueError("照片 parent 链存在环")
        seen.add(cur["id"])
        chain.append(Frame(cur.get("frame")))
        pid = cur.get("parentId")
        cur = photos.get(pid) if pid else None
    result = Frame()
    for f in reversed(chain):
        result = result.then(f)
    return result


# --------------------------------------------------------------------------- #
# Viewport：图像像素坐标 <-> 屏幕 CSS 像素
# --------------------------------------------------------------------------- #
class Viewport:
    """img_screen = scale * img_pixel + translate。"""

    def __init__(self, img_w: int, img_h: int,
                 screen_w: float, screen_h: float, fill: float = 0.95):
        self.img_w = float(img_w)
        self.img_h = float(img_h)
        self.screen_w = float(screen_w)
        self.screen_h = float(screen_h)
        self.scale = 1.0
        self.tx = 0.0
        self.ty = 0.0
        self.fitting = True
        self.fit(fill)

    def fit(self, fill: float = 0.95) -> None:
        self.scale = min(self.screen_w / self.img_w,
                         self.screen_h / self.img_h) * fill
        self.tx = (self.screen_w - self.img_w * self.scale) / 2.0
        self.ty = (self.screen_h - self.img_h * self.scale) / 2.0

    def zoom_at(self, factor: float, sx: float, sy: float,
                min_scale: float = 0.02, max_scale: float = 40.0) -> None:
        """以屏幕点 (sx,sy) 为锚缩放：该点对应的图像位置保持不动。"""
        new_scale = min(max(self.scale * factor, min_scale), max_scale)
        factor = new_scale / self.scale
        self.tx = sx - (sx - self.tx) * factor
        self.ty = sy - (sy - self.ty) * factor
        self.scale = new_scale

    def pan(self, dx: float, dy: float) -> None:
        self.tx += dx
        self.ty += dy

    # 像素坐标 -> 屏幕
    def pixel_to_screen(self, px: float, py: float) -> Point:
        return self.tx + px * self.scale, self.ty + py * self.scale

    # 屏幕 -> 像素
    def screen_to_pixel(self, sx: float, sy: float) -> Point:
        return (sx - self.tx) / self.scale, (sy - self.ty) / self.scale

    # 归一化 -> 屏幕
    def norm_to_screen(self, nx: float, ny: float) -> Point:
        return self.pixel_to_screen(nx * self.img_w, ny * self.img_h)

    # 屏幕 -> 归一化
    def screen_to_norm(self, sx: float, sy: float) -> Point:
        px, py = self.screen_to_pixel(sx, sy)
        return px / self.img_w, py / self.img_h
