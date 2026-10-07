# -*- coding: utf-8 -*-
"""内存存储层：株枝条(branch)、照片(photo)、标注(annotation)。

生产环境应替换为数据库，接口刻意保持很小。所有写操作在 store 级
锁内完成，保证“三向合并 + 落库”原子，多人并发提交不会交叉。
"""

from __future__ import annotations

import threading
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

from merge import merge_annotation, resolve_conflict, vv_tick


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class Store:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        # branch_id -> branch 文档
        self.branches: Dict[str, dict] = {}
        # branch_id -> {photo_id -> photo}
        self.photos: Dict[str, Dict[str, dict]] = {}
        # branch_id -> {annotation_id -> annotation}
        self.annotations: Dict[str, Dict[str, dict]] = {}
        # branch_id -> {annotation_id -> vv}
        self.vvs: Dict[str, Dict[str, dict]] = {}
        # branch_id -> 版本号（每次提交 +1，长轮询/乐观锁用）
        self.versions: Dict[str, int] = {}
        # branch_id -> condition（订阅者等待）
        self._conds: Dict[str, threading.Condition] = {}

    # ------------------------------------------------------------------ #
    # branch
    # ------------------------------------------------------------------ #
    def create_branch(self, name: str) -> dict:
        with self._lock:
            bid = new_id("br")
            branch = {"id": bid, "name": name, "createdAt": now_ms()}
            self.branches[bid] = branch
            self.photos[bid] = {}
            self.annotations[bid] = {}
            self.vvs[bid] = {}
            self.versions[bid] = 1
            self._conds[bid] = threading.Condition(self._lock)
            return branch

    def get_branch(self, bid: str) -> Optional[dict]:
        with self._lock:
            return self.branches.get(bid)

    def snapshot(self, bid: str) -> dict:
        """返回整株数据（首屏 GET 用）。"""
        with self._lock:
            if bid not in self.branches:
                raise KeyError(bid)
            return {
                "branch": self.branches[bid],
                "photos": list(self.photos[bid].values()),
                "annotations": list(self.annotations[bid].values()),
                "vvs": self.vvs[bid],
                "version": self.versions[bid],
            }

    # ------------------------------------------------------------------ #
    # photos
    # ------------------------------------------------------------------ #
    def put_photo(self, bid: str, photo: dict) -> dict:
        with self._lock:
            self._require_branch(bid)
            pid = photo.get("id") or new_id("ph")
            stored = {
                "id": pid,
                "parentId": photo.get("parentId"),
                "year": photo.get("year"),
                "label": photo.get("label", ""),
                "width": int(photo["width"]),
                "height": int(photo["height"]),
                "frame": photo.get("frame"),
                "src": photo.get("src"),
                "cropRect": photo.get("cropRect"),
                "createdAt": now_ms(),
            }
            if stored["parentId"] and stored["parentId"] not in self.photos[bid]:
                raise ValueError("parentId 不存在")
            self.photos[bid][pid] = stored
            self._bump(bid, "photo", "upsert", pid)
            return stored

    def delete_photo(self, bid: str, pid: str) -> None:
        with self._lock:
            self.photos[bid].pop(pid, None)
            self._bump(bid, "photo", "delete", pid)

    # ------------------------------------------------------------------ #
    # annotations
    # ------------------------------------------------------------------ #
    def commit_annotation(
        self,
        bid: str,
        client_id: str,
        revision: int,
        aid: str,
        base: Optional[dict],
        proposed: Optional[dict],
        base_vv: Optional[dict],
    ) -> dict:
        """三向合并 + 落库，返回提交结果（含 conflicts）。"""
        with self._lock:
            self._require_branch(bid)
            current = self.annotations[bid].get(aid)
            current_vv = self.vvs[bid].get(aid)

            merged, new_vv, conflicts = merge_annotation(
                current=current,
                current_vv=current_vv,
                base=base,
                proposed=proposed,
                base_vv=base_vv,
                client_id=client_id,
                revision=revision,
            )

            # 基本字段规范化
            merged["id"] = aid
            merged.setdefault("kind", "point")
            merged.setdefault("label", "")
            merged.setdefault("color", "#ff5d5d")
            merged.setdefault("deleted", False)
            merged["updatedAt"] = now_ms()
            merged["updatedBy"] = client_id
            if current is None:
                merged.setdefault("createdAt", now_ms())

            self.annotations[bid][aid] = merged
            self.vvs[bid][aid] = new_vv

            version = self._bump(bid, "annotation", "commit", aid, extra={
                "clientId": client_id,
                "conflicts": conflicts,
            })
            return {
                "annotation": merged,
                "vv": new_vv,
                "conflicts": conflicts,
                "version": version,
            }

    def resolve(
        self, bid: str, aid: str, client_id: str, revision: int,
        path: str, value: Any,
    ) -> dict:
        with self._lock:
            doc = self.annotations[bid][aid]
            vv = self.vvs[bid][aid]
            new_doc, new_vv = resolve_conflict(
                doc, vv, path, value, client_id, revision
            )
            new_doc["updatedAt"] = now_ms()
            new_doc["updatedBy"] = client_id
            self.annotations[bid][aid] = new_doc
            self.vvs[bid][aid] = new_vv
            version = self._bump(bid, "annotation", "resolve", aid)
            return {"annotation": new_doc, "vv": new_vv, "version": version}

    def delete_annotation(self, bid: str, aid: str) -> None:
        with self._lock:
            self.annotations[bid].pop(aid, None)
            self.vvs[bid].pop(aid, None)
            self._bump(bid, "annotation", "delete", aid)

    # ------------------------------------------------------------------ #
    # 订阅（长轮询）
    # ------------------------------------------------------------------ #
    def wait_version(self, bid: str, after: int, timeout: float = 25.0) -> int:
        """阻塞直到该 branch 版本 > after，返回当前版本。"""
        with self._lock:
            cond = self._conds[bid]
            end = time.time() + timeout
            while self.versions[bid] <= after:
                remaining = end - time.time()
                if remaining <= 0:
                    break
                cond.wait(timeout=remaining)
            return self.versions[bid]

    # ------------------------------------------------------------------ #
    # 内部
    # ------------------------------------------------------------------ #
    def _require_branch(self, bid: str) -> None:
        if bid not in self.branches:
            raise KeyError(bid)

    def _bump(self, bid: str, kind: str, op: str, rid: str,
              extra: Optional[dict] = None) -> int:
        self.versions[bid] += 1
        v = self.versions[bid]
        event = {"version": v, "kind": kind, "op": op, "id": rid,
                 "at": now_ms(), **(extra or {})}
        self._last_event = getattr(self, "_last_event", {})
        self._last_event[bid] = event
        self._conds[bid].notify_all()
        return v

    def last_event(self, bid: str) -> Optional[dict]:
        with self._lock:
            return getattr(self, "_last_event", {}).get(bid)
