# -*- coding: utf-8 -*-
"""多人同时编辑同一标注：版本向量（Version Vector）+ 三向合并。

核心思路
========
一个标注是一个小文档，可能长这样::

    {"id": "a1", "kind": "polygon", "label": "新芽",
     "geometry": {"points": [[0.1, 0.2], ...]},
     "color": "#e23", "deleted": false}

* 把文档**摊平成叶子路径**（``geometry.points[2][0]`` 之类），
  每个叶子单独带版本向量 ``vv: {clientId: counter}``。
* 编辑时客户端携带三份数据：

    - ``base``：我开始编辑前读到的标注；
    - ``proposed``：我改成的内容；
    - ``baseVV``：我读到的版本向量；
    - 以及 ``clientId``、单调递增的 ``revision``（Lamport 风格计数）。

* 服务端拿 ``base`` / 服务端当前 ``current`` / ``proposed`` 做三向合并：

    - 只有一方改动某叶子 -> 采纳该方（两人改不同字段会自动合到一起）；
    - 双方都改成相同值 -> 收敛为该值；
    - 双方改了同一叶子且不同值 -> 冲突，**先提交者胜出**，
      后提交者的改动进入 ``conflicts`` 列表，UI 提示人工裁决；
    - 删除/恢复同样按叶子 LWW 处理（删除就是写 ``deleted=true``）。

* 冲突裁决（resolve）直接选定某一方的值并重写该叶子，版本向量
  记为裁决者 clientId 的新 revision。

这样系统满足：相同顺序重放结果一致、不同客户端并发提交最终收敛，
并且自动合并字段级编辑，真正的冲突不会被悄悄吞掉。
"""

from __future__ import annotations

import copy
from typing import Any, Dict, List, Optional, Tuple

# 叶子路径用 ["geometry","points",2,0] 形式表示
Path = List[Any]
# 版本向量：clientId -> counter
VV = Dict[str, int]


# --------------------------------------------------------------------------- #
# 摊平 / 还原
# --------------------------------------------------------------------------- #
def flatten(obj: Any, path: Optional[Path] = None) -> Dict[Tuple, Any]:
    """把嵌套 dict/list 摊平为 {路径元组: 叶子标量}。"""
    path = path or []
    if isinstance(obj, dict):
        out: Dict[Tuple, Any] = {}
        for k, v in obj.items():
            out.update(flatten(v, path + [k]))
        return out
    if isinstance(obj, list):
        out = {}
        for i, v in enumerate(obj):
            out.update(flatten(v, path + [i]))
        return out
    return {tuple(path): obj}


def unflatten(flat: Dict[Tuple, Any]) -> Any:
    """把摊平的叶子还原成嵌套 dict/list。"""
    root: Any = {}
    for path, value in flat.items():
        node = root
        for i, key in enumerate(path):
            last = i == len(path) - 1
            next_key = path[i + 1] if not last else None
            if isinstance(key, str):
                if last:
                    node[key] = value
                else:
                    if key not in node:
                        node[key] = [] if isinstance(next_key, int) else {}
                    node = node[key]
            else:  # int 下标
                while len(node) <= key:
                    node.append(None)
                if last:
                    node[key] = value
                elif node[key] is None:
                    node[key] = [] if isinstance(next_key, int) else {}
                node = node[key]
    _prune_none(root)
    return root


def _prune_none(node: Any) -> None:
    """数组尾部的 None 是占位符，递归裁掉。"""
    if isinstance(node, list):
        for item in node:
            _prune_none(item)
        while node and node[-1] is None:
            node.pop()
    elif isinstance(node, dict):
        for item in node.values():
            _prune_none(item)


# --------------------------------------------------------------------------- #
# 版本向量
# --------------------------------------------------------------------------- #
def vv_tick(vv: VV, client_id: str, revision: int) -> VV:
    out = dict(vv)
    out[client_id] = max(out.get(client_id, 0), revision)
    return out


def vv_merge(a: VV, b: VV) -> VV:
    keys = set(a) | set(b)
    return {k: max(a.get(k, 0), b.get(k, 0)) for k in keys}


def changed_paths(base: Optional[dict], proposed: Optional[dict]) -> Dict[Tuple, Any]:
    """返回 proposed 相对 base 改动过的叶子（新增/修改/删除）。

    base/proposed 为 None 表示文档不存在；删除时 proposed={"deleted": True}
    由上层包装，纯字段删除（key 消失）用哨兵 _DELETED 表示。
    """
    fb = flatten(base) if base is not None else {}
    fp = flatten(proposed) if proposed is not None else {}
    changed: Dict[Tuple, Any] = {}
    for p in set(fb) | set(fp):
        b, pval = fb.get(p, _MISSING), fp.get(p, _MISSING)
        if b != pval:
            changed[p] = pval
    return changed


_MISSING = object()
DELETED = "__deleted__"  # 叶子消失时冲突值里用该字符串表示


def _fmt_path(path: Tuple) -> str:
    return ".".join(str(x) for x in path)


