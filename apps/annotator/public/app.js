// 前端：视图矩阵 + 规范坐标标注 + 版本合并。
//
// 坐标链：
//   屏幕 = screenToCanvas(指针事件) → 画布视图坐标
//   画布视图 = view × image(baseToImage × 规范)
//   即 canvasPoint = view ∘ baseToImage × basePoint
//
// 标注只存 base 坐标，所以切换任何年份/裁剪图，位置自动还原。

import {
  identity, invert, multiply, applyPoint, transformGeometry,
  hitTest, translateGeometry, normalizeGeometry,
} from '/lib/geometry.mjs';

// ---------- 状态 ----------

const state = {
  me: localStorage.getItem('ann.me') || `用户${Math.floor(Math.random() * 1000)}`,
  plant: null,
  photos: [],
  annotations: [],
  currentPhotoId: null,
  img: null,                 // HTMLImageElement
  imgCache: new Map(),
  view: identity(),          // image 像素 → canvas CSS 像素
  tool: 'pan',
  selectedId: null,
  // 每个标注缓存"我上次已知"的字段版本，用于 PATCH baseV
  baseV: {},                 // annId -> {field: v}
  showAllYears: true,
  drag: null,                // 指针交互临时状态
  pendingConflict: null,
};

const $ = (s) => document.querySelector(s);
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');

// ---------- API ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: {
      'content-type': 'application/json',
      'x-user-name': state.me,
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

const toast = (msg, ms = 2200) => {
  let el = $('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
};

const status = (msg, cls = '') => {
  $('#statusBar').innerHTML = cls ? `<span class="${cls}">${msg}</span>` : msg;
};

// ---------- 坐标转换 ----------

const currentPhoto = () => state.photos.find((p) => p.id === state.currentPhotoId) || null;

/** 屏幕事件坐标 → canvas CSS 像素 */
function eventToCanvas(e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}
const canvasToImage = (x, y) => applyPoint(invert(state.view), x, y);
const imageToBase = (photo, x, y) => applyPoint(invert(photo.baseToImage), x, y);
const baseToImage = (photo, x, y) => applyPoint(photo.baseToImage, x, y);
const baseToCanvas = (photo, x, y) => applyPoint(multiply(state.view, photo.baseToImage), x, y);
const canvasToBase = (photo, x, y) => {
  const [ix, iy] = canvasToImage(x, y);
  return imageToBase(photo, ix, iy);
};

function fitView() {
  const photo = currentPhoto();
  if (!photo || !state.img) return;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const s = Math.min(cw / photo.width, ch / photo.height) * 0.92;
  state.view = [s, 0, 0, s, (cw - photo.width * s) / 2, (ch - photo.height * s) / 2];
  draw();
}

// ---------- 数据加载 ----------

async function loadPlants(selectId) {
  const { plants } = await api('/api/plants');
  const sel = $('#plantSelect');
  sel.innerHTML = '';
  if (!plants.length) {
    sel.innerHTML = '<option value="">（无植株）</option>';
    return;
  }
  for (const p of plants) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  }
  sel.value = selectId || state.plant?.id || plants[0].id;
  if (sel.value) await loadPlant(sel.value);
}

async function loadPlant(plantId) {
  const data = await api(`/api/plants/${plantId}`);
  state.plant = data.plant;
  state.photos = data.photos;
  state.annotations = data.annotations;
  state.baseV = {};
  for (const a of state.annotations) state.baseV[a.id] = { ...a.v };

  const preferred = data.plant.basePhotoId || data.photos[0]?.id;
  await selectPhoto(preferred || null);
  renderPhotoList();
  renderAnnList();
  openSse(plantId);
}

function loadImage(photo) {
  if (state.imgCache.has(photo.id)) return state.imgCache.get(photo.id);
  const p = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = `/files/${photo.imageFile}`;
  });
  state.imgCache.set(photo.id, p);
  return p;
}

async function selectPhoto(photoId) {
  state.currentPhotoId = photoId;
  state.selectedId = null;
  $('#editorCard').hidden = true;
  $('#emptyHint').hidden = !!photoId;
  if (!photoId) {
    state.img = null;
    draw();
    return;
  }
  const photo = currentPhoto();
  state.img = await loadImage(photo);
  renderPhotoList();
  fitView();
  status(`正在查看 ${photo.year} 年照片 · ${photo.width}×${photo.height} · 底图坐标系共享`);
}

