// 照片标注服务：零第三方依赖的 Node HTTP 服务。
// 启动：node src/server.mjs  （或 npm --workspace annotator start）

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.mjs';
import {
  FIELDS,
  initialVersions,
  mergePatch,
  resolveConflicts,
} from '../lib/merge.mjs';
import { cropMatrix, identity, normalizeGeometry } from '../lib/geometry.mjs';
import { seedIfEmpty } from '../lib/seed.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.ANNOTATOR_DATA
  ? path.resolve(process.env.ANNOTATOR_DATA)
  : path.join(ROOT, 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const PORT = Number(process.env.PORT || 4178);

const store = new Store(DATA_DIR);
seedIfEmpty(store, IMAGES_DIR);

// ---------------- HTTP 工具 ----------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(res, filePath) {
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
    ...(filePath.startsWith(IMAGES_DIR)
      ? { 'cache-control': 'private, max-age=3600' }
      : { 'cache-control': 'no-cache' }),
  });
  res.end(readFileSync(filePath));
}

/** 解析 dataURL 图片落盘。返回 { file, width, height } 由前端保证尺寸已在 meta 中给出。 */
function saveDataUrl(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) throw Object.assign(new Error('bad image data url'), { status: 400 });
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const file = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  writeFileSync(path.join(IMAGES_DIR, file), Buffer.from(m[2], 'base64'));
  return file;
}

// ---------------- SSE：植株维度的标注事件总线 ----------------

const sseClients = new Map(); // plantId -> Set<res>

