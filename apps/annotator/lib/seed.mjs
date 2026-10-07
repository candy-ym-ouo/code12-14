// 生成演示用植株 / 照片 / 标注。
// 不依赖任何图片库：自己画 RGB 位图并用 zlib 编码 PNG。

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { identity, normalizeGeometry } from './geometry.mjs';
import { initialVersions } from './merge.mjs';

// ---------- 极简 PNG 编码器（RGBA） ----------

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 6 });
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 画布原语 ----------

function makeCanvas(w, h, bg) {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = bg[0];
    buf[i * 4 + 1] = bg[1];
    buf[i * 4 + 2] = bg[2];
    buf[i * 4 + 3] = 255;
  }
  return { w, h, buf };
}

function px(c, x, y, color) {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 4;
  // 简单 alpha 混合
  const a = color[3] ?? 255;
  if (a === 255) {
    c.buf[i] = color[0];
    c.buf[i + 1] = color[1];
    c.buf[i + 2] = color[2];
  } else {
    const af = a / 255;
    c.buf[i] = c.buf[i] * (1 - af) + color[0] * af;
    c.buf[i + 1] = c.buf[i + 1] * (1 - af) + color[1] * af;
    c.buf[i + 2] = c.buf[i + 2] * (1 - af) + color[2] * af;
  }
}

function dot(c, x, y, r, color) {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r * r) px(c, x + dx, y + dy, color);
    }
  }
}

function line(c, x0, y0, x1, y1, w, color) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    dot(c, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, Math.round(w / 2), color);
  }
}

function disc(c, x, y, r, color) {
  for (let a = 0; a < Math.PI * 2; a += 0.05) {
    line(c, x, y, x + Math.cos(a) * r, y + Math.sin(a) * r, 2, color);
  }
}

// ---------- 场景：一根主枝 + 分叉 + 三个冬芽 ----------

function branchScene(w, h, tint = [0, 0, 0], label) {
  const c = makeCanvas(w, h, [245 + tint[0], 240 + tint[1], 228 + tint[2]]);
  const brown = [111 + tint[0], 78 + tint[1], 52 + tint[2], 255];
  const dark = [74, 50, 32, 255];
  const bud = [140 + tint[0], 60 + tint[1], 70 + tint[2], 255];
  const green = [90 + tint[0], 130 + tint[1], 70 + tint[2], 255];

  // 主枝斜穿画面
  line(c, w * 0.02, h * 0.95, w * 0.98, h * 0.2, 10, brown);
  line(c, w * 0.02, h * 0.95, w * 0.98, h * 0.2, 3, dark);
  // 分叉
  line(c, w * 0.42, h * 0.62, w * 0.75, h * 0.9, 6, brown);
  line(c, w * 0.6, h * 0.48, w * 0.9, h * 0.55, 5, brown);
  // 三个芽（标注的目标）
  const buds = [
    [w * 0.3, h * 0.72],
    [w * 0.62, h * 0.47],
    [w * 0.86, h * 0.3],
  ];
  for (const [x, y] of buds) {
    dot(c, x, y, 11, bud);
    dot(c, x - 3, y - 3, 4, [200, 120, 120, 255]);
  }
  // 年际变化：2026 画绿叶
  if (label === '2026') {
    for (const [x, y] of buds) {
      disc(c, x + 16, y - 14, 10, green);
      disc(c, x + 22, y - 4, 7, green);
    }
  }
  return c;
}

/** 仿射采样：把源画布按 srcToDst 矩阵画到新画布（最近邻，种子数据够用）。 */
function resample(src, dstW, dstH, srcToDst, bg) {
  const dst = makeCanvas(dstW, dstH, bg);
  for (let sy = 0; sy < src.h; sy++) {
    for (let sx = 0; sx < src.w; sx++) {
      const x = srcToDst[0] * sx + srcToDst[2] * sy + srcToDst[4];
      const y = srcToDst[1] * sx + srcToDst[3] * sy + srcToDst[5];
      const i = (sy * src.w + sx) * 4;
      px(dst, x, y, [src.buf[i], src.buf[i + 1], src.buf[i + 2], 255]);
    }
  }
  return dst;
}