// ---------- 渲染 ----------

function visibleAnnotations() {
  const photo = currentPhoto();
  if (!photo) return [];
  return state.annotations.filter((a) => {
    if (a.fields.deleted) return false;
    if (state.showAllYears) return true;
    const from = a.fields.yearFrom || 0;
    const to = a.fields.yearTo ?? 9999;
    return photo.year >= from && photo.year <= to;
  });
}

function draw() {
  const photo = currentPhoto();
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  if (!photo || !state.img) return;

  const [a, b, c, d, e, f] = state.view;
  ctx.save();
  ctx.transform(a, b, c, d, e, f);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(state.img, 0, 0, photo.width, photo.height);

  // 图像边框
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1 / Math.max(a, d);
  ctx.strokeRect(0, 0, photo.width, photo.height);
  ctx.restore();

  // 标注：规范坐标 → canvas
  for (const ann of visibleAnnotations()) {
    drawAnnotation(ann, photo);
  }

  // 正在绘制中的临时几何
  if (state.drag?.draft) drawDraft(photo);
}

function annStyle(ann) {
  const sel = ann.id === state.selectedId;
  return {
    color: ann.fields.color || '#d9480f',
    lineWidth: sel ? 2.5 : 1.8,
    sel,
  };
}

function drawAnnotation(ann, photo) {
  const g = transformGeometry(multiply(state.view, photo.baseToImage), ann.fields.geometry);
  const { color, lineWidth, sel } = annStyle(ann);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash([]);

  if (g.kind === 'point') {
    ctx.beginPath();
    ctx.arc(g.x, g.y, sel ? 7 : 5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(g.x, g.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  } else if (g.kind === 'rect') {
    ctx.fillStyle = hexA(color, 0.08);
    ctx.fillRect(g.x, g.y, g.w, g.h);
    ctx.strokeRect(g.x, g.y, g.w, g.h);
  } else if (g.kind === 'polygon') {
    ctx.beginPath();
    g.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = hexA(color, 0.1);
    ctx.fill();
    ctx.stroke();
    for (const [x, y] of g.points) {
      ctx.beginPath();
      ctx.arc(x, y, sel ? 4.5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.stroke();
    }
  }

  // 标签
  const anchor = labelAnchor(g);
  if (anchor) {
    const label = ann.fields.label || '(未命名)';
    ctx.font = '12px sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = hexA(color, 0.9);
    ctx.fillRect(anchor[0], anchor[1] - 16, tw + 10, 17);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, anchor[0] + 5, anchor[1] - 3.5);
  }
  ctx.restore();
}

function labelAnchor(g) {
  if (g.kind === 'point') return [g.x + 8, g.y - 8];
  if (g.kind === 'rect') return [g.x, g.y];
  return g.points[0];
}

function drawDraft(photo) {
  const dr = state.drag;
  ctx.save();
  ctx.strokeStyle = '#1864ab';
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  if (dr.tool === 'rect' || dr.tool === 'crop') {
    const [x0, y0] = dr.startCanvas;
    const [x1, y1] = dr.nowCanvas;
    ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  } else if (dr.tool === 'polygon') {
    ctx.beginPath();
    dr.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.lineTo(dr.nowCanvas[0], dr.nowCanvas[1]);
    ctx.stroke();
    for (const [x, y] of dr.points) {
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (dr.tool === 'point') {
    ctx.beginPath();
    ctx.arc(dr.nowCanvas[0], dr.nowCanvas[1], 5, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---------- 指针交互 ----------

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const [mx, my] = eventToCanvas(e);
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  // 以指针为锚点缩放
  const v = state.view;
  state.view = multiply([factor, 0, 0, factor, mx - factor * mx, my - factor * my], v);
  draw();
}, { passive: false });

canvas.addEventListener('pointerdown', (e) => {
  const photo = currentPhoto();
  if (!photo) return;
  canvas.setPointerCapture(e.pointerId);
  const [cx, cy] = eventToCanvas(e);

  if (state.tool === 'pan') {
    // 优先命中已有标注（屏幕 8px 容差换算到规范坐标）
    const [bx, by] = canvasToBase(photo, cx, cy);
    const compositeScale =
      Math.hypot(state.view[0], state.view[1]) *
      Math.hypot(photo.baseToImage[0], photo.baseToImage[1]);
    const tolBase = 8 / Math.max(compositeScale, 1e-6);
    const hit = [...visibleAnnotations()].reverse().find((a) =>
      hitTest(a.fields.geometry, bx, by, tolBase));
    if (hit) {
      selectAnnotation(hit.id);
      state.drag = { kind: 'move', id: hit.id, startCanvas: [cx, cy], moved: false };
    } else {
      state.drag = { kind: 'pan', startCanvas: [cx, cy], view0: [...state.view] };
      if (state.selectedId) { state.selectedId = null; $('#editorCard').hidden = true; renderAnnList(); draw(); }
    }
    return;
  }

  if (state.tool === 'point') {
    state.drag = { kind: 'create', tool: 'point', nowCanvas: [cx, cy] };
    return;
  }
  if (state.tool === 'rect' || state.tool === 'crop') {
    state.drag = { kind: 'create', tool: state.tool, startCanvas: [cx, cy], nowCanvas: [cx, cy] };
    return;
  }
  if (state.tool === 'polygon') {
    if (!state.drag) state.drag = { kind: 'create', tool: 'polygon', points: [], nowCanvas: [cx, cy] };
    return;
  }
});

canvas.addEventListener('pointermove', (e) => {
  const photo = currentPhoto();
  if (!state.drag || !photo) return;
  const [cx, cy] = eventToCanvas(e);
  const dr = state.drag;

  if (dr.kind === 'pan') {
    state.view = [
      dr.view0[0], dr.view0[1], dr.view0[2], dr.view0[3],
      dr.view0[4] + (cx - dr.startCanvas[0]),
      dr.view0[5] + (cy - dr.startCanvas[1]),
    ];
    draw();
  } else if (dr.kind === 'move') {
    if (Math.abs(cx - dr.startCanvas[0]) + Math.abs(cy - dr.startCanvas[1]) > 2) dr.moved = true;
    const ann = state.annotations.find((a) => a.id === dr.id);
    if (!ann) return;
    // 屏幕位移 → 图像位移 → 底图（规范）位移，严格走两层线性逆矩阵，
    // 因此在裁剪/缩放（含非等比）的年份照片上拖动也能落回正确的规范坐标。
    if (!dr.geom0) dr.geom0 = ann.fields.geometry;
    const v = state.view;
    const m = photo.baseToImage;
    const detV = v[0] * v[3] - v[2] * v[1];
    const dix = (v[3] * (cx - dr.startCanvas[0]) - v[2] * (cy - dr.startCanvas[1])) / detV;
    const diy = (-v[1] * (cx - dr.startCanvas[0]) + v[0] * (cy - dr.startCanvas[1])) / detV;
    const detM = m[0] * m[3] - m[2] * m[1];
    const dbx = (m[3] * dix - m[2] * diy) / detM;
    const dby = (-m[1] * dix + m[0] * diy) / detM;
    ann.fields.geometry = normalizeGeometry(translateGeometry(dr.geom0, dbx, dby));
    draw();
  } else if (dr.kind === 'create') {
    dr.nowCanvas = [cx, cy];
    draw();
  }
});

canvas.addEventListener('pointerup', async (e) => {
  const photo = currentPhoto();
  const dr = state.drag;
  state.drag = null;
  if (!photo || !dr) return;

  if (dr.kind === 'move' && dr.moved) {
    const ann = state.annotations.find((a) => a.id === dr.id);
    await saveField(ann, 'geometry', ann.fields.geometry);
    return;
  }
  if (dr.kind !== 'create') { draw(); return; }

  if (dr.tool === 'point') {
    const [bx, by] = canvasToBase(photo, dr.nowCanvas[0], dr.nowCanvas[1]);
    await createAnnotation(photo, { kind: 'point', x: bx, y: by });
  } else if (dr.tool === 'rect' || dr.tool === 'crop') {
    const rect = canvasRectToImage(dr.startCanvas, dr.nowCanvas);
    if (rect.w < 4 || rect.h < 4) return draw();
    if (dr.tool === 'crop') return openCropDialog(rect);
    const [bx, by] = imageToBase(photo, rect.x, rect.y);
    const [bx2, by2] = imageToBase(photo, rect.x + rect.w, rect.y + rect.h);
    await createAnnotation(photo, normalizeGeometry({
      kind: 'rect', x: bx, y: by, w: bx2 - bx, h: by2 - by,
    }));
  }
  draw();
});

// 多边形：单击加点，双击闭合
canvas.addEventListener('dblclick', async (e) => {
  const photo = currentPhoto();
  if (state.tool !== 'polygon' || !state.drag || !photo) return;
  const dr = state.drag;
  if (dr.points.length < 3) {
    toast('多边形至少需要 3 个点');
    return;
  }
  // dblclick 前的第二次 click 会追加一个与前点几乎重合的顶点，先剔除
  const pts = dr.points;
  if (pts.length >= 2) {
    const [ax, ay] = pts[pts.length - 1];
    const [bx, by] = pts[pts.length - 2];
    if (Math.hypot(ax - bx, ay - by) < 6) pts.pop();
  }
  if (pts.length < 3) {
    toast('多边形至少需要 3 个点');
    return;
  }
  const basePts = dr.points.map(([cx, cy]) => {
    const [ix, iy] = canvasToImage(cx, cy);
    return imageToBase(photo, ix, iy).map((n) => Math.round(n * 1e6) / 1e6);
  });
  state.drag = null;
  await createAnnotation(photo, { kind: 'polygon', points: basePts });
  draw();
});

canvas.addEventListener('click', (e) => {
  if (state.tool !== 'polygon' || !state.drag) return;
  const [cx, cy] = eventToCanvas(e);
  state.drag.points.push([cx, cy]);
  draw();
});

canvas.addEventListener('keydown', () => {});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { state.drag = null; draw(); }
});

function canvasRectToImage(p0, p1) {
  const x0 = Math.min(p0[0], p1[0]), x1 = Math.max(p0[0], p1[0]);
  const y0 = Math.min(p0[1], p1[1]), y1 = Math.max(p0[1], p1[1]);
  const [ix0, iy0] = canvasToImage(x0, y0);
  const [ix1, iy1] = canvasToImage(x1, y1);
  return { x: ix0, y: iy0, w: ix1 - ix0, h: iy1 - iy0 };
}

// ---------- 标注 CRUD + 版本合并 ----------

async function createAnnotation(photo, geometry) {
  try {
    const { annotation } = await api(`/api/plants/${state.plant.id}/annotations`, {
      method: 'POST',
      body: {
        geometry,
        label: '新标注',
        color: '#d9480f',
        yearFrom: photo.year,
        yearTo: null,
      },
    });
    state.annotations.push(annotation);
    state.baseV[annotation.id] = { ...annotation.v };
    selectAnnotation(annotation.id);
    renderAnnList();
    draw();
    status(`已创建标注（${state.me}），存储于底图规范坐标`, 'ok');
  } catch (err) {
    toast('创建失败：' + err.message);
  }
}

function selectAnnotation(id) {
  state.selectedId = id;
  const ann = state.annotations.find((a) => a.id === id);
  renderAnnList();
  draw();
  const card = $('#editorCard');
  if (!ann) { card.hidden = true; return; }
  card.hidden = false;
  $('#fLabel').value = ann.fields.label || '';
  $('#fColor').value = /^#[0-9a-f]{6}$/i.test(ann.fields.color) ? ann.fields.color : '#d9480f';
  $('#fYearFrom').value = ann.fields.yearFrom ?? '';
  $('#fYearTo').value = ann.fields.yearTo ?? '';
  $('#annVersion').textContent = '字段版本 ' + JSON.stringify(ann.v);
}

$('#saveMetaBtn').addEventListener('click', async () => {
  const ann = state.annotations.find((a) => a.id === state.selectedId);
  if (!ann) return;
  // 收集发生变化的字段，逐字段保存（互不阻塞）
  const jobs = [];
  const label = $('#fLabel').value;
  if (label !== (ann.fields.label || '')) jobs.push(['label', label]);
  const color = $('#fColor').value;
  if (color !== ann.fields.color) jobs.push(['color', color]);
  const yearFrom = Number($('#fYearFrom').value);
  if (yearFrom && yearFrom !== ann.fields.yearFrom) jobs.push(['yearFrom', yearFrom]);
  const ytRaw = $('#fYearTo').value;
  const yearTo = ytRaw === '' ? null : Number(ytRaw);
  if (yearTo !== (ann.fields.yearTo ?? null)) jobs.push(['yearTo', yearTo]);
  if (!jobs.length) return toast('没有改动');
  for (const [field, value] of jobs) {
    // 串行：后一个字段要看到更新后的 v
    const cur = state.annotations.find((a) => a.id === ann.id);
    await saveField(cur, field, value);
  }
});

$('#deleteBtn').addEventListener('click', async () => {
  const ann = state.annotations.find((a) => a.id === state.selectedId);
  if (!ann || !confirm('删除该标注？（删除操作同样参与版本合并）')) return;
  await saveField(ann, 'deleted', true);
  $('#editorCard').hidden = true;
  state.selectedId = null;
});

/**
 * 提交单个字段修改。
 * 成功：用服务端返回更新本地，并把该字段 baseV 对齐。
 * 409：弹出逐字段裁决对话框；无冲突字段已经在服务端合并。
 */
async function saveField(ann, field, value) {
  const baseV = state.baseV[ann.id] ? { [field]: state.baseV[ann.id][field] } : {};
  try {
    const { annotation: saved, changed } = await api(`/api/annotations/${ann.id}`, {
      method: 'PATCH',
      body: { set: { [field]: value }, baseV },
    });
    mergeIntoLocal(saved);
    state.baseV[ann.id] = { ...saved.v };
    status(`字段 ${field} 已保存（v${saved.v[field]}）${changed?.length ? '，服务端自动合并了并行改动' : ''}`, 'ok');
    return true;
  } catch (err) {
    if (err.status === 409 && err.data?.error === 'CONFLICT') {
      await handleConflict(ann, { [field]: value }, baseV, err.data);
      return true;
    }
    toast('保存失败：' + err.message);
    return false;
  }
}

function mergeIntoLocal(saved) {
  const idx = state.annotations.findIndex((a) => a.id === saved.id);
  if (idx < 0) {
    state.annotations.push(saved);
  } else {
    state.annotations[idx] = saved;
  }
  if (!state.baseV[saved.id]) state.baseV[saved.id] = { ...saved.v };
  renderAnnList();
  if (state.selectedId === saved.id) selectAnnotation(saved.id);
  draw();
}

async function handleConflict(ann, set, baseV, conflictData) {
  return new Promise((resolve) => {
    state.pendingConflict = { ann, set, baseV, conflictData, resolve };
    const box = $('#cfFields');
    box.innerHTML = '';
    const names = {
      geometry: '位置/形状', label: '名称', color: '颜色',
      yearFrom: '起始年', yearTo: '结束年', deleted: '删除状态',
    };
    for (const [field, c] of Object.entries(conflictData.fields)) {
      const div = document.createElement('div');
      div.className = 'cf-field';
      div.innerHTML = `
        <div class="fname">${names[field] || field}</div>
        <label class="cf-choice">
          <input type="radio" name="cf-${field}" value="theirs" checked />
          <span><span class="who">我的值</span><pre>${fmtVal(set[field])}</pre></span>
        </label>
        <label class="cf-choice">
          <input type="radio" name="cf-${field}" value="ours" />
          <span><span class="who">对方当前值（v${c.oursV}）</span><pre>${fmtVal(c.ours)}</pre></span>
        </label>`;
      box.appendChild(div);
    }
    $('#cfBy').textContent = '他人';
    $('#conflictDialog').showModal();
  });
}

function fmtVal(v) {
  if (v && typeof v === 'object') return JSON.stringify(v, null, 1);
  return String(v);
}

function conflictChoices() {
  const choices = {};
  const box = $('#cfFields');
  for (const radio of box.querySelectorAll('input[type=radio]')) {
    const field = radio.name.replace('cf-', '');
    if (radio.checked) choices[field] = radio.value;
  }
  return choices;
}

async function submitConflict(forceChoice) {
  const pc = state.pendingConflict;
  if (!pc) return;
  const dlg = $('#conflictDialog');
  dlg.close();
  const choices = forceChoice
    ? Object.fromEntries(Object.keys(pc.conflictData.fields).map((f) => [f, forceChoice]))
    : conflictChoices();

  // 冲突字段在本地可能已不是服务端版本：先对齐 current，再裁决
  mergeIntoLocal({ ...pc.conflictData.current, id: pc.ann.id, plantId: pc.ann.plantId });
  try {
    const { annotation: saved } = await api(`/api/annotations/${pc.ann.id}/resolve`, {
      method: 'POST',
      body: { set: pc.set, choices },
    });
    mergeIntoLocal(saved);
    state.baseV[saved.id] = { ...saved.v };
    toast('冲突已裁决并保存');
    status(`冲突按字段裁决完成：${Object.entries(choices).map(([f, c]) => `${f}→${c === 'theirs' ? '我' : '对方'}`).join('，')}`, 'warn');
  } catch (err) {
    toast('裁决提交失败：' + err.message);
  } finally {
    state.pendingConflict = null;
    pc.resolve();
  }
}
$('#cfSubmitBtn').addEventListener('click', () => submitConflict());
$('#cfMineBtn').addEventListener('click', () => submitConflict('theirs'));
$('#cfTheirsBtn').addEventListener('click', () => submitConflict('ours'));

// ---------- 照片 / 裁剪 ----------

function renderPhotoList() {
  const list = $('#photoList');
  list.innerHTML = '';
  for (const p of state.photos) {
    const item = document.createElement('div');
    item.className = 'photo-item' + (p.id === state.currentPhotoId ? ' active' : '');
    const isBase = state.plant.basePhotoId === p.id;
    item.innerHTML = `
      <img src="/files/${p.imageFile}" alt="" />
      <div class="meta">
        <div class="yr">${p.year} ${isBase ? '<span class="badge">底图</span>' : ''}</div>
        <div class="note">${p.note || (p.sourcePhotoId ? '裁剪图' : '独立照片')} · ${Math.round(p.width)}×${Math.round(p.height)}</div>
      </div>`;
    item.addEventListener('click', () => selectPhoto(p.id));
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      api(`/api/photos/${p.id}/base`, { method: 'POST' }).then(({ plant }) => {
        state.plant = plant;
        renderPhotoList();
        toast(`已把 ${p.year} 年照片设为底图（标注坐标语义随之切换，请确保它是规范视图）`);
      });
    });
    list.appendChild(item);
  }
}

$('#uploadInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !state.plant) return;
  const { dataUrl, width, height } = await fileToDataUrl(file, 1600, 0.85);
  const year = Number(prompt('这张照片拍摄于哪一年？', String(new Date().getFullYear())));
  if (!year) return;
  const note = prompt('备注（可空）', file.name) || '';
  const { photo } = await api(`/api/plants/${state.plant.id}/photos`, {
    method: 'POST',
    body: { dataUrl, width, height, year, note },
  });
  state.photos.push(photo);
  state.photos.sort((a, b) => a.year - b.year);
  renderPhotoList();
  await selectPhoto(photo.id);
  toast('照片已上传；坐标系默认等于像素，可作为新年份视图');
});