store.on('annotation', (evt) => {
  const set = sseClients.get(evt.plantId);
  if (!set) return;
  const data = `event: annotation\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const res of set) res.write(data);
});

function sseJoin(req, res, plantId) {
  if (!sseClients.has(plantId)) sseClients.set(plantId, new Set());
  sseClients.get(plantId).add(res);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ plantId, at: new Date().toISOString() })}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.get(plantId)?.delete(res);
  });
}

// ---------------- 路由 ----------------

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  // 植株
  if (p === '/api/plants' && method === 'GET') {
    return sendJson(res, 200, { plants: store.listPlants() });
  }
  if (p === '/api/plants' && method === 'POST') {
    const body = await readBody(req);
    if (!body.name) throw Object.assign(new Error('name required'), { status: 400 });
    const plant = store.createPlant(body);
    return sendJson(res, 201, { plant });
  }

  let m = /^\/api\/plants\/([^/]+)$/.exec(p);
  if (m && method === 'GET') {
    const plant = store.getPlant(m[1]);
    if (!plant) throw Object.assign(new Error('plant not found'), { status: 404 });
    return sendJson(res, 200, {
      plant,
      photos: store.listPhotos(plant.id),
      annotations: store.listAnnotations(plant.id),
    });
  }

  // SSE
  m = /^\/api\/plants\/([^/]+)\/events$/.exec(p);
  if (m && method === 'GET') {
    const plant = store.getPlant(m[1]);
    if (!plant) throw Object.assign(new Error('plant not found'), { status: 404 });
    return sseJoin(req, res, plant.id);
  }

  // 照片
  m = /^\/api\/plants\/([^/]+)\/photos$/.exec(p);
  if (m && method === 'GET') {
    return sendJson(res, 200, { photos: store.listPhotos(m[1]) });
  }
  if (m && method === 'POST') {
    const plant = store.getPlant(m[1]);
    if (!plant) throw Object.assign(new Error('plant not found'), { status: 404 });
    const body = await readBody(req);
    const { year, width, height, baseToImage, sourcePhotoId, note, cropRect } = body;
    if (!year || !body.dataUrl || !width || !height) {
      throw Object.assign(new Error('year/dataUrl/width/height required'), { status: 400 });
    }
    let matrix = baseToImage;
    if (sourcePhotoId && cropRect) {
      // 从父照片裁剪：base→新图 = 裁剪映射 ∘ 父图 base→父像素
      const parent = store.getPhoto(sourcePhotoId);
      if (!parent || parent.plantId !== plant.id) {
        throw Object.assign(new Error('bad source photo'), { status: 400 });
      }
      matrix = cropMatrix(parent.baseToImage, cropRect, width, height);
    } else if (!Array.isArray(matrix) || matrix.length !== 6) {
      // 独立上传的照片默认视为底图视图（规范坐标 = 像素）
      matrix = identity();
    }
    const file = saveDataUrl(body.dataUrl);
    const photo = store.addPhoto({
      plantId: plant.id,
      year,
      imageFile: file,
      width,
      height,
      baseToImage: matrix,
      sourcePhotoId: sourcePhotoId || null,
      note: note || '',
    });
    if (!plant.basePhotoId) store.setBasePhoto(plant.id, photo.id);
    return sendJson(res, 201, { photo });
  }

  m = /^\/api\/photos\/([^/]+)\/base$/.exec(p);
  if (m && method === 'POST') {
    const photo = store.getPhoto(m[1]);
    if (!photo) throw Object.assign(new Error('photo not found'), { status: 404 });
    const plant = store.setBasePhoto(photo.plantId, photo.id);
    return sendJson(res, 200, { plant });
  }

  // 标注
  m = /^\/api\/plants\/([^/]+)\/annotations$/.exec(p);
  if (m && method === 'GET') {
    return sendJson(res, 200, { annotations: store.listAnnotations(m[1]) });
  }
  if (m && method === 'POST') {
    const plant = store.getPlant(m[1]);
    if (!plant) throw Object.assign(new Error('plant not found'), { status: 404 });
    const body = await readBody(req);
    const by = (req.headers['x-user-name'] || body.by || 'anon').toString().slice(0, 40);
    if (!body.geometry || !['point', 'rect', 'polygon'].includes(body.geometry.kind)) {
      throw Object.assign(new Error('geometry required'), { status: 400 });
    }
    const fields = {
      geometry: normalizeGeometry(body.geometry),
      label: String(body.label || ''),
      color: String(body.color || '#d9480f'),
      yearFrom: Number(body.yearFrom) || new Date().getFullYear(),
      yearTo: body.yearTo == null ? null : Number(body.yearTo),
      deleted: false,
    };
    const ann = store.addAnnotation({
      plantId: plant.id,
      fields,
      v: initialVersions(fields),
      by,
    });
    store.broadcast(plant.id, 'created', ann, { by });
    return sendJson(res, 201, { annotation: ann });
  }

  m = /^\/api\/annotations\/([^/]+)$/.exec(p);
  if (m && method === 'GET') {
    const ann = store.getAnnotation(m[1]);
    if (!ann) throw Object.assign(new Error('annotation not found'), { status: 404 });
    return sendJson(res, 200, { annotation: ann });
  }

  // 版本合并：PATCH /api/annotations/:id
  if (m && method === 'PATCH') {
    const ann = store.getAnnotation(m[1]);
    if (!ann) throw Object.assign(new Error('annotation not found'), { status: 404 });
    const body = await readBody(req);
    const by = (req.headers['x-user-name'] || body.by || 'anon').toString().slice(0, 40);

    // 字段合法性 + geometry 规整
    for (const field of Object.keys(body.set || {})) {
      if (!FIELDS.includes(field)) {
        throw Object.assign(new Error(`unknown field: ${field}`), { status: 400 });
      }
    }
    if (body.set?.geometry) body.set.geometry = normalizeGeometry(body.set.geometry);

    const { ann: merged, conflicts } = mergePatch(
      ann,
      { set: body.set, baseV: body.baseV, by },
      (id, field, v) => store.getFieldValue(id, field, v),
    );

    if (Object.keys(conflicts).length) {
      // 409：不写入；客户端选择 ours/theirs 后 POST .../resolve
      return sendJson(res, 409, {
        error: 'CONFLICT',
        fields: conflicts,
        current: { fields: ann.fields, v: ann.v },
      });
    }

    const changed = [];
    for (const f of FIELDS) if (merged.v[f] > ann.v[f]) changed.push(f);
    const saved = changed.length
      ? store.commitAnnotation(merged, changed, by)
      : ann;
    if (changed.length) store.broadcast(saved.plantId, 'updated', saved, { by, changed });
    return sendJson(res, 200, { annotation: saved, changed });
  }

  // 冲突裁决
  m = /^\/api\/annotations\/([^/]+)\/resolve$/.exec(p);
  if (m && method === 'POST') {
    const ann = store.getAnnotation(m[1]);
    if (!ann) throw Object.assign(new Error('annotation not found'), { status: 404 });
    const body = await readBody(req);
    const by = (req.headers['x-user-name'] || body.by || 'anon').toString().slice(0, 40);
    const choices = body.choices || {};
    for (const choice of Object.values(choices)) {
      if (!['ours', 'theirs'].includes(choice)) {
        throw Object.assign(new Error('choice must be ours|theirs'), { status: 400 });
      }
    }
    const { ann: resolved, merged: changed } = resolveConflicts(ann, choices, body, by);
    const saved = changed.length
      ? store.commitAnnotation(resolved, changed, by)
      : ann;
    if (changed.length) store.broadcast(saved.plantId, 'updated', saved, { by, changed, resolved: true });
    return sendJson(res, 200, { annotation: saved, changed });
  }

  throw Object.assign(new Error('not found'), { status: 404 });
}

// ---------------- 服务启动 ----------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    if (url.pathname.startsWith('/lib/')) {
      // 前端与后端共用同一份几何库（同构）
      const name = path.basename(url.pathname);
      return serveStatic(res, path.join(ROOT, 'lib', name));
    }

    if (url.pathname.startsWith('/files/')) {
      const name = path.basename(url.pathname); // 防路径穿越
      return serveStatic(res, path.join(IMAGES_DIR, name));
    }

    // SPA：public 静态文件，未知路径回退 index.html
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
    if (filePath.startsWith(PUBLIC_DIR) && existsSync(filePath)) {
      return serveStatic(res, filePath);
    }
    return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    sendJson(res, status, { error: err.message || 'internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`🌱 annotator: http://localhost:${PORT}`);
  console.log(`   data dir: ${DATA_DIR}`);
});
