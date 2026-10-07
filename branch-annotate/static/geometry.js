/* 浏览器端几何镜像，与 ../geometry.py 保持同构。
 * 坐标方向：frame 一律是 “父图归一化 -> 本图归一化”。 */

export function identity3() {
  return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
}

export function matmul(a, b) {
  const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) r[i][j] += a[i][k] * b[k][j];
  return r;
}

export function inverse3(h) {
  const [a, b, c] = h[0], [d, e, f] = h[1], [g, i, j] = h[2];
  const det = a * (e * j - f * i) - b * (d * j - f * g) + c * (d * i - e * g);
  const id = 1 / det;
  return [
    [(e * j - f * i) * id, (c * i - b * j) * id, (b * f - c * e) * id],
    [(f * g - d * j) * id, (a * j - c * g) * id, (c * d - a * f) * id],
    [(d * i - e * g) * id, (b * g - a * i) * id, (a * e - b * d) * id],
  ];
}

export class Frame {
  constructor(h) { this.h = h || identity3(); }
  static affine(a, b, c, d, e, f) {
    return new Frame([[a, b, c], [d, e, f], [0, 0, 1]]);
  }
  apply([x, y]) {
    const h = this.h;
    const w = h[2][0] * x + h[2][1] * y + h[2][2];
    return [
      (h[0][0] * x + h[0][1] * y + h[0][2]) / w,
      (h[1][0] * x + h[1][1] * y + h[1][2]) / w,
    ];
  }
  applyPoints(pts) { return pts.map((p) => this.apply(p)); }
  inverse() { return new Frame(inverse3(this.h)); }
  then(other) { return new Frame(matmul(other.h, this.h)); }
}

/** 裁剪框（父图归一化 x,y,w,h）-> frame */
export function cropFrame([x, y, w, h]) {
  return Frame.affine(1 / w, 0, -x / w, 0, 1 / h, -y / h);
}

/** 沿 parent 链复合：base 归一化 -> 指定照片归一化 */
export function chainFrame(photos, photoId) {
  const chain = [];
  let cur = photos[photoId];
  const seen = new Set();
  while (cur) {
    if (seen.has(cur.id)) throw new Error("parent 链有环");
    seen.add(cur.id);
    chain.push(new Frame(cur.frame || identity3()));
    cur = cur.parentId ? photos[cur.parentId] : null;
  }
  let result = new Frame();
  for (let i = chain.length - 1; i >= 0; i--) result = result.then(chain[i]);
  return result;
}

/** 视图：img 像素 -> 屏幕 CSS 像素 */
export class Viewport {
  constructor(imgW, imgH, screenW, screenH, fill = 0.95) {
    this.imgW = imgW; this.imgH = imgH;
    this.screenW = screenW; this.screenH = screenH;
    this.scale = 1; this.tx = 0; this.ty = 0;
    this.fit(fill);
  }
  fit(fill = 0.95) {
    this.scale = Math.min(this.screenW / this.imgW,
      this.screenH / this.imgH) * fill;
    this.tx = (this.screenW - this.imgW * this.scale) / 2;
    this.ty = (this.screenH - this.imgH * this.scale) / 2;
  }
  zoomAt(factor, sx, sy) {
    const next = Math.min(Math.max(this.scale * factor, 0.02), 40);
    factor = next / this.scale;
    this.tx = sx - (sx - this.tx) * factor;
    this.ty = sy - (sy - this.ty) * factor;
    this.scale = next;
  }
  pan(dx, dy) { this.tx += dx; this.ty += dy; }
  pixelToScreen(px, py) { return [this.tx + px * this.scale, this.ty + py * this.scale]; }
  screenToPixel(sx, sy) { return [(sx - this.tx) / this.scale, (sy - this.ty) / this.scale]; }
  normToScreen(nx, ny) { return this.pixelToScreen(nx * this.imgW, ny * this.imgH); }
  screenToNorm(sx, sy) {
    const [px, py] = this.screenToPixel(sx, sy);
    return [px / this.imgW, py / this.imgH];
  }
}