function fileToDataUrl(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * s);
      const h = Math.round(img.height * s);
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve({ dataUrl: cv.toDataURL('image/jpeg', quality), width: w, height: h });
      URL.revokeObjectURL(url);
    };
    img.onerror = reject;
    img.src = url;
  });
}

let pendingCrop = null;
function openCropDialog(rectImage) {
  pendingCrop = rectImage;
  $('#cropYear').value = String(currentPhoto().year + 1);
  $('#cropNote').value = '';
  $('#cropDialog').showModal();
}

$('#cropDialog').addEventListener('close', async (e) => {
  if ($('#cropDialog').returnValue !== 'confirm' || !pendingCrop) return;
  const rect = pendingCrop;
  pendingCrop = null;
  const photo = currentPhoto();

  // 从当前 <img> 按图像像素裁一块，导出 640 宽
  const outW = 640;
  const outH = Math.round((rect.h / rect.w) * outW);
  const cv = document.createElement('canvas');
  cv.width = outW; cv.height = outH;
  cv.getContext('2d').drawImage(
    state.img,
    rect.x, rect.y, rect.w, rect.h,
    0, 0, outW, outH,
  );
  const dataUrl = cv.toDataURL('image/jpeg', 0.85);
  const year = Number($('#cropYear').value);
  const note = $('#cropNote').value;
  try {
    const { photo: cropped } = await api(`/api/plants/${state.plant.id}/photos`, {
      method: 'POST',
      body: {
        dataUrl, width: outW, height: outH, year, note,
        sourcePhotoId: photo.id,
        cropRect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
      },
    });
    state.photos.push(cropped);
    state.photos.sort((a, b) => a.year - b.year);
    renderPhotoList();
    await selectPhoto(cropped.id);
    toast('裁剪图已生成；矩阵级联完成，所有标注自动还原到新视图');
  } catch (err) {
    toast('裁剪失败：' + err.message);
  }
});

