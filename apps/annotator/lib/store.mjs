// 极简 JSON 文件存储 + 标注字段历史快照（供三方合并取 base 值）。
// 生产环境可把这一层换成 Postgres，接口保持不变。

import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const HISTORY_KEEP = 50; // 每字段最多保留的历史版本数

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export class Store extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.imagesDir = path.join(dir, 'images');
    this.dbPath = path.join(dir, 'db.json');
    mkdirSync(this.imagesDir, { recursive: true });
    this.db = this.#load();
  }

  #load() {
    if (existsSync(this.dbPath)) {
      try {
        return JSON.parse(readFileSync(this.dbPath, 'utf8'));
      } catch {
        // 损坏文件不覆盖，改名留档后重建
        renameSync(this.dbPath, `${this.dbPath}.corrupt-${Date.now()}`);
      }
    }
    return { plants: [], photos: [], annotations: [] };
  }

  #save() {
    const tmp = `${this.dbPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    renameSync(tmp, this.dbPath); // 原子替换
  }

  // ---------- plants ----------

  listPlants() {
    return this.db.plants;
  }

  getPlant(id) {
    return this.db.plants.find((p) => p.id === id) || null;
  }

  createPlant({ name, species }) {
    const plant = {
      id: uid('plt'),
      name,
      species: species || '',
      basePhotoId: null,
      createdAt: new Date().toISOString(),
    };
    this.db.plants.push(plant);
    this.#save();
    return plant;
  }

  setBasePhoto(plantId, photoId) {
    const plant = this.getPlant(plantId);
    if (!plant) return null;
    plant.basePhotoId = photoId;
    this.#save();
    return plant;
  }

  // ---------- photos ----------

  listPhotos(plantId) {
    return this.db.photos.filter((p) => p.plantId === plantId).sort((a, b) => a.year - b.year);
  }

  getPhoto(id) {
    return this.db.photos.find((p) => p.id === id) || null;
  }

  addPhoto({ plantId, year, imageFile, width, height, baseToImage, sourcePhotoId, note = '' }) {
    const photo = {
      id: uid('pho'),
      plantId,
      year,
      imageFile, // files/<file>
      width,
      height,
      baseToImage, // [a,b,c,d,e,f]：规范坐标 → 本图像素
      sourcePhotoId: sourcePhotoId || null,
      note,
      createdAt: new Date().toISOString(),
    };
    this.db.photos.push(photo);
    this.#save();
    return photo;
  }

  // ---------- annotations ----------

  listAnnotations(plantId) {
    return this.db.annotations.filter(
      (a) => a.plantId === plantId && a.fields.deleted !== true,
    );
  }

  getAnnotation(id) {
    return this.db.annotations.find((a) => a.id === id) || null;
  }

  addAnnotation({ plantId, fields, v, by }) {
    const now = new Date().toISOString();
    const ann = {
      id: uid('ann'),
      plantId,
      fields,
      v,
      history: {}, // { field: [{ v, value, by, at }] }
      createdBy: by,
      updatedBy: by,
      createdAt: now,
      updatedAt: now,
    };
    this.db.annotations.push(ann);
    this.#save();
    this.#snapshotCreated(ann);
    return ann;
  }

  #snapshotCreated(ann) {
    for (const [field, value] of Object.entries(ann.fields)) {
      ann.history[field] = [{ v: ann.v[field], value: structuredClone(value) }];
    }
  }

  /** 取某字段在版本 v 时的历史值（三方合并的 base）。 */
  getFieldValue(annId, field, v) {
    const ann = this.getAnnotation(annId);
    if (!ann) return undefined;
    if (ann.v[field] === v) return ann.fields[field];
    const snap = (ann.history[field] || []).find((s) => s.v === v);
    return snap ? snap.value : undefined;
  }

  /** 用合并结果整体替换标注，并给发生变更的字段写历史快照。 */
  commitAnnotation(mergedAnn, changedFields, by) {
    const idx = this.db.annotations.findIndex((a) => a.id === mergedAnn.id);
    if (idx < 0) return null;
    const prev = this.db.annotations[idx];
    const now = new Date().toISOString();

    for (const field of changedFields) {
      prev.history[field] = prev.history[field] || [];
      prev.history[field].push({
        v: mergedAnn.v[field],
        value: structuredClone(mergedAnn.fields[field]),
        by: by || null,
        at: now,
      });
      if (prev.history[field].length > HISTORY_KEEP) {
        prev.history[field].splice(0, prev.history[field].length - HISTORY_KEEP);
      }
    }
    prev.fields = mergedAnn.fields;
    prev.v = mergedAnn.v;
    prev.updatedBy = mergedAnn.updatedBy;
    prev.updatedAt = now;

    this.#save();
    return prev;
  }

  /** 广播：某标注被创建/修改（deleted 也照发，前端自行移除）。 */
  broadcast(plantId, type, annotation, meta = {}) {
    this.emit('annotation', { plantId, type, annotation, ...meta });
  }
}
