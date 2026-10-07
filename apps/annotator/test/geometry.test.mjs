import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  identity, invert, multiply, applyPoint, transformGeometry, cropMatrix, normalizeGeometry,
} from '../lib/geometry.mjs';

test('identity / invert 往返', () => {
  const p = [312.75, -88.2];
  const m = identity();
  const inv = invert(m);
  assert.deepEqual(applyPoint(inv, ...p), p);

  const m2 = [2, 0.3, -0.1, 1.5, 40, -12];
  const back = applyPoint(invert(m2), ...applyPoint(m2, ...p));
  assert.ok(Math.abs(back[0] - p[0]) < 1e-9);
  assert.ok(Math.abs(back[1] - p[1]) < 1e-9);
});

test('multiply 与显式矩阵一致（先 A 后 B）', () => {
  const A = [1.25, 0, 0, 1.25, -200, -140];
  const B = [1, 0, 0, 1, -400, -150];
  const M = multiply(B, A);
  const [x, y] = applyPoint(M, 500, 400);
  // 列向量约定 x'=a*x+e：先 A 得 1.25*500-200=425，再 B 得 425-400=25
  assert.equal(Math.round(x * 100) / 100, 25);
  assert.equal(Math.round(y * 100) / 100, 1.25 * 400 - 140 - 150);
});

test('裁剪矩阵：任意嵌套层级都能还原到底图坐标', () => {
  // base(1000×700) → 2025 照片（800×560，缩放 1.25，平移）
  const m25 = [1.25, 0, 0, 1.25, -200, -140];
  // 2025 图上裁剪 (400,150,320,320) → 导出 640×640（放大 2 倍）
  const m26 = cropMatrix(m25, { x: 400, y: 150, w: 320, h: 320 }, 640, 640);

  // 底图点 (600,400) → 2025：1.25*600-200=550, 1.25*400-140=360
  // → 裁剪导出：2*(550-400)=300, 2*(360-150)=420
  const [cx, cy] = applyPoint(m26, 600, 400);
  assert.ok(Math.abs(cx - 300) < 1e-9);
  assert.ok(Math.abs(cy - 420) < 1e-9);
  // 导出图中心 (320,320) 逆映射对应的底图点
  const center = applyPoint(invert(m26), 320, 320);
  assert.ok(Math.abs(center[0] - 608) < 1e-9);
  assert.ok(Math.abs(center[1] - 360) < 1e-9);

  // 再从 2026 导出图裁一刀：(100,100,200,200) → 300×300
  const m27 = cropMatrix(m26, { x: 100, y: 100, w: 200, h: 200 }, 300, 300);
  // 来回：底图点 → 2027 → 逆回底图
  const base = [612.5, 397.125];
  const there = applyPoint(m27, ...base);
  const back = applyPoint(invert(m27), ...there);
  assert.ok(Math.abs(back[0] - base[0]) < 1e-8);
  assert.ok(Math.abs(back[1] - base[1]) < 1e-8);
});

test('保角相似变换（各向同性缩放+平移）下矩形角点可还原', () => {
  // 裁剪/缩放只有平移与等比缩放时，矩形仍为矩形，角点精确可逆
  const m = [1.4, 0, 0, 1.4, 30, -10];
  const g = normalizeGeometry(
    transformGeometry(m, { kind: 'rect', x: 10, y: 20, w: 100, h: 60 }),
  );
  assert.ok(g.w > 0 && g.h > 0);
  const corners = [
    [g.x, g.y], [g.x + g.w, g.y], [g.x + g.w, g.y + g.h], [g.x, g.y + g.h],
  ];
  const back = corners.map((c) => applyPoint(invert(m), ...c));
  const origin = [
    [10, 20], [110, 20], [110, 80], [10, 80],
  ];
  for (const p of back) {
    assert.ok(origin.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-4));
  }
});

test('polygon 几何往返', () => {
  const m = [1.1, -0.05, 0.07, 0.95, 12, 8];
  const poly = { kind: 'polygon', points: [[10, 10], [200, 30], [150, 180], [40, 220]] };
  const g2 = transformGeometry(m, poly);
  const back = transformGeometry(invert(m), g2);
  for (let i = 0; i < poly.points.length; i++) {
    assert.ok(Math.abs(back.points[i][0] - poly.points[i][0]) < 1e-8);
    assert.ok(Math.abs(back.points[i][1] - poly.points[i][1]) < 1e-8);
  }
});