# --------------------------------------------------------------------------- #
# 三向合并单个标注
# --------------------------------------------------------------------------- #
def merge_annotation(
    current: Optional[dict],
    current_vv: Optional[VV],
    base: Optional[dict],
    proposed: Optional[dict],
    base_vv: Optional[VV],
    client_id: str,
    revision: int,
) -> Tuple[dict, VV, List[dict]]:
    """三向合并一个标注。

    返回 (合并后的文档, 新版本向量, 冲突列表)。
    冲突项结构::

        {"path": "geometry.points.2.0", "winner": ..., "loser": ...,
         "winnerClient": "alice", "loserClient": "bob", "winnerRevision": 7}
    """
    current_vv = dict(current_vv or {})
    base_vv = dict(base_vv or {})

    # ---- 情形 A：新建标注（base 不存在） ----
    if base is None:
        if proposed is None:
            raise ValueError("base 与 proposed 不能同时为空")
        if current is None:
            # 双方都在新建：按路径比较，同值收敛，异值冲突
            return _merge_both_new(proposed, client_id, revision)
        # 我以为是新建，服务端已存在：把我的新建视作对已有文档的编辑
        return merge_annotation(
            current, current_vv, base=_empty_doc(), proposed=proposed,
            base_vv={}, client_id=client_id, revision=revision,
        )

    if proposed is None:
        # 纯删除整个文档：与删除单叶子语义不同，本系统用 deleted 标记，
        # 调用方应传 {"deleted": true}；这里防御性处理。
        raise ValueError("删除请提交 {'deleted': true} 而非空文档")

    fc = flatten(current if current is not None else {})
    fb = flatten(base)
    fp = flatten(proposed)

    # 我编辑期间，服务端已经被谁更新过？找出与 baseVV 相比更“新”的客户端。
    other_clients = [
        cid for cid, cnt in current_vv.items()
        if cnt > base_vv.get(cid, 0)
    ]

    result = copy.deepcopy(fc)
    new_vv = dict(current_vv)
    conflicts: List[dict] = []

    my_changes = changed_paths(base, proposed)

    # ---- 情形 B：无人并发，直接采纳（含我是最新的） ----
    if not other_clients:
        for path, val in my_changes.items():
            _apply_change(result, path, val)
            new_vv = vv_tick(new_vv, client_id, revision)
        doc = unflatten(result)
        return doc, new_vv, conflicts

    # ---- 情形 C：并发，逐叶子三向合并 ----
    server_changes = changed_paths(base, current)

    for path, my_val in my_changes.items():
        srv_val = server_changes.get(path, _UNCHANGED)

        if srv_val is _UNCHANGED:
            # 对方没动这个叶子 -> 采纳我的
            _apply_change(result, path, my_val)
            new_vv = vv_tick(new_vv, client_id, revision)
            continue

        # 双方都改了
        if srv_val == my_val:
            # 改成相同值 -> 收敛，我的计数也记上（版本向量包含“我知道这个值”）
            new_vv = vv_tick(new_vv, client_id, revision)
            continue

        # 真冲突：先到的已经写在 current 里 -> 服务端值获胜
        winner_client, winner_rev = _writer_of(current_vv, base_vv, path)
        conflicts.append({
            "path": _fmt_path(path),
            "winnerClient": winner_client,
            "loserClient": client_id,
            "winner": _present(result.get(path, _MISSING)),
            "loser": _present(my_val),
            "winnerRevision": winner_rev,
            "loserRevision": revision,
        })
        # 输家计数器仍记录（发生过这次写入尝试，用于后续 happens-before 判断）
        new_vv = vv_tick(new_vv, client_id, revision)

    return unflatten(result), new_vv, conflicts


_UNCHANGED = object()


def _empty_doc() -> dict:
    return {}


def _present(v: Any) -> Any:
    if v is _MISSING:
        return DELETED
    return v


def _apply_change(flat: Dict[Tuple, Any], path: Tuple, value: Any) -> None:
    if value is _MISSING:
        flat.pop(path, None)
    else:
        flat[path] = value


def _writer_of(current_vv: VV, base_vv: VV, path: Tuple) -> Tuple[str, int]:
    """找出并发写动服务端值的客户端（比 baseVV 更新的那个）。"""
    best_cid, best_cnt = "", 0
    for cid, cnt in current_vv.items():
        if cnt > base_vv.get(cid, 0) and cnt > best_cnt:
            best_cid, best_cnt = cid, cnt
    return best_cid, best_cnt


def _merge_both_new(
    proposed: dict, client_id: str, revision: int
) -> Tuple[dict, VV, List[dict]]:
    """两个客户端同时用不同内容新建同一 id：以先到者（调用前已入库者）
    为 current 的路径在主流程处理；这里只处理 current 仍为 None 的首次创建，
    无冲突。"""
    return copy.deepcopy(proposed), {client_id: revision}, []


# --------------------------------------------------------------------------- #
# 冲突人工裁决
# --------------------------------------------------------------------------- #
def resolve_conflict(
    doc: dict, vv: VV, path: str, value: Any, client_id: str, revision: int
) -> Tuple[dict, VV]:
    """人工选择冲突叶子的最终值（也可填入完全新值）。

    path 形如 "geometry.points.2.0"；数字段按下标处理。
    value 为 "__deleted__" 表示删除该叶子。
    """
    key = tuple(int(p) if p.lstrip("-").isdigit() else p
                for p in path.split("."))
    flat = flatten(doc)
    if value == DELETED:
        flat.pop(key, None)
    else:
        flat[key] = value
    return unflatten(flat), vv_tick(vv, client_id, revision)
