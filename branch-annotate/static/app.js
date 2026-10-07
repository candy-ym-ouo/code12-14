/* 跨年份枝条照片标注 —— 前端主逻辑（无构建、无框架）。 */
import { Frame, Viewport, chainFrame, cropFrame, identity3 } from "./geometry.js";

// --------------------------------------------------------------------------- //
// 全局状态
// --------------------------------------------------------------------------- //
const $ = (s) => document.querySelector(s);
const state = {
  branchId: localStorage.getItem("ba_branch") || null,
  branch: null,
  photos: {},          // id -> photo
  photoOrder: [],
  annots: {},          // id -> annotation（服务端最新）
  vvs: {},             // id -> 版本向量
  synced: {},          // id -> 我最近一次同步的文档（commit 的 base 来源）
  syncedVV: {},
  version: 0,
  currentPhotoId: null,
  images: {},          // id -> HTMLImageElement
  viewport: null,
  tool: "select",
  selected: null,
  draft: null,         // rect/polygon 绘制中
  conflicts: [],       // {key, aid, path, winner, loser, ...}
  counters: {},        // clientId -> 本地 revision
  spaceDown: false,
  cropMode: false,
};
const COLORS = ["#ff5d5d", "#f5a623", "#2f7d4f", "#3a7bd5", "#9b59b6", "#16a085"];
const USERS = ["alice", "bob", "carol"];
let me = localStorage.getItem("ba_me") || "alice";

// --------------------------------------------------------------------------- //
// API
// --------------------------------------------------------------------------- //
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok && !(res.status === 409)) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return { status: res.status, data };
}

function nextRev(clientId) {
  state.counters[clientId] = (state.counters[clientId] || 0) + 1;
  return state.counters[clientId];
}

function noteCountersFromVV(vvs) {
  for (const vv of Object.values(vvs))
    for (const [cid, n] of Object.entries(vv))
      state.counters[cid] = Math.max(state.counters[cid] || 0, n);
}

// --------------------------------------------------------------------------- //
// 标注提交（base / proposed + baseVV -> 服务端三向合并）
// --------------------------------------------------------------------------- //
async function commitAid(aid, proposed) {
  const base = state.synced[aid] ? structuredClone(state.synced[aid]) : null;
  const baseVV = state.syncedVV[aid] ? { ...state.syncedVV[aid] } : null;
  const { status, data } = await api(
    `/api/branches/${state.branchId}/annotations/${encodeURIComponent(aid)}/commit`,
    {
      method: "PUT",
      body: { clientId: me, revision: nextRev(me), base, proposed, baseVV },
    }
  );
  applyServerAnnotation(aid, data.annotation, data.vv);
  if (data.conflicts?.length) registerConflicts(aid, data.conflicts);
  if (status === 409) {
    toast(`⚠ 与他人并发修改了同一字段：先提交者保留，你的版本进入冲突面板`);
  }
  return data;
}

async function commitAs(clientId, aid, proposed, baseIn, baseVVIn) {
  // 并发演示：以任意身份提交；base/baseVV 必须由调用方在演示开始前
  // 一次性快照，保证两个并发者基于同一旧版本（否则就不是“并发”了）
  const base = baseIn !== undefined
    ? (baseIn ? structuredClone(baseIn) : null)
    : (state.synced[aid] ? structuredClone(state.synced[aid]) : null);
  const baseVV = baseVVIn !== undefined
    ? (baseVVIn ? { ...baseVVIn } : null)
    : (state.syncedVV[aid] ? { ...state.syncedVV[aid] } : null);
  const res = await fetch(
    `/api/branches/${state.branchId}/annotations/${encodeURIComponent(aid)}/commit`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId, revision: nextRev(clientId), base, proposed, baseVV,
      }),
    }
  );
  const data = await res.json();
  applyServerAnnotation(aid, data.annotation, data.vv);
  if (data.conflicts?.length) registerConflicts(aid, data.conflicts);
  return { status: res.status, data };
}

function applyServerAnnotation(aid, doc, vv) {
  state.annots[aid] = doc;
  state.vvs[aid] = vv;
  state.synced[aid] = structuredClone(doc);
  state.syncedVV[aid] = { ...vv };
}

function registerConflicts(aid, conflicts) {
  for (const c of conflicts) {
    const key = `${aid}|${c.path}`;
    state.conflicts = state.conflicts.filter((x) => x.key !== key);
    state.conflicts.push({ key, aid, ...c });
  }
  renderConflicts();
}

// --------------------------------------------------------------------------- //
// 快照 / 长轮询
// --------------------------------------------------------------------------- //
async function refresh() {
  if (!state.branchId) return;
  const { data } = await api(`/api/branches/${state.branchId}`);
  state.branch = data.branch;
  state.version = data.version;
  const prevPhotos = state.photos;
  state.photos = {};
  state.photoOrder = [];
  for (const p of data.photos) {
    state.photos[p.id] = p;
    state.photoOrder.push(p.id);
    if (p.src && !state.images[p.id]) loadImage(p.id, p.src);
    if (p.src && prevPhotos[p.id]?.src !== p.src) loadImage(p.id, p.src);
  }
  state.annots = {};
  state.vvs = {};
  for (const a of data.annotations) {
    state.annots[a.id] = a;
    state.vvs[a.id] = data.vvs[a.id];
    // 本地没有正在进行的编辑时，把服务端值作为新的 base
    state.synced[a.id] = structuredClone(a);
    state.syncedVV[a.id] = { ...(data.vvs[a.id] || {}) };
  }
  noteCountersFromVV(data.vvs);
  if (!state.currentPhotoId && state.photoOrder.length)
    state.currentPhotoId = basePhoto()?.id || state.photoOrder[0];
  $("#version-badge").textContent = `v${state.version}`;
  $("#branch-name").textContent = state.branch ? `· ${state.branch.name}` : "";
  renderPhotoUI();
  renderAnnoList();
  renderProps();
  redraw();
}