// ---------- 侧栏标注列表 ----------

function renderAnnList() {
  const box = $('#annList');
  box.innerHTML = '';
  const alive = state.annotations.filter((a) => !a.fields.deleted);
  if (!alive.length) {
    box.innerHTML = '<p class="hint">暂无标注</p>';
    return;
  }
  for (const ann of [...alive].sort((a, b) => (a.fields.label || '').localeCompare(b.fields.label || ''))) {
    const div = document.createElement('div');
    div.className = 'ann-item' + (ann.id === state.selectedId ? ' active' : '');
    const range = `${ann.fields.yearFrom || '?'}–${ann.fields.yearTo ?? '今'}`;
    div.innerHTML = `
      <span class="swatch" style="background:${ann.fields.color}"></span>
      <span>${ann.fields.label || '(未命名)'}</span>
      <span class="yr-range">${range}</span>`;
    div.addEventListener('click', () => {
      // 点击列表时切到该标注当前最佳可见的照片（最近年份优先）
      selectAnnotation(ann.id);
    });
    box.appendChild(div);
  }
}

// ---------- SSE：他人改动实时合并 ----------

let evtSource = null;
function openSse(plantId) {
  if (evtSource) { evtSource.close(); evtSource = null; }
  evtSource = new EventSource(`/api/plants/${plantId}/events`);
  evtSource.addEventListener('annotation', (e) => {
    const evt = JSON.parse(e.data);
    if (evt.by === state.me) return; // 自己的改动走 HTTP 响应，避免回声
    const existing = state.annotations.find((a) => a.id === evt.annotation.id);
    mergeIntoLocal(evt.annotation);
    // 他人删除：关闭属性卡
    if (evt.annotation.fields.deleted && evt.annotation.id === state.selectedId) {
      state.selectedId = null;
      $('#editorCard').hidden = true;
    }
    // 他人提交的字段版本，对我来说也是新的已知版本 → 对齐 baseV
    for (const [f, v] of Object.entries(evt.annotation.v)) {
      state.baseV[evt.annotation.id] = state.baseV[evt.annotation.id] || {};
      state.baseV[evt.annotation.id][f] = Math.max(state.baseV[evt.annotation.id][f] || 0, v);
    }
    if (!existing || evt.type === 'created') toast(`收到 ${evt.by} 的新标注`);
    else status(`收到 ${evt.by} 对标注的修改：${(evt.changed || []).join(', ')}`, 'warn');
  });
}