export function seedIfEmpty(store, imagesDir) {
  if (store.listPlants().length > 0) return null;

  const W = 1000;
  const H = 700;
  const base = branchScene(W, H, [0, 0, 0]);
  const baseFile = 'seed-base.png';
  writeFileSync(path.join(imagesDir, baseFile), encodePng(W, H, base.buf));

  const plant = store.createPlant({ name: '院角海棠 A-17', species: 'Malus spectabilis' });
  const basePhoto = store.addPhoto({
    plantId: plant.id,
    year: 2024,
    imageFile: baseFile,
    width: W,
    height: H,
    baseToImage: identity(),
    note: '底图（规范坐标 1000×700）',
  });
  store.setBasePhoto(plant.id, basePhoto.id);

  // 2025：拍摄范围只覆盖底图中部，且相机略有缩放（sx≈sy=1.25）。
  // 该图 800×560 像素，覆盖底图矩形 (160,112)→(800,560)。
  const p25File = 'seed-2025.png';
  const scene25 = branchScene(W, H, [8, -6, -10], '2025');
  const sx25 = 1.25;
  // base -> 2025: x25 = (x - 160) * 1.25
  const m25 = [sx25, 0, 0, sx25, -160 * sx25, -112 * sx25];
  const c25 = resample(scene25, 800, 560, m25, [253, 248, 236]);
  writeFileSync(path.join(imagesDir, p25File), encodePng(800, 560, c25.buf));
  const photo25 = store.addPhoto({
    plantId: plant.id,
    year: 2025,
    imageFile: p25File,
    width: 800,
    height: 560,
    baseToImage: m25,
    sourcePhotoId: basePhoto.id,
    note: '2025 春，取景偏中部、放大 1.25×',
  });

  // 2026：在 2025 图上再裁剪一块（400,150,320,320 父像素），导出 320×320。
  const p26File = 'seed-2026.png';
  const scene26 = branchScene(W, H, [-6, 10, -4], '2026');
  const c26FromBase = resample(scene26, 800, 560, m25, [253, 248, 236]);
  // 父(2025)像素 → 导出：x' = (x-400), y'=(y-150)（输出 320）
  const m26 = [1, 0, 0, 1, -400, -150];
  const c26 = resample(c26FromBase, 320, 320, m26, [250, 246, 234]);
  writeFileSync(path.join(imagesDir, p26File), encodePng(320, 320, c26.buf));
  // base→2026 = m26 ∘ m25（与 geometry.cropMatrix 同构）
  const composed = [
    m26[0] * m25[0] + m26[2] * m25[1],
    m26[1] * m25[0] + m26[3] * m25[1],
    m26[0] * m25[2] + m26[2] * m25[3],
    m26[1] * m25[2] + m26[3] * m25[3],
    m26[0] * m25[4] + m26[2] * m25[5] + m26[4],
    m26[1] * m25[4] + m26[3] * m25[5] + m26[5],
  ];
  const photo26 = store.addPhoto({
    plantId: plant.id,
    year: 2026,
    imageFile: p26File,
    width: 320,
    height: 320,
    baseToImage: composed,
    sourcePhotoId: photo25.id,
    note: '2026 春，在 2025 照片上裁剪放大（芽②）',
  });

  // 三条标注（规范坐标）：芽①点、芽②矩形框、芽③多边形
  const mk = (fields, by = 'lin') => {
    const f = {};
    if (fields.geometry) f.geometry = normalizeGeometry(fields.geometry);
    Object.assign(f, {
      label: fields.label ?? '',
      color: fields.color ?? '#d9480f',
      yearFrom: fields.yearFrom ?? 2024,
      yearTo: fields.yearTo ?? null,
      deleted: false,
    });
    return store.addAnnotation({ plantId: plant.id, fields: f, v: initialVersions(f), by });
  };

  mk({
    geometry: { kind: 'point', x: W * 0.3, y: H * 0.72 },
    label: '花芽①',
    color: '#d9480f',
    yearFrom: 2024,
  }, 'lin');
  mk({
    geometry: { kind: 'rect', x: W * 0.62 - 30, y: H * 0.47 - 28, w: 60, h: 56 },
    label: '叶芽②（重点观察）',
    color: '#1971c2',
    yearFrom: 2024,
  }, 'chen');
  mk({
    geometry: {
      kind: 'polygon',
      points: [
        [W * 0.86 - 26, H * 0.3 - 8],
        [W * 0.86 + 24, H * 0.3 - 20],
        [W * 0.86 + 30, H * 0.3 + 14],
        [W * 0.86 - 12, H * 0.3 + 26],
      ],
    },
    label: '顶芽③',
    color: '#2f9e44',
    yearFrom: 2025,
  }, 'lin');

  return { plant, basePhoto, photo25, photo26 };
}