async function eventLoop() {
  while (true) {
    try {
      if (state.branchId) {
        const { data } = await api(
          `/api/branches/${state.branchId}/events?after=${state.version}`
        );
        if (data.version > state.version) await refresh();
      }
    } catch (e) {
      /* 网络抖动：稍后重试 */
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}

function loadImage(id, src) {
  const img = new Image();
  img.onload = () => { if (state.currentPhotoId === id) setupViewport(); redraw(); };
  img.src = src;
  state.images[id] = img;
}

function waitImage(id, timeoutMs = 8000) {
  const img = state.images[id];
  if (img && img.complete && img.naturalWidth) return Promise.resolve();
  return new Promise((resolve) => {
    if (!img) return resolve();
    const t = setTimeout(resolve, timeoutMs);
    img.addEventListener("load", () => { clearTimeout(t); resolve(); }, { once: true });
    img.addEventListener("error", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// --------------------------------------------------------------------------- //
// 照片结构
// --------------------------------------------------------------------------- //
function basePhoto() {
  return Object.values(state.photos).find((p) => !p.parentId) || null;
}
function currentPhoto() { return state.photos[state.currentPhotoId]; }
function chainFor(photoId) { return chainFrame(state.photos, photoId); }

// --------------------------------------------------------------------------- //
// 画布
// --------------------------------------------------------------------------- //
const canvas = $("#canvas");
const ctx = canvas.getContext("2d");

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", () => { resizeCanvas(); setupViewport(); redraw(); });

function setupViewport() {
  const p = currentPhoto();
  const img = state.images[state.currentPhotoId];
  if (!p) return;
  const r = canvas.getBoundingClientRect();
  const w = img && img.complete ? p.width : p.width;
  state.viewport = new Viewport(w, p.height, r.width, r.height);
}

function screenToBase(sx, sy) {
  const vp = state.viewport;
  const n = vp.screenToNorm(sx, sy);
  return chainFor(state.currentPhotoId).inverse().apply(n);
}
function baseToScreen(pt) {
  const vp = state.viewport;
  const n = chainFor(state.currentPhotoId).apply(pt);
  return vp.normToScreen(n[0], n[1]);
}
function baseToleranceScreen(px = 8) {
  const [bx0, by0] = screenToBase(100, 100);
  const [bx1, by1] = screenToBase(100 + px, 100);
  return Math.hypot(bx1 - bx0, by1 - by0);
}

function redraw() {
  resizeCanvas();
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  const p = currentPhoto();
  if (!p) {
    ctx.fillStyle = "#9fb0a4";
    ctx.font = "15px sans-serif";
    ctx.fillText("点击左上「载入演示数据」开始（同株三年照片 + 底图标注）", 24, 40);
    return;
  }
  const vp = state.viewport; if (!vp) return;
  const img = state.images[p.id];

  // 照片铺满自身 [0,1]^2
  const [x0, y0] = vp.pixelToScreen(0, 0);
  ctx.save();
  ctx.imageSmoothingQuality = "high";
  if (img && img.complete && img.naturalWidth)
    ctx.drawImage(img, x0, y0, p.width * vp.scale, p.height * vp.scale);
  else {
    ctx.fillStyle = "#6b7a70";
    ctx.fillRect(x0, y0, p.width * vp.scale, p.height * vp.scale);
  }
  ctx.restore();

  // 标注（底图坐标 -> 当前照片 -> 屏幕）
  for (const a of Object.values(state.annots)) {
    if (a.deleted) continue;
    drawAnnotation(a, a.id === state.selected);
  }
  if (state.draft) drawDraft();
  if (state.cropMode && state.draft?.kind === "crop")
    drawDraft();
}

function drawAnnotation(a, selected) {
  const c = a.color || "#ff5d5d";
  ctx.save();
  ctx.lineWidth = selected ? 3 : 2;
  ctx.strokeStyle = c;
  ctx.fillStyle = c + "33";
  ctx.font = "12px sans-serif";
  const g = a.geometry;
  if (a.kind === "point") {
    const [sx, sy] = baseToScreen([g.x, g.y]);
    ctx.beginPath(); ctx.arc(sx, sy, selected ? 7 : 5, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    label(a.label, sx + 9, sy - 8, c);
  } else if (a.kind === "rect") {
    const q = [baseToScreen([g.x, g.y]), baseToScreen([g.x + g.w, g.y + g.h])];
    ctx.strokeRect(q[0][0], q[0][1], q[1][0] - q[0][0], q[1][1] - q[0][1]);
    if (selected) handle(q[1][0], q[1][1], c);
    label(a.label, q[0][0] + 4, q[0][1] - 6, c);
  } else if (a.kind === "polygon") {
    const pts = g.points.map((p) => baseToScreen(p));
    ctx.beginPath();
    pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.closePath(); ctx.fill(); ctx.stroke();
    if (selected) pts.forEach(([x, y]) => handle(x, y, c));
    const [lx, ly] = pts[0] || [0, 0];
    label(a.label, lx + 4, ly - 8, c);
  }
  ctx.restore();
}
function handle(x, y, c) {
  ctx.save(); ctx.fillStyle = "#fff"; ctx.strokeStyle = c; ctx.lineWidth = 2;
  ctx.fillRect(x - 4, y - 4, 8, 8); ctx.strokeRect(x - 4, y - 4, 8, 8); ctx.restore();
}
function label(text, x, y, c) {
  if (!text) return;
  ctx.save();
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = c; ctx.fillRect(x - 2, y - 13, w, 16);
  ctx.fillStyle = "#fff"; ctx.fillText(text, x + 2, y - 1);
  ctx.restore();
}
function drawDraft() {
  const d = state.draft;
  ctx.save();
  ctx.strokeStyle = "#ffd54a"; ctx.fillStyle = "rgba(255,213,74,.15)";
  ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
  if (d.kind === "rect") {
    const [x, y] = d.start; const [x2, y2] = d.cur;
    ctx.strokeRect(Math.min(x, x2), Math.min(y, y2), Math.abs(x2 - x), Math.abs(y2 - y));
  } else if (d.kind === "crop") {
    const [x, y] = d.start; const [x2, y2] = d.cur;
    ctx.strokeRect(Math.min(x, x2), Math.min(y, y2), Math.abs(x2 - x), Math.abs(y2 - y));
  } else if (d.kind === "polygon") {
    ctx.setLineDash([]);
    ctx.beginPath();
    d.pts.forEach((p, i) => { const [x, y] = baseToScreen(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    if (d.cur) { const [x, y] = d.cur; ctx.lineTo(x, y); }
    ctx.stroke();
    d.pts.forEach((p) => { const [x, y] = baseToScreen(p); handle(x, y, "#ffd54a"); });
  }
  ctx.restore();
}

// --------------------------------------------------------------------------- //
// 命中测试（在底图归一化坐标中）
// --------------------------------------------------------------------------- //
function hitTest(basePt) {
  const tol = baseToleranceScreen(9);
  const list = Object.values(state.annots).filter((a) => !a.deleted);
  // 点 / 顶点优先
  for (const a of list) {
    const g = a.geometry;
    if (a.kind === "point" && Math.abs(g.x - basePt[0]) < tol && Math.abs(g.y - basePt[1]) < tol)
      return { aid: a.id, part: "move" };
    if (a.kind === "polygon" && a.id === state.selected) {
      for (let i = 0; i < g.points.length; i++)
        if (Math.abs(g.points[i][0] - basePt[0]) < tol &&
            Math.abs(g.points[i][1] - basePt[1]) < tol)
          return { aid: a.id, part: "vertex", index: i };
    }
    if (a.kind === "rect" && a.id === state.selected) {
      const [bx, by] = [g.x + g.w, g.y + g.h];
      if (Math.abs(bx - basePt[0]) < tol && Math.abs(by - basePt[1]) < tol)
        return { aid: a.id, part: "corner" };
    }
  }
  for (const a of list) {
    const g = a.geometry;
    if (a.kind === "rect" && basePt[0] >= g.x && basePt[0] <= g.x + g.w &&
        basePt[1] >= g.y && basePt[1] <= g.y + g.h)
      return { aid: a.id, part: "move" };
    if (a.kind === "polygon" && pointInPolygon(basePt, g.points))
      return { aid: a.id, part: "move" };
  }
  return null;
}
function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (((yi > p[1]) !== (yj > p[1])) &&
        (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi))
      inside = !inside;
  }
  return inside;
}

// --------------------------------------------------------------------------- //
// 鼠标交互
// --------------------------------------------------------------------------- //
let gesture = null; // {type, hit, startBase, lastBase, ...}

function eventPos(e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

canvas.addEventListener("pointerdown", (e) => {
  const [sx, sy] = eventPos(e);
  if (e.button === 1 || state.spaceDown) {
    gesture = { type: "pan", x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (e.button !== 0) return;
  const bp = screenToBase(sx, sy);

  if (state.cropMode) {
    state.draft = { kind: "crop", start: [sx, sy], cur: [sx, sy] };
    gesture = { type: "crop" };
    canvas.setPointerCapture(e.pointerId);
    return;
  }

  if (state.tool === "point") {
    const aid = "anno_" + Math.random().toString(36).slice(2, 10);
    const doc = newDoc(aid, "point", { x: r3(bp[0]), y: r3(bp[1]) });
    applyServerAnnotation(aid, { ...doc, updatedAt: 0 }, {}); // 乐观占位
    commitAid(aid, doc).then(() => { state.selected = aid; renderAll(); });
    return;
  }
  if (state.tool === "rect") {
    state.draft = { kind: "rect", startB: bp, curB: bp };
    state.draft.start = baseToScreen(bp); state.draft.cur = baseToScreen(bp);
    gesture = { type: "draw-rect" };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (state.tool === "polygon") {
    if (!state.draft) state.draft = { kind: "polygon", pts: [], cur: null };
    state.draft.pts.push([r3(bp[0]), r3(bp[1])]);
    state.draft.cur = null;
    redraw();
    return;
  }
  // select
  const hit = hitTest(bp);
  state.selected = hit?.aid || null;
  if (hit) {
    gesture = {
      type: "drag-shape", hit,
      startB: bp, lastB: bp,
      origin: structuredClone(state.annots[hit.aid].geometry),
    };
    canvas.setPointerCapture(e.pointerId);
  }
  renderAll();
});

canvas.addEventListener("pointermove", (e) => {
  const [sx, sy] = eventPos(e);
  const bp = screenToBase(sx, sy);
  $("#status").textContent =
    `照片:${currentPhoto()?.label || "-"}  底图坐标(${bp[0].toFixed(4)}, ${bp[1].toFixed(4)})  缩放:${state.viewport?.scale.toFixed(2) || "-"}`;

  if (gesture?.type === "pan") {
    state.viewport.pan(e.clientX - gesture.x, e.clientY - gesture.y);
    gesture.x = e.clientX; gesture.y = e.clientY;
    redraw();
    return;
  }
  if (gesture?.type === "draw-rect") {
    state.draft.curB = bp; state.draft.cur = baseToScreen(bp);
    redraw();
    return;
  }
  if (gesture?.type === "crop") {
    state.draft.cur = [sx, sy];
    redraw();
    return;
  }
  if (gesture?.type === "drag-shape") {
    const [dx, dy] = [bp[0] - gesture.lastB[0], bp[1] - gesture.lastB[1]];
    translateGeometry(state.annots[gesture.hit.aid], gesture.hit, dx, dy,
      gesture.startB, bp, gesture.origin);
    gesture.lastB = bp;
    redraw();
    return;
  }
  if (state.draft?.kind === "polygon") {
    state.draft.cur = [sx, sy];
    redraw();
  }
});

canvas.addEventListener("pointerup", (e) => {
  if (gesture?.type === "draw-rect") {
    const a = state.draft.startB, b = state.draft.curB;
    const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
    const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
    state.draft = null;
    if (w > 0.004 && h > 0.004) {
      const aid = "anno_" + Math.random().toString(36).slice(2, 10);
      const doc = newDoc(aid, "rect", { x: r3(x), y: r3(y), w: r3(w), h: r3(h) });
      applyServerAnnotation(aid, { ...doc, updatedAt: 0 }, {});
      commitAid(aid, doc).then(() => { state.selected = aid; renderAll(); });
    }
    redraw();
  } else if (gesture?.type === "drag-shape") {
    const aid = gesture.hit.aid;
    const moved = gesture.lastB[0] !== gesture.startB[0] || gesture.lastB[1] !== gesture.startB[1];
    if (moved) {
      const doc = state.annots[aid];
      // 坐标保留 4 位，避免无意义抖动
      roundGeometry(doc.geometry);
      commitAid(aid, doc);
    }
    renderAll();
  } else if (gesture?.type === "crop") {
    finishCrop();
  }
  gesture = null;
});

canvas.addEventListener("dblclick", () => {
  if (state.tool === "polygon" && state.draft?.pts.length >= 3) finishPolygon();
});

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") { state.spaceDown = true; canvas.style.cursor = "grab"; }
  if (e.key === "Enter" && state.tool === "polygon" && state.draft?.pts.length >= 3)
    finishPolygon();
  if (e.key === "Escape") { state.draft = null; state.cropMode = false; $("#crop-hint").classList.add("hidden"); redraw(); }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") { state.spaceDown = false; canvas.style.cursor = "crosshair"; }
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const [sx, sy] = eventPos(e);
  state.viewport.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, sx, sy);
  redraw();
}, { passive: false });

function translateGeometry(a, hit, dx, dy, startB, curB, origin) {
  const g = a.geometry;
  if (hit.part === "vertex") {
    g.points[hit.index][0] = r3(origin.points[hit.index][0] + curB[0] - startB[0]);
    g.points[hit.index][1] = r3(origin.points[hit.index][1] + curB[1] - startB[1]);
    return;
  }
  if (hit.part === "corner") {
    g.w = r3(Math.max(0.002, origin.w + curB[0] - startB[0]));
    g.h = r3(Math.max(0.002, origin.h + curB[1] - startB[1]));
    return;
  }
  if (a.kind === "point") { g.x = r3(origin.x + dx); g.y = r3(origin.y + dy); }
  else if (a.kind === "rect") { g.x = r3(origin.x + dx); g.y = r3(origin.y + dy); }
  else if (a.kind === "polygon")
    g.points.forEach((p, i) => {
      p[0] = r3(origin.points[i][0] + dx);
      p[1] = r3(origin.points[i][1] + dy);
    });
}
function roundGeometry(g) {
  const r = (v) => Math.round(v * 10000) / 10000;
  if ("x" in g) { g.x = r(g.x); g.y = r(g.y); }
  if ("w" in g) { g.w = r(g.w); g.h = r(g.h); }
  if (g.points) g.points = g.points.map(([x, y]) => [r(x), r(y)]);
}

function finishPolygon() {
  const pts = state.draft.pts;
  state.draft = null;
  const aid = "anno_" + Math.random().toString(36).slice(2, 10);
  const doc = newDoc(aid, "polygon", { points: pts });
  applyServerAnnotation(aid, { ...doc, updatedAt: 0 }, {});
  commitAid(aid, doc).then(() => { state.selected = aid; renderAll(); });
  redraw();
}

function newDoc(aid, kind, geometry, label = "") {
  return { id: aid, kind, label, color: COLORS[Math.floor(Math.random() * COLORS.length)],
    deleted: false, geometry };
}
const r3 = (v) => Math.round(v * 1000) / 1000;

// --------------------------------------------------------------------------- //
// 裁剪：在当前照片上拖框 -> 生成子照片，frame 相对父图
// --------------------------------------------------------------------------- //
$("#btn-crop").onclick = () => {
  if (!currentPhoto()) return toast("先选择一张照片");
  state.cropMode = !state.cropMode;
  state.draft = null;
  $("#crop-hint").classList.toggle("hidden", !state.cropMode);
  toast(state.cropMode ? "在图上拖出裁剪框，Esc 取消" : "已退出裁剪模式");
};

async function finishCrop() {
  const d = state.draft;
  state.draft = null;
  const parent = currentPhoto();
  const img = state.images[parent.id];
  const vp = state.viewport;
  const n0 = vp.screenToNorm(Math.min(d.start[0], d.cur[0]), Math.min(d.start[1], d.cur[1]));
  const n1 = vp.screenToNorm(Math.max(d.start[0], d.cur[0]), Math.max(d.start[1], d.cur[1]));
  const rect = [r3(n0[0]), r3(n0[1]), r3(Math.abs(n1[0] - n0[0])), r3(Math.abs(n1[1] - n0[1]))];
  if (rect[2] < 0.01 || rect[3] < 0.01) { redraw(); return; }

  const { data: info } = await api(
    `/api/branches/${state.branchId}/photos/crop-info`,
    { method: "POST", body: { parentId: parent.id, rect } }
  );

  // 从父图实际像素裁出子图（父图本身可能就是裁剪/配准图，src 已是对应栅格）
  const c = document.createElement("canvas");
  c.width = info.width; c.height = info.height;
  c.getContext("2d").drawImage(
    img,
    rect[0] * img.naturalWidth, rect[1] * img.naturalHeight,
    rect[2] * img.naturalWidth, rect[3] * img.naturalHeight,
    0, 0, info.width, info.height
  );
  const label = prompt('子照片标签（如 "2025-05 局部特写"）', `${parent.label} 裁剪`);
  const photo = {
    parentId: parent.id, year: parent.year, label: label || `${parent.label} 裁剪`,
    width: info.width, height: info.height, frame: info.frame,
    src: c.toDataURL("image/jpeg", 0.85), cropRect: rect,
  };
  const { data: saved } = await api(
    `/api/branches/${state.branchId}/photos`, { method: "PUT", body: photo }
  );
  state.cropMode = false;
  $("#crop-hint").classList.add("hidden");
  state.currentPhotoId = saved.id;
  await refresh();
  toast("裁剪图已建立：frame 记录相对父图映射，标注经坐标链自动落回");
}

// --------------------------------------------------------------------------- //
// 上传今年照片（随后用「控制点对齐」校准到底图）
// --------------------------------------------------------------------------- //
function uploadPhoto() {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "image/*";
  inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = async () => {
        const label = prompt("照片标签（年份/日期）", new Date().getFullYear() + ""); || f.name;
        const body = {
          parentId: basePhoto()?.id, year: label, label,
          width: img.naturalWidth, height: img.naturalHeight,
          frame: identity3(), src: reader.result,
        };
        const { data: saved } = await api(
          `/api/branches/${state.branchId}/photos`, { method: "PUT", body });
        state.currentPhotoId = saved.id;
        await refresh();
        toast("照片已加入，frame 暂为恒等；用「控制点对齐」把它挂到底图");
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(f);
  };
  inp.click();
}

// --------------------------------------------------------------------------- //
// 控制点对齐对话框
// --------------------------------------------------------------------------- //
const alignState = { srcPts: [], dstPts: [], photoId: null };
const aSrc = $("#align-src"), aDst = $("#align-dst");
const aSrcCtx = aSrc.getContext("2d"), aDstCtx = aDst.getContext("2d");

$("#btn-align").onclick = () => {
  const p = currentPhoto();
  if (!p) return toast("先选择一张照片");
  if (!p.parentId) return toast("底图本身无需对齐；请选择某年/裁剪照片");
  alignState.photoId = p.id;
  alignState.srcPts = []; alignState.dstPts = [];
  $("#align-dlg").showModal();
  drawAlignCanvases();
};
$("#align-clear").onclick = () => { alignState.srcPts = []; alignState.dstPts = []; drawAlignCanvases(); };
$("#align-cancel").onclick = () => $("#align-dlg").close();

function alignFit(img, cv) {
  const r = cv.getBoundingClientRect();
  cv.width = r.width; cv.height = r.height;
  const s = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
  return { s, ox: (r.width - img.naturalWidth * s) / 2, oy: (r.height - img.naturalHeight * s) / 2 };
}
function drawOneAlign(cv, cx, img, pts, color) {
  const r = cv.getBoundingClientRect();
  cx.clearRect(0, 0, r.width, r.height);
  if (!img || !img.complete) return;
  const f = alignFit(img, cv);
  cx.drawImage(img, f.ox, f.oy, img.naturalWidth * f.s, img.naturalHeight * f.s);
  pts.forEach(([nx, ny], i) => {
    const x = f.ox + nx * img.naturalWidth * f.s;
    const y = f.oy + ny * img.naturalHeight * f.s;
    cx.beginPath(); cx.arc(x, y, 6, 0, Math.PI * 2);
    cx.fillStyle = color; cx.fill();
    cx.fillStyle = "#fff"; cx.font = "bold 11px sans-serif";
    cx.fillText(String(i + 1), x - 3, y + 4);
  });
}
function drawAlignCanvases() {
  const p = state.photos[alignState.photoId];
  const parent = state.photos[p.parentId];
  $("#align-src-info").textContent = ` ${parent.label}`;
  $("#align-dst-info").textContent = ` ${p.label}`;
  drawOneAlign(aSrc, aSrcCtx, state.images[parent.id], alignState.srcPts, "#2f7d4f");
  drawOneAlign(aDst, aDstCtx, state.images[p.id], alignState.dstPts, "#d35400");
  const n = Math.min(alignState.srcPts.length, alignState.dstPts.length);
  $("#align-rms").textContent = n >= 3
    ? `已有 ${n} 对点（${n === 3 ? "仿射" : "单应"}）` : `还需 ${3 - n} 对点`;
}
function alignClick(cv, img, arr, e) {
  const r = cv.getBoundingClientRect();
  const f = alignFit(img, cv);
  const nx = (e.clientX - r.left - f.ox) / (img.naturalWidth * f.s);
  const ny = (e.clientY - r.top - f.oy) / (img.naturalHeight * f.s);
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
  arr.push([r3(nx), r3(ny)]);
  drawAlignCanvases();
}
aSrc.addEventListener("click", (e) => {
  const p = state.photos[alignState.photoId];
  alignClick(aSrc, state.images[p.parentId], alignState.srcPts, e);
});
aDst.addEventListener("click", (e) => {
  alignClick(aDst, state.images[alignState.photoId], alignState.dstPts, e);
});

$("#align-apply").onclick = async () => {
  const s = alignState.srcPts, d = alignState.dstPts;
  if (s.length !== d.length || s.length < 3)
    return toast("两图点对数需一致且至少 3 对");
  const { data } = await api("/api/align", {
    method: "POST",
    body: { srcPts: s, dstPts: d },
  });
  const p = state.photos[alignState.photoId];
  p.frame = data.frame;
  await api(`/api/branches/${state.branchId}/photos`, { method: "PUT", body: p });
  toast(`已应用 frame（方向：父图→本图），RMS=${(data.rms * 1000).toFixed(2)}‰`);
  $("#align-dlg").close();
  await refresh();
};

// --------------------------------------------------------------------------- //
// UI：照片列表 / 年份 tabs / 标注列表 / 属性 / 冲突
// --------------------------------------------------------------------------- //
function renderPhotoUI() {
  const list = $("#photo-list");
  list.innerHTML = "";
  const addBtn = document.createElement("button");
  addBtn.textContent = "＋ 上传今年照片";
  addBtn.style.cssText = "width:100%;margin-bottom:8px";
  addBtn.onclick = uploadPhoto;
  list.appendChild(addBtn);

  const tabs = $("#year-tabs");
  tabs.innerHTML = "";
  for (const id of state.photoOrder) {
    const p = state.photos[id];
    const depth = photoDepth(p);
    const el = document.createElement("div");
    el.className = "photo-item" + (id === state.currentPhotoId ? " active" : "");
    el.innerHTML = `<div class="ph-year">${"　".repeat(depth)}${p.label}</div>
      <div class="ph-meta">${p.width}×${p.height} · ${p.parentId ? (p.cropRect ? "裁剪" : "配准") : "底图"} · ${frameKind(p)}</div>`;
    el.onclick = () => { state.currentPhotoId = id; setupViewport(); renderAll(); };
    list.appendChild(el);

    const tab = document.createElement("div");
    tab.className = "tab" + (id === state.currentPhotoId ? " active" : "");
    tab.textContent = p.label;
    tab.onclick = () => { state.currentPhotoId = id; setupViewport(); renderAll(); };
    tabs.appendChild(tab);
  }
}
function photoDepth(p) {
  let d = 0;
  while (p.parentId) { d++; p = state.photos[p.parentId]; if (!p) break; }
  return d;
}
function frameKind(p) {
  if (!p.frame) return "-";
  const projective = Math.abs(p.frame[2][0]) + Math.abs(p.frame[2][1]) > 1e-9;
  return projective ? "单应" : "仿射";
}

function renderAnnoList() {
  const el = $("#anno-list");
  el.innerHTML = "";
  const items = Object.values(state.annots).filter((a) => !a.deleted);
  $("#anno-count").textContent = `（${items.length}）`;
  for (const a of items) {
    const d = document.createElement("div");
    d.className = "anno-item" + (a.id === state.selected ? " selected" : "");
    d.innerHTML = `<span class="swatch" style="background:${a.color}"></span>
      <span class="nm">${a.label || a.kind}</span>
      <span class="who">${a.updatedBy || ""}</span>`;
    d.onclick = () => { state.selected = a.id; renderAll(); };
    el.appendChild(d);
  }
}

function renderProps() {
  const el = $("#props");
  const a = state.annots[state.selected];
  if (!a) { el.textContent = "未选中"; return; }
  const g = a.geometry;
  let coord = "";
  if (a.kind === "point") coord = `点 (${g.x}, ${g.y})`;
  if (a.kind === "rect") coord = `矩形 起(${g.x}, ${g.y}) 宽高(${g.w}, ${g.h})`;
  if (a.kind === "polygon") coord = `多边形 ${g.points.length} 个顶点`;
  el.innerHTML = `
    <label>标签</label><input type="text" id="p-label" value="${escapeHtml(a.label || "")}"/>
    <label>颜色</label><select id="p-color">
      ${COLORS.map((c) => `<option value="${c}" ${c === a.color ? "selected" : ""}>${c}</option>`).join("")}
    </select>
    <label>类型 / 坐标（底图归一化）</label><div class="coord">${coord}</div>
    <label>版本向量</label><div class="vv">${JSON.stringify(state.vvs[a.id] || {})}</div>
    <div style="margin-top:8px"><button class="danger" id="p-del">删除标注</button></div>`;
  $("#p-label").onchange = () => updateField(a.id, { label: $("#p-label").value });
  $("#p-color").onchange = () => updateField(a.id, { color: $("#p-color").value });
  $("#p-del").onclick = () => updateField(a.id, { deleted: true });
}
async function updateField(aid, patch) {
  const doc = { ...state.annots[aid], ...patch };
  await commitAid(aid, doc);
  state.selected = patch.deleted ? null : aid;
  renderAll();
}
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function renderConflicts() {
  const el = $("#conflict-list");
  $("#conflict-count").textContent = state.conflicts.length ? `×${state.conflicts.length}` : "";
  el.innerHTML = "";
  for (const cf of state.conflicts) {
    const d = document.createElement("div");
    d.className = "conflict-item";
    const pretty = (v) => v === "__deleted__" ? "（删除）" : JSON.stringify(v);
    d.innerHTML = `
      <div class="cp">${cf.aid}<br>${cf.path}</div>
      <div style="margin:4px 0">
        <span class="side-a">先提交 ${cf.winnerClient}：</span>${escapeHtml(pretty(cf.winner))}<br>
        <span class="side-b">后提交 ${cf.loserClient}：</span>${escapeHtml(pretty(cf.loser))}
      </div>`;
    const b1 = document.createElement("button");
    b1.textContent = `保留 ${cf.winnerClient} 的值`;
    b1.onclick = () => resolveConflictCard(cf, cf.winner);
    const b2 = document.createElement("button");
    b2.textContent = `改用 ${cf.loserClient} 的值`;
    b2.className = "primary";
    b2.onclick = () => resolveConflictCard(cf, cf.loser);
    const b3 = document.createElement("button");
    b3.textContent = "忽略"; b3.className = "minor";
    b3.onclick = () => { state.conflicts = state.conflicts.filter((x) => x.key !== cf.key); renderConflicts(); };
    d.append(b1, b2, b3);
    el.appendChild(d);
  }
}
async function resolveConflictCard(cf, value) {
  await api(`/api/branches/${state.branchId}/annotations/${cf.aid}/resolve`, {
    method: "POST",
    body: { clientId: me, revision: nextRev(me), path: cf.path, value },
  });
  state.conflicts = state.conflicts.filter((x) => x.key !== cf.key);
  toast("冲突已裁决并写入新版本");
  await refresh();
}

function renderAll() {
  renderPhotoUI(); renderAnnoList(); renderProps(); renderConflicts(); redraw();
}
function toast(text) {
  const t = $("#toast");
  t.textContent = text; t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2600);
}

// --------------------------------------------------------------------------- //
// 视图按钮 / 工具 / 身份
// --------------------------------------------------------------------------- //
$("#btn-zoom-in").onclick = () => { state.viewport?.zoomAt(1.25, canvas.clientWidth / 2, canvas.clientHeight / 2); redraw(); };
$("#btn-zoom-out").onclick = () => { state.viewport?.zoomAt(1 / 1.25, canvas.clientWidth / 2, canvas.clientHeight / 2); redraw(); };
$("#btn-fit").onclick = () => { setupViewport(); redraw(); };

document.querySelectorAll(".tool").forEach((b) => {
  b.onclick = () => {
    state.tool = b.dataset.tool;
    document.querySelectorAll(".tool").forEach((x) => x.classList.toggle("active", x === b));
    state.draft = null;
    const hints = { point: "单击照片添加点标注", rect: "按住拖出矩形", polygon: "逐个点击加顶点，双击或回车闭合，Esc 取消", select: "拖动标注移动；选中后可拖顶点/角点" };
    $("#draw-hint").textContent = hints[state.tool];
    redraw();
  };
});

const idSel = $("#identity");
USERS.forEach((u) => {
  const o = document.createElement("option");
  o.value = u; o.textContent = u;
  idSel.appendChild(o);
});
idSel.value = me;
idSel.onchange = () => { me = idSel.value; localStorage.setItem("ba_me", me); };

// --------------------------------------------------------------------------- //
// 并发演示
// --------------------------------------------------------------------------- //
$("#btn-demo-concurrent-diff").onclick = async () => {
  const aid = "anno_tip";
  if (!state.annots[aid]) return toast("请先载入演示数据");
  idSel.value = "alice"; me = "alice";
  // 两位在同一旧 base 上同时开工
  const oldBase = structuredClone(state.synced[aid]);
  const oldVV = { ...state.syncedVV[aid] };
  // bob 先改 label；alice 在同一 base 上改 color —— 服务端应自动合并
  const bobDoc = { ...oldBase, label: "顶芽（bob 核对）" };
  await commitAs("bob", aid, bobDoc, oldBase, oldVV);
  const aliceDoc = { ...oldBase, color: "#9b59b6" };
  const { data } = await commitAs("alice", aid, aliceDoc, oldBase, oldVV);
  await refresh();
  if (data.conflicts.length === 0)
    toast("✅ 两人分别改 label/color：三向合并自动收敛，无冲突");
};

$("#btn-demo-concurrent-same").onclick = async () => {
  const aid = "anno_tip";
  if (!state.annots[aid]) return toast("请先载入演示数据");
  idSel.value = "alice"; me = "alice";
  const oldBase = structuredClone(state.synced[aid]);
  const oldVV = { ...state.syncedVV[aid] };
  // 两人基于同一 base，把同一字段 label 改成不同值
  const bobDoc = { ...oldBase, label: "顶芽-鲍勃命名" };
  await commitAs("bob", aid, bobDoc, oldBase, oldVV);
  const aliceDoc = { ...oldBase, label: "顶芽-爱丽丝命名" };
  const { status } = await commitAs("alice", aid, aliceDoc, oldBase, oldVV);
  await refresh();
  if (status === 409) toast("⚠ 同一字段并发冲突：bob 先提交者胜出，右侧可人工裁决");
};

// --------------------------------------------------------------------------- //
// 演示数据（本地 canvas 生成三年照片，单应配准）
// --------------------------------------------------------------------------- //
$("#btn-demo").onclick = async () => {
  const btn = $("#btn-demo");
  btn.disabled = true; btn.textContent = "生成中…";
  try {
    await seedDemo();
  } finally {
    btn.disabled = false; btn.textContent = "载入演示数据";
  }
};

function makeScene(W, H) {
  // 统一在 1000x1000 虚拟画布里画，实际按 W/H 拉伸
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d");
  x.scale(W / 1000, H / 1000);
  const bg = x.createLinearGradient(0, 0, 0, 1000);
  bg.addColorStop(0, "#dfe8dc"); bg.addColorStop(1, "#c3d1bf");
  x.fillStyle = bg; x.fillRect(0, 0, 1000, 1000);
  // 主干
  x.strokeStyle = "#6b4a2f"; x.lineCap = "round";
  x.lineWidth = 26;
  x.beginPath(); x.moveTo(120, 950);
  x.bezierCurveTo(250, 700, 300, 520, 470, 330);
  x.bezierCurveTo(560, 230, 620, 160, 700, 90);
  x.stroke();
  // 分枝
  x.lineWidth = 12;
  const twigs = [[470, 330, 640, 360, 780, 330], [330, 560, 220, 430, 150, 380],
    [560, 230, 520, 130, 470, 70]];
  for (const t of twigs) {
    x.beginPath(); x.moveTo(t[0], t[1]);
    x.bezierCurveTo(t[2], t[3], t[2], t[3], t[4], t[5]); x.stroke();
  }
  // 节/芽（跨年份稳定的标志结构）
  const buds = [[700, 90], [780, 330], [150, 380], [470, 70], [470, 330], [330, 560]];
  x.fillStyle = "#5d3d24";
  for (const [bx, by] of buds) { x.beginPath(); x.ellipse(bx, by, 16, 12, 0, 0, 7); x.fill(); }
  // 老叶痕（一个多边形结构）
  x.fillStyle = "#8a6a48";
  x.beginPath();
  [[300, 620], [330, 600], [350, 630], [325, 660], [295, 650]]
    .forEach(([px, py], i) => i ? x.lineTo(px, py) : x.moveTo(px, py));
  x.closePath(); x.fill();
  return c;
}

/** 用细密网格把 source 按单应 H（归一化->归一化）扭曲到目标画布 */
function warpMesh(src, H, W, Hd, N = 36) {
  const out = document.createElement("canvas");
  out.width = W; out.height = Hd;
  const g = out.getContext("2d");
  const bg = g.createLinearGradient(0, 0, 0, Hd);
  bg.addColorStop(0, "#dfe8dc"); bg.addColorStop(1, "#c3d1bf");
  g.fillStyle = bg; g.fillRect(0, 0, W, Hd);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const u0 = i / N, u1 = (i + 1) / N, v0 = j / N, v1 = (j + 1) / N;
      const s00 = [u0 * src.width, v0 * src.height];
      const s10 = [u1 * src.width, v0 * src.height];
      const s01 = [u0 * src.width, v1 * src.height];
      const d00 = mulH(H, [u0, v0], W, Hd);
      const d10 = mulH(H, [u1, v0], W, Hd);
      const d01 = mulH(H, [u0, v1], W, Hd);
      // 小格子用仿射近似透视
      const aff = affineFrom3(s00, s10, s01, d00, d10, d01);
      g.save(); g.transform(aff[0], aff[3], aff[1], aff[4], aff[2], aff[5]);
      g.drawImage(src, s00[0], s00[1], s10[0] - s00[0], s01[1] - s00[1],
        0, 0, s10[0] - s00[0], s01[1] - s00[1]);
      g.restore();
    }
  }
  return out;
}
function mulH(H, [u, v], W, Hd) {
  const w = H[2][0] * u + H[2][1] * v + H[2][2];
  return [(H[0][0] * u + H[0][1] * v + H[0][2]) / w * W,
          (H[1][0] * u + H[1][1] * v + H[1][2]) / w * Hd];
}
function affineFrom3(s0, s1, s2, d0, d1, d2) {
  // [sx sy 1] [a d]^T = dx ...；解两个 3x3
  const A = [[s0[0], s0[1], 1], [s1[0], s1[1], 1], [s2[0], s2[1], 1]];
  const ai = inv3(A);
  const bx = [d0[0], d1[0], d2[0]], by = [d0[1], d1[1], d2[1]];
  const dot = (m, v) => m.map((row) => row.reduce((t, x, k) => t + x * v[k], 0));
  return [...dot(ai, bx), ...dot(ai, by)];
}
function inv3(m) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const id = 1 / det;
  return [
    [(e * i - f * h) * id, (c * h - b * i) * id, (b * f - c * e) * id],
    [(f * g - d * i) * id, (a * i - c * g) * id, (c * d - a * f) * id],
    [(d * h - e * g) * id, (b * g - a * h) * id, (a * e - b * d) * id],
  ];
}
function addGrowth(canvas, ptsNorm, color) {
  const g = canvas.getContext("2d");
  for (const [u, v] of ptsNorm) {
    const x = u * canvas.width, y = v * canvas.height;
    g.fillStyle = color;
    g.beginPath();
    g.ellipse(x, y, 18, 9, -0.5, 0, 7); g.fill();
    g.beginPath(); g.ellipse(x + 14, y + 8, 16, 8, 0.4, 0, 7); g.fill();
  }
}

async function seedDemo() {
  const { data: branch } = await api("/api/branches", {
    method: "POST", body: { name: "院角桃树·东向主枝" },
  });
  state.branchId = branch.id;
  localStorage.setItem("ba_branch", branch.id);
  state.conflicts = [];

  const base = makeScene(1200, 800);

  // 2024：带轻微透视的单应（方向 base -> 2024）
  const H24 = [[0.90, 0.05, 0.04], [-0.02, 0.92, 0.03], [0.06, 0.01, 1.0]];
  const p24 = warpMesh(base, H24, 1080, 780);
  addGrowth(p24, [mulH(H24, [0.78, 0.33], 1, 1).slice()], "#4e8f3e");

  // 2025：纯仿射 + 偏移
  const H25 = [[0.95, -0.03, 0.02], [0.02, 0.97, 0.01], [0, 0, 1]];
  const p25 = warpMesh(base, H25, 1160, 840);
  addGrowth(p25, [mulH(H25, [0.70, 0.09], 1, 1), mulH(H25, [0.47, 0.07], 1, 1)], "#3c7a2e");

  const photos = [
    { year: "2023", label: "2023 底图", width: 1200, height: 800,
      parentId: null, frame: null, src: base.toDataURL("image/jpeg", 0.85) },
    { year: "2024", label: "2024-04", width: 1080, height: 780,
      frame: H24, src: p24.toDataURL("image/jpeg", 0.85) },
    { year: "2025", label: "2025-04", width: 1160, height: 840,
      frame: H25, src: p25.toDataURL("image/jpeg", 0.85) },
  ];
  const savedPhotos = {};
  for (const ph of photos) {
    if (ph.frame && !ph.parentId) {
      // 后两年的 parent 在保存时补为底图 id
    }
    const { data } = await api(`/api/branches/${branch.id}/photos`, {
      method: "PUT", body: ph,
    });
    savedPhotos[ph.label] = data;
  }
  // 把 2024/2025 挂到底图（PUT 时底图尚不存在 id，故补一次）
  const baseId = savedPhotos["2023 底图"].id;
  for (const label of ["2024-04", "2025-04"]) {
    const p = savedPhotos[label];
    p.parentId = baseId;
    await api(`/api/branches/${branch.id}/photos`, { method: "PUT", body: p });
  }

  // 再给 2024 建一张裁剪子图，演示“底图 -> 配准 -> 裁剪”两跳坐标链
  await refresh();
  const parent24 = state.photos[savedPhotos["2024-04"].id];
  state.currentPhotoId = parent24.id;
  await waitImage(parent24.id);
  const rect = [0.52, 0.08, 0.34, 0.42];
  const { data: info } = await api(
    `/api/branches/${branch.id}/photos/crop-info`,
    { method: "POST", body: { parentId: parent24.id, rect } }
  );
  const img24 = state.images[parent24.id];
  const cc = document.createElement("canvas");
  cc.width = info.width; cc.height = info.height;
  cc.getContext("2d").drawImage(img24,
    rect[0] * img24.naturalWidth, rect[1] * img24.naturalHeight,
    rect[2] * img24.naturalWidth, rect[3] * img24.naturalHeight,
    0, 0, info.width, info.height);
  await api(`/api/branches/${branch.id}/photos`, {
    method: "PUT",
    body: { parentId: parent24.id, year: "2024", label: "2024-04 顶芽特写",
      width: info.width, height: info.height, frame: info.frame, cropRect: rect,
      src: cc.toDataURL("image/jpeg", 0.85) },
  });

  // 标注全部写在底图归一化坐标
  state.currentPhotoId = baseId;
  await refresh();
  const seeds = [
    { id: "anno_tip", kind: "point", label: "顶芽", color: "#ff5d5d",
      geometry: { x: 0.7, y: 0.09 } },
    { id: "anno_scar", kind: "polygon", label: "老叶痕", color: "#f5a623",
      geometry: { points: [[0.295, 0.62], [0.33, 0.6], [0.35, 0.63], [0.325, 0.66], [0.295, 0.65]] } },
    { id: "anno_zone", kind: "rect", label: "观测区域", color: "#3a7bd5",
      geometry: { x: 0.08, y: 0.3, w: 0.14, h: 0.16 } },
  ];
  for (const s of seeds) {
    const doc = { deleted: false, ...s };
    const { data } = await api(
      `/api/branches/${branch.id}/annotations/${s.id}/commit`,
      { method: "PUT", body: { clientId: "alice", revision: nextRev("alice"),
        base: null, proposed: doc, baseVV: null } });
    applyServerAnnotation(s.id, data.annotation, data.vv);
  }

  state.currentPhotoId = baseId;
  await refresh();
  toast("演示就绪：切换年份/裁剪图、缩放平移，标注始终跟随枝条");
}

// --------------------------------------------------------------------------- //
// 启动
// --------------------------------------------------------------------------- //
(async function main() {
  resizeCanvas();
  if (state.branchId) {
    try {
      await refresh();
      setupViewport();
    } catch {
      state.branchId = null;
      localStorage.removeItem("ba_branch");
    }
  }
  redraw();
  eventLoop();
})();