// ---------- 顶部控件 ----------

$('#plantSelect').addEventListener('change', (e) => loadPlant(e.target.value));
$('#newPlantBtn').addEventListener('click', () => {
  $('#npName').value = '';
  $('#npSpecies').value = '';
  $('#plantDialog').showModal();
});
$('#plantDialog').addEventListener('close', async () => {
  if ($('#plantDialog').returnValue !== 'confirm') return;
  const name = $('#npName').value.trim();
  if (!name) return;
  const { plant } = await api('/api/plants', {
    method: 'POST',
    body: { name, species: $('#npSpecies').value.trim() },
  });
  await loadPlants(plant.id);
});

$('#meInput').value = state.me;
$('#meInput').addEventListener('change', (e) => {
  state.me = e.target.value.trim() || 'anon';
  localStorage.setItem('ann.me', state.me);
});

document.querySelectorAll('#tools .btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#tools .btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.tool = btn.dataset.tool;
    canvas.style.cursor = state.tool === 'pan' ? 'default' : 'crosshair';
    state.drag = null;
    draw();
  });
});

$('#zoomFitBtn').addEventListener('click', fitView);
$('#zoom100Btn').addEventListener('click', () => {
  const photo = currentPhoto();
  if (!photo) return;
  const s = Math.min(canvas.clientWidth / photo.width, 1);
  state.view = [s, 0, 0, s, 0, 0];
  draw();
});
$('#showAllYears').addEventListener('change', (e) => {
  state.showAllYears = e.target.checked;
  draw();
});

let resizeT;
new ResizeObserver(() => { clearTimeout(resizeT); resizeT = setTimeout(draw, 50); }).observe(canvas);

// ---------- 启动 ----------

loadPlants().catch((err) => status('加载失败：' + err.message, 'warn'));
