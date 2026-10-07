// 仿射变换与坐标还原核心。
//
// 一张"底图"(base)定义了规范坐标系（canonical / base 坐标）。
// 每一张照片（含裁剪、缩放、年度对齐后的版本）都携带一个 2x3 仿射矩阵
// baseToImage：
//
//   图像像素坐标 = baseToImage × 规范坐标
//   规范坐标     = inverse(baseToImage) × 图像像素坐标
//
// 标注几何一律以"规范坐标"持久化，因此：
//   - 2024 / 2025 / 2026 年的照片只要各自带对变换矩阵，标注就是同一份；
//   - 裁剪图的矩阵 = 父图矩阵 ∘ 裁剪平移缩放，嵌套任意层仍可精确还原；
//   - 画布上的平移/缩放只是另一个视图矩阵 view，与存储无关。
//
// 矩阵按列向量约定存为 [a, b, c, d, e, f]：
//   x' = a*x + c*y + e
//   y' = b*x + d*y + f

export const identity = () => [1, 0, 0, 1, 0, 0];

/** m1 复合 m0：先经过 m0，再经过 m1。 */
export function multiply(m1, m0) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a0, b0, c0, d0, e0, f0] = m0;
  return [
    a1 * a0 + c1 * b0,
    b1 * a0 + d1 * b0,
    a1 * c0 + c1 * d0,
    b1 * c0 + d1 * d0,
    a1 * e0 + c1 * f0 + e1,
    b1 * e0 + d1 * f0 + f1,
  ];
}

export function invert(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - c * b;
  if (Math.abs(det) < 1e-12) throw new Error('matrix is singular');
  const id = 1 / det;
  return [
    d * id,
    -b * id,
    -c * id,
    a * id,
    (c * f - d * e) * id,
    (b * e - a * f) * id,
  ];
}

export const translate = (tx, ty) => [1, 0, 0, 1, tx, ty];
export const scale = (s) => [s, 0, 0, s, 0, 0];

/** 把 src 矩形（图像像素）完整映射到 dst 矩形的仿射矩阵。 */
export function mapRect(src, dst) {
  const sx = dst.w / src.w;
  const sy = dst.h / src.h;
  return [sx, 0, 0, sy, dst.x - sx * src.x, dst.y - sy * src.y];
}

export function applyPoint(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** 变换任意标注几何（规范坐标 ↔ 任意目标坐标）。 */
export function transformGeometry(m, g) {
  if (g.kind === 'point') {
    const [x, y] = applyPoint(m, g.x, g.y);
    return { kind: 'point', x, y };
  }
  if (g.kind === 'rect') {
    const corners = [
      applyPoint(m, g.x, g.y),
      applyPoint(m, g.x + g.w, g.y),
      applyPoint(m, g.x + g.w, g.y + g.h),
      applyPoint(m, g.x, g.y + g.h),
    ];
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    return { kind: 'rect', x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
  }
  if (g.kind === 'polygon') {
    return { kind: 'polygon', points: g.points.map(([x, y]) => applyPoint(m, x, y)) };
  }
  throw new Error(`unknown geometry kind: ${g.kind}`);
}

/**
 * 由父照片派生出一张裁剪图时的 baseToImage。
 *
 * @param parentMatrix 父图的 baseToImage
 * @param rect         在父图像素中的裁剪矩形
 * @param outW/outH    裁剪后导出的图像尺寸（可能因压缩而缩放）
 */
export function cropMatrix(parentMatrix, rect, outW, outH) {
  const sx = outW / rect.w;
  const sy = outH / rect.h;
  // 先父图变换到父像素，再减去裁剪原点，再按导出比例缩放。
  return multiply([sx, 0, 0, sy, -sx * rect.x, -sy * rect.y], parentMatrix);
}

export function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

/** 几何数值规整，避免浮点噪声污染版本对比。 */
export function normalizeGeometry(g) {
  const r = (n) => round6(n);
  if (g.kind === 'point') return { kind: 'point', x: r(g.x), y: r(g.y) };
  if (g.kind === 'rect') return { kind: 'rect', x: r(g.x), y: r(g.y), w: r(g.w), h: r(g.h) };
  return { kind: 'polygon', points: g.points.map(([x, y]) => [r(x), r(y)]) };
}

/** 几何命中测试（点 / 矩形 / 多边形），tolerance 单位与坐标一致。 */
export function hitTest(g, x, y, tol = 6) {
  if (g.kind === 'point') return Math.hypot(g.x - x, g.y - y) <= tol + 5;
  if (g.kind === 'rect') {
    return x >= g.x - tol && x <= g.x + g.w + tol && y >= g.y - tol && y <= g.y + g.h + tol;
  }
  // polygon：顶点优先，其次内部（射线法）
  for (const [px, py] of g.points) {
    if (Math.hypot(px - x, py - y) <= tol + 4) return true;
  }
  let inside = false;
  const pts = g.points;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function translateGeometry(g, dx, dy) {
  if (g.kind === 'point') return { ...g, x: g.x + dx, y: g.y + dy };
  if (g.kind === 'rect') return { ...g, x: g.x + dx, y: g.y + dy };
  return { ...g, points: g.points.map(([x, y]) => [x + dx, y + dy]) };
}
