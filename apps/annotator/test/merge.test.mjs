import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePatch, resolveConflicts, initialVersions } from '../lib/merge.mjs';

function makeAnn() {
  // yearTo 故意不出现在初始 fields 中 → 它是真正的 v0 字段
  const fields = {
    geometry: { kind: 'point', x: 10, y: 20 },
    label: '花芽',
    color: '#d9480f',
    yearFrom: 2024,
    deleted: false,
  };
  fields.yearTo = null; // 占位以满足读取；其 v 仍以 set 传入 initialVersions 为准
  return {
    id: 'ann_1', plantId: 'p1',
    fields: { geometry: fields.geometry, label: fields.label, color: fields.color, yearFrom: fields.yearFrom, deleted: false },
    v: initialVersions({ geometry: fields.geometry, label: fields.label, color: fields.color, yearFrom: fields.yearFrom, deleted: false }),
    history: {},
  };
}

// 历史版本簿：模拟 store.getFieldValue（创建时即写入 v≥1 的初始快照）
function historyBook(ann) {
  const snaps = {};
  if (ann) {
    for (const [field, v] of Object.entries(ann.v)) {
      if (v >= 1) (snaps[field] ||= []).push({ v, value: structuredClone(ann.fields[field]) });
    }
  }
  return {
    record(target, field) {
      (snaps[field] ||= []).push({ v: target.v[field], value: structuredClone(target.fields[field]) });
    },
    get(_id, field, v) {
      return (snaps[field] || []).find((s) => s.v === v)?.value;
    },
  };
}

test('改不同字段：自动合并，互不阻塞', () => {
  const ann = makeAnn();
  const book = historyBook(ann);
  const baseV = { ...ann.v };

  // 甲改 label
  const a = mergePatch(ann, { set: { label: '甲的名字' }, baseV, by: 'A' }, book.get);
  assert.deepEqual(a.conflicts, {});
  assert.deepEqual(a.merged, ['label']);
  Object.assign(ann.fields, a.ann.fields);
  Object.assign(ann.v, a.ann.v);
  book.record(ann, 'label');

  // 乙基于原始 baseV 改 geometry（没动 label）
  const b = mergePatch(
    ann,
    { set: { geometry: { kind: 'point', x: 30, y: 40 } }, baseV, by: 'B' },
    book.get,
  );
  assert.deepEqual(b.conflicts, {});
  assert.deepEqual(b.merged, ['geometry']);
  // 甲的 label 保留
  assert.equal(b.ann.fields.label, '甲的名字');
  assert.deepEqual(b.ann.fields.geometry, { kind: 'point', x: 30, y: 40 });
});

test('改同一字段且值不同：冲突；base 快照可取回', () => {
  const ann = makeAnn();
  const book = historyBook(ann);
  const baseV = { ...ann.v };

  const a = mergePatch(ann, { set: { label: '甲' }, baseV, by: 'A' }, book.get);
  Object.assign(ann.fields, a.ann.fields);
  Object.assign(ann.v, a.ann.v);
  book.record(ann, 'label');

  const b = mergePatch(ann, { set: { label: '乙' }, baseV, by: 'B' }, book.get);
  assert.equal(Object.keys(b.conflicts).length, 1);
  assert.equal(b.conflicts.label.base, '花芽');
  assert.equal(b.conflicts.label.ours, '甲');
  assert.equal(b.conflicts.label.theirs, '乙');
  assert.deepEqual(b.merged, []); // 未写入
});

test('幂等：两人改成相同值直接成功', () => {
  const ann = makeAnn();
  const book = historyBook(ann);
  const baseV = { ...ann.v };
  const a = mergePatch(ann, { set: { color: '#1971c2' }, baseV, by: 'A' }, book.get);
  Object.assign(ann.fields, a.ann.fields);
  Object.assign(ann.v, a.ann.v);
  const b = mergePatch(ann, { set: { color: '#1971c2' }, baseV, by: 'B' }, book.get);
  assert.deepEqual(b.conflicts, {});
  assert.deepEqual(b.merged, []);
});

test('连续多次提交：版本号递增，旧 baseV 仍能三方合并', () => {
  const ann = makeAnn();
  const book = historyBook(ann);
  const v0 = { ...ann.v };

  for (const label of ['v2', 'v3', 'v4']) {
    const r = mergePatch(
      ann,
      { set: { label }, baseV: { label: ann.v.label }, by: 'A' },
      book.get,
    );
    Object.assign(ann.fields, r.ann.fields);
    Object.assign(ann.v, r.ann.v);
    book.record(ann, 'label');
  }
  assert.equal(ann.v.label, 4);

  // 另一个人停留在 v1（值 "花芽"），改成 v5：base≠ours 且 theirs≠base 且 theirs≠ours
  const r = mergePatch(ann, { set: { label: '迟到的修改' }, baseV: v0, by: 'C' }, book.get);
  assert.ok(r.conflicts.label);
  assert.equal(r.conflicts.label.base, '花芽');

  // 裁决：用迟到者的值
  const resolved = resolveConflicts(ann, { label: 'theirs' }, { set: { label: '迟到的修改' } }, 'C');
  assert.deepEqual(resolved.merged, ['label']);
  assert.equal(resolved.ann.fields.label, '迟到的修改');
  assert.equal(resolved.ann.v.label, 5);

  // 裁决：保留服务端值，不推进版本
  const keep = resolveConflicts(ann, { label: 'ours' }, { set: { label: '迟到的修改' } }, 'C');
  assert.deepEqual(keep.merged, []);
  assert.equal(keep.ann.v.label, 4);
});

test('baseV 领先服务端：返回 BASE_AHEAD 冲突而非崩溃', () => {
  const ann = makeAnn();
  const r = mergePatch(
    ann,
    { set: { label: 'x' }, baseV: { label: 99 }, by: 'X' },
    () => undefined,
  );
  assert.ok(r.conflicts.label.reason === 'BASE_AHEAD');
});

test('未设置字段 v=0 也可参与合并', () => {
  const ann = makeAnn();
  assert.equal(ann.v.yearTo, 0);
  const book = historyBook(ann);
  const baseV = { yearTo: 0 };
  // 服务端当前 yearTo 为 null、base 也为 null（v0 时）→ 直接接受
  const r = mergePatch(ann, { set: { yearTo: 2030 }, baseV, by: 'A' }, book.get);
  assert.deepEqual(r.conflicts, {});
  assert.deepEqual(r.merged, ['yearTo']);
  assert.equal(r.ann.v.yearTo, 1);
});
