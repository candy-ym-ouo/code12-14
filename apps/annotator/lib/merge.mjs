// 多人编辑同一标注时的版本合并。
//
// 模型：每条标注的每个可编辑字段都有自己的版本号（字段级版本向量）。
// 客户端保存它"上一次已知"的字段版本 baseV；提交补丁时带上 baseV。
// 服务端做三方合并：
//
//   base   = baseV 指向的历史值（客户端编辑时看到的）
//   theirs = 客户端提交的新值（补丁 value）
//   ours   = 服务端当前值
//
//   - base === ours          → 字段没被别人动过，直接接受 theirs
//   - ours === theirs        → 两人改成一样，幂等成功
//   - base === theirs        → 客户端没改这个字段，保留 ours
//   - 都不同且 ours≠theirs   → 真冲突，返回 CONFLICT，由人裁决
//
// 不同字段互不阻塞：A 改 label、B 改 geometry 会自动合并；只有改同一字段才冲突。

export const FIELDS = ['geometry', 'label', 'color', 'yearFrom', 'yearTo', 'deleted'];

export function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return a === b;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

/**
 * 对一条标注执行一次补丁合并（不修改入参）。
 *
 * @param {object} ann   服务端当前标注
 * @param {object} patch { baseV: {field: v}, set: {field: value}, by }
 * @param {function} getSnapshot(annId, field, v) 取某字段历史版本值；取不到返回 undefined
 * @returns {{ann: object, merged: string[], conflicts: object}}
 *   conflicts: { field: { base, ours, theirs, oursV } }
 */
export function mergePatch(ann, patch, getSnapshot) {
  const next = structuredClone(ann);
  const merged = [];
  const conflicts = {};

  for (const [field, theirs] of Object.entries(patch.set || {})) {
    if (!FIELDS.includes(field)) {
      const e = new Error(`unknown field: ${field}`);
      e.code = 'BAD_FIELD';
      throw e;
    }
    const baseV = patch.baseV?.[field];
    const oursV = next.v[field];
    const ours = next.fields[field];

    if (baseV === undefined || baseV === null) {
      // 没带 baseV：只允许"当前值等于提交值"的幂等写入。
      if (deepEqual(ours, theirs)) continue;
      conflicts[field] = { base: undefined, ours, theirs, oursV };
      continue;
    }

    if (baseV > oursV) {
      conflicts[field] = {
        base: undefined,
        ours,
        theirs,
        oursV,
        reason: 'BASE_AHEAD',
      };
      continue;
    }

    const base = baseV === oursV ? ours : getSnapshot(ann.id, field, baseV);

    // v0 表示"字段从未被修改"：没有历史快照，当前值即基线值。
    const baseValue = base === undefined && baseV === 0 ? ours : base;

    if (deepEqual(ours, theirs)) continue; // 幂等
    if (deepEqual(baseValue, theirs)) continue; // 我没改，别人改过，保留服务端
    if (deepEqual(baseValue, ours)) {
      // 只有我改了 → 接受
      next.fields[field] = theirs;
      next.v[field] = oursV + 1;
      merged.push(field);
      continue;
    }
    // 双方都改且不一致 → 冲突
    conflicts[field] = { base: baseValue, ours, theirs, oursV };
  }

  if (merged.length) {
    next.updatedBy = patch.by || next.updatedBy;
    next.updatedAt = new Date().toISOString();
  }
  return { ann: next, merged, conflicts };
}

/**
 * 冲突裁决后再次提交：choice = { field: 'ours' | 'theirs' }。
 * 以当前服务端状态为新 base，选择 theirs 时推进版本，选择 ours 时仅对齐 baseV。
 */
export function resolveConflicts(ann, choices, patch, by) {
  const next = structuredClone(ann);
  const merged = [];
  for (const [field, choice] of Object.entries(choices)) {
    if (choice === 'theirs') {
      next.fields[field] = patch.set[field];
      next.v[field] += 1;
      merged.push(field);
    }
    // 'ours'：保留服务端值，不推进版本
  }
  if (merged.length) {
    next.updatedBy = by || next.updatedBy;
    next.updatedAt = new Date().toISOString();
  }
  return { ann: next, merged };
}

/**
 * 首次创建标注时的初始字段版本向量。
 * 显式给出的字段 v=1，未设置的可空字段 v=0（参与后续三方合并）。
 */
export function initialVersions(set) {
  const v = {};
  for (const f of FIELDS) v[f] = set[f] !== undefined ? 1 : 0;
  return v;
}
