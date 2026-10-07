import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'annotator-e2e-'));

let server;
let base;

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function tinyPng(w = 40, h = 30) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) raw[y * (w * 4 + 1)] = 0;
  const idat = deflateSync(raw);
  return 'data:image/png;base64,' + Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

before(async () => {
  const port = 4591 + Math.floor(Math.random() * 200);
  base = `http://127.0.0.1:${port}`;
  await new Promise((resolve, reject) => {
    const srv = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs')], {
      env: { ...process.env, PORT: String(port), ANNOTATOR_DATA: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    srv.stdout.on('data', (d) => d.toString().includes('annotator:') && resolve());
    srv.stderr.on('data', (d) => process.stderr.write(d));
    srv.on('exit', (code) => code && reject(new Error('server exited ' + code)));
    server = srv;
  });
});

after(() => {
  server?.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

async function j(pathname, opts = {}) {
  const res = await fetch(base + pathname, {
    method: opts.method || 'GET',
    headers: {
      'content-type': 'application/json',
      'x-user-name': opts.user || 'tester',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

test('种子数据：存在带底图/多年照片/标注的演示植株', async () => {
  const { json } = await j('/api/plants');
  assert.ok(json.plants.length >= 1);
  const plant = json.plants[0];
  const detail = await j(`/api/plants/${plant.id}`);
  assert.ok(detail.json.photos.length >= 3);
  assert.ok(detail.json.annotations.length >= 3);
  assert.ok(detail.json.photos.some((p) => p.id === detail.json.plant.basePhotoId));
});

test('裁剪图坐标往返：标注规范坐标在新照片上映射后可还原', async () => {
  const { json } = await j('/api/plants');
  const plantId = json.plants[0].id;
  const detail = (await j(`/api/plants/${plantId}`)).json;
  const basePhoto = detail.photos.find((p) => p.id === detail.plant.basePhotoId);
  const ann = detail.annotations[0];

  // 在底图上裁一块固定区域导出 100×100
  const rect = { x: 100, y: 100, w: 200, h: 200 };
  const r = await j(`/api/plants/${plantId}/photos`, {
    method: 'POST',
    body: {
      dataUrl: tinyPng(100, 100),
      width: 100, height: 100, year: 2099,
      sourcePhotoId: basePhoto.id, cropRect: rect,
      note: 'e2e crop',
    },
  });
  assert.equal(r.status, 201);
  const crop = r.json.photo;
  assert.equal(crop.width, 100);

  // 服务端矩阵：p_img = M × p_base；裁剪中点 (200,200) base 应映射到裁剪图中心 (50,50)
  const M = crop.baseToImage;
  const map = ([x, y]) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
  const center = map([200, 200]);
  assert.ok(Math.abs(center[0] - 50) < 1e-6);
  assert.ok(Math.abs(center[1] - 50) < 1e-6);

  // 裁剪图四角逆变换应恰好落在底图裁剪框四角
  const inv = ([x, y]) => {
    const det = M[0] * M[3] - M[2] * M[1];
    return [
      (M[3] * (x - M[4]) - M[2] * (y - M[5])) / det,
      (-M[1] * (x - M[4]) + M[0] * (y - M[5])) / det,
    ];
  };
  const [bx, by] = inv([0, 0]);
  assert.ok(Math.abs(bx - 100) < 1e-6 && Math.abs(by - 100) < 1e-6);
  const [bx2, by2] = inv([100, 100]);
  assert.ok(Math.abs(bx2 - 300) < 1e-6 && Math.abs(by2 - 300) < 1e-6);

  // 文件确实落盘并可下载
  const fileRes = await fetch(`${base}/files/${crop.imageFile}`);
  assert.equal(fileRes.status, 200);
  assert.equal(fileRes.headers.get('content-type'), 'image/png');

  // 原标注仍然只有一份（未因裁剪复制）
  const after = (await j(`/api/plants/${plantId}`)).json;
  assert.ok(after.annotations.some((a) => a.id === ann.id));
});

test('并发编辑：不同字段自动合并；同字段冲突走 resolve', async () => {
  const { json: plants } = await j('/api/plants');
  const plantId = plants.plants[0].id;
  const created = await j(`/api/plants/${plantId}/annotations`, {
    method: 'POST', user: 'alice',
    body: { geometry: { kind: 'point', x: 5, y: 5 }, label: '协作标注', color: '#000000', yearFrom: 2024 },
  });
  const ann = created.json.annotation;
  const v0 = { ...ann.v };

  // Alice 改 label
  const a = await j(`/api/annotations/${ann.id}`, {
    method: 'PATCH', user: 'alice',
    body: { set: { label: 'Alice 改名' }, baseV: { label: v0.label } },
  });
  assert.equal(a.status, 200);

  // Bob 基于 v0 同时改 geometry（没动 label）→ 自动合并，Alice 的 label 保留
  const b = await j(`/api/annotations/${ann.id}`, {
    method: 'PATCH', user: 'bob',
    body: { set: { geometry: { kind: 'point', x: 99, y: 88 } }, baseV: { geometry: v0.geometry } },
  });
  assert.equal(b.status, 200, JSON.stringify(b.json));
  assert.equal(b.json.annotation.fields.label, 'Alice 改名');
  assert.deepEqual(b.json.annotation.fields.geometry, { kind: 'point', x: 99, y: 88 });

  // Bob 再基于旧 v0 改 label → 409
  const conflict = await j(`/api/annotations/${ann.id}`, {
    method: 'PATCH', user: 'bob',
    body: { set: { label: 'Bob 也要改名' }, baseV: { label: v0.label } },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error, 'CONFLICT');
  assert.ok(conflict.json.fields.label);
  assert.equal(conflict.json.fields.label.theirs, 'Bob 也要改名');

  // Bob 裁决：用自己的
  const resolved = await j(`/api/annotations/${ann.id}/resolve`, {
    method: 'POST', user: 'bob',
    body: {
      set: { label: 'Bob 也要改名' },
      choices: { label: 'theirs' },
    },
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.json.annotation.fields.label, 'Bob 也要改名');
  assert.equal(resolved.json.annotation.fields.geometry.x, 99);
});

test('SSE：PATCH 后同植株订阅者收到 updated 事件', async () => {
  const { json: plants } = await j('/api/plants');
  const plantId = plants.plants[0].id;
  const list = (await j(`/api/plants/${plantId}`)).json.annotations;
  const ann = list[0];

  const es = new EventSourcePolyfill(`${base}/api/plants/${plantId}/events`);
  const got = new Promise((resolve) => {
    es.addEventListener('annotation', (e) => {
      const evt = JSON.parse(e.data);
      if (evt.type === 'updated' && evt.annotation.id === ann.id) {
        resolve(evt);
      }
    });
  });

  await new Promise((r) => setTimeout(r, 300)); // 等连接建立
  await j(`/api/annotations/${ann.id}`, {
    method: 'PATCH', user: 'carol',
    body: { set: { label: ann.fields.label + '·' }, baseV: { label: ann.v.label } },
  });
  const evt = await Promise.race([
    got,
    new Promise((_, rej) => setTimeout(() => rej(new Error('SSE 超时未收到事件')), 5000)),
  ]);
  await es.close();
  assert.equal(evt.by, 'carol');
  assert.ok(evt.changed.includes('label'));
});

// 极简 EventSource（node 18+ 无全局 EventSource，手写 SSE 解析够用）
class EventSourcePolyfill {
  constructor(url) {
    this.listeners = {};
    this.closed = false;
    this.connected = (async () => {
      const res = await fetch(url, { headers: { accept: 'text/event-stream' } });
      this.reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        while (!this.closed) {
          const { value, done } = await this.reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let event = 'message';
            const dataLines = [];
            for (const line of chunk.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
            }
            this.listeners[event]?.forEach((fn) => fn({ data: dataLines.join('\n') }));
          }
        }
      } catch {
        // 关闭时 reader 抛 terminated —— 预期行为
      }
    })();
  }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  async close() {
    this.closed = true;
    try { await this.reader?.cancel(); } catch {}
    this.listeners = {};
  }
}

test('路径穿越被挡：/files/../db.json 返回 404 图片缺失而非数据文件', async () => {
  const res = await fetch(base + '/files/..%2fdb.json');
  // basename 处理后找 images/db.json，不存在 → 404
  assert.equal(res.status, 404);
  assert.ok(!existsSync(path.join(dataDir, 'images', 'db.json')));
});
