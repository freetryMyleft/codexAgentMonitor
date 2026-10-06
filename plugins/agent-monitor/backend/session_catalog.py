"""Metadata-only, paginated index of readable Codex sessions."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import time

from agent_monitor import MonitorState, SessionSource
from sidebar_state import SessionNames


SESSION_ID = re.compile(r"^[a-zA-Z0-9_-]{1,80}$")
STATUSES = {"idle", "running", "waiting", "done", "error", "interrupted", "unknown"}
EVENT_STATUS = {
    "task_started": "running",
    "task_complete": "done",
    "task_completed": "done",
    "turn_aborted": "interrupted",
    "error": "error",
}


class SessionCatalog:
    """Scans session metadata and bounded status evidence, never log bodies."""

    MAX_STATUS_BYTES = 64 * 1024
    MAX_STATUS_LINES = 64
    MAX_META_LINE = 8 * 1024 * 1024
    MAX_PAGE_SIZE = 500

    def __init__(self, sessions_dir: Path, names_path: Path | None = None) -> None:
        self.sessions_dir = Path(sessions_dir)
        self.source = SessionSource(self.sessions_dir, scan_interval=0)
        self.names_path = names_path or self.sessions_dir.parent / "session_index.jsonl"
        self.names = SessionNames(self.names_path)
        self.metadata_cache: dict[Path, tuple[tuple[int, int], int, int, dict | None]] = {}
        self.status_cache: dict[Path, tuple[tuple[int, int], int, int, str, str, str]] = {}
        self.entries: list[dict] = []
        self.revision = ""
        self.generated_at = ""
        self.warning = ""

    def _read_metadata(self, path: Path) -> dict | None:
        try:
            stat = path.stat()
            identity = (stat.st_dev, stat.st_ino)
            key = (identity, stat.st_size, stat.st_mtime_ns)
            cached = self.metadata_cache.get(path)
            if cached and cached[:3] == key:
                return cached[3]
            with path.open("rb") as stream:
                opened = os.fstat(stream.fileno())
                if (opened.st_dev, opened.st_ino) != identity:
                    return None
                line = stream.readline(self.MAX_META_LINE + 1)
            if not line.endswith(b"\n") or len(line) > self.MAX_META_LINE:
                metadata = None
            else:
                record = json.loads(line)
                state = MonitorState()
                if isinstance(record, dict) and record.get("type") == "session_meta":
                    state.consume(record, path.stem)
                agent = next(iter(state.agents.values()), None)
                metadata = ({"id": agent.id, "parent_id": agent.parent_id, "cwd": agent.cwd} if agent else None)
            self.metadata_cache[path] = (*key, metadata)
            return metadata
        except (OSError, ValueError, RecursionError):
            return None

    def _read_status(self, path: Path, session_id: str) -> tuple[str, str, str]:
        try:
            stat = path.stat()
            identity = (stat.st_dev, stat.st_ino)
            key = (identity, stat.st_size, stat.st_mtime_ns)
            cached = self.status_cache.get(path)
            if cached and cached[:3] == key:
                return cached[3], cached[4], cached[5]

            status = "unknown"
            status_at = ""
            updated_at = ""
            with path.open("rb") as stream:
                opened = os.fstat(stream.fileno())
                if (opened.st_dev, opened.st_ino) != identity:
                    return "unknown", "", ""
                stream.seek(max(0, opened.st_size - self.MAX_STATUS_BYTES))
                data = stream.read(self.MAX_STATUS_BYTES)
            lines = data.splitlines()
            if data and not data.endswith(b"\n"):
                lines.pop()
            if len(lines) > self.MAX_STATUS_LINES:
                lines = lines[-self.MAX_STATUS_LINES:]
            for raw in lines:
                if not raw or len(raw) > self.MAX_STATUS_BYTES:
                    continue
                try:
                    record = json.loads(raw)
                except (ValueError, UnicodeDecodeError, RecursionError):
                    continue
                if not isinstance(record, dict):
                    continue
                timestamp = record.get("timestamp")
                if isinstance(timestamp, str) and timestamp:
                    updated_at = timestamp[:80]
                kind = record.get("type")
                if not isinstance(kind, str):
                    continue
                payload = record.get("payload", {})
                if not isinstance(payload, dict):
                    payload = {}
                reported_id = record.get("agent_id", payload.get("agent_id"))
                if isinstance(reported_id, str) and reported_id != session_id:
                    continue
                candidate = None
                if kind == "session_meta":
                    candidate = payload.get("status")
                elif kind in {"agent", "status"}:
                    candidate = record.get("status", payload.get("status"))
                if kind == "event_msg":
                    event = payload.get("type")
                    candidate = EVENT_STATUS.get(event) if isinstance(event, str) else None
                if isinstance(candidate, str) and candidate in STATUSES:
                    status = candidate
                    status_at = timestamp[:80] if candidate != "unknown" and isinstance(timestamp, str) else ""

            if not updated_at:
                updated_at = datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()
            self.status_cache[path] = (*key, status, updated_at, status_at)
            return status, updated_at, status_at
        except (OSError, OverflowError, ValueError):
            return "unknown", "", ""

    def refresh(self) -> None:
        self.source.scan()
        self.names.poll()
        if not self.names_path.exists():
            self.names.names.clear()
        by_id: dict[str, tuple[float, dict]] = {}
        for path in self.source.index:
            indexed = self._read_metadata(path)
            if not indexed:
                continue
            session_id = indexed.get("id")
            if not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id):
                continue
            status, updated_at, status_at = self._read_status(path, session_id)
            try:
                modified = path.stat().st_mtime
            except OSError:
                continue
            entry = {
                "id": session_id,
                "parent_id": indexed.get("parent_id") or None,
                "cwd": indexed.get("cwd") or "",
                "title": self.names.get(session_id) or "",
                "status": status,
                "status_at": status_at,
                "updated_at": updated_at,
            }
            # Escaped lone surrogates are valid JSON but cannot be emitted as
            # UTF-8. Repair display metadata before hashing or streaming it.
            entry = {key: value.encode("utf-8", errors="replace").decode("utf-8")
                     if isinstance(value, str) else value for key, value in entry.items()}
            previous = by_id.get(session_id)
            if previous is None or modified > previous[0]:
                by_id[session_id] = (modified, entry)

        self.entries = [by_id[key][1] for key in sorted(by_id)]
        self.generated_at = datetime.now(timezone.utc).isoformat()
        revision_input = json.dumps(self.entries, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        self.revision = hashlib.sha256(revision_input.encode("utf-8")).hexdigest()[:24]
        self.warning = "会话目录不存在" if not self.sessions_dir.exists() else (
            "部分会话元数据不可读取" if self.source.scan_warning else ""
        )
        active = set(self.source.index)
        self.metadata_cache = {path: value for path, value in self.metadata_cache.items() if path in active}
        self.status_cache = {path: value for path, value in self.status_cache.items() if path in active}

    def page(self, *, offset: int = 0, limit: int = 100, revision: str | None = None,
             refresh: bool = False) -> dict:
        if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
            raise ValueError("目录偏移量不正确。")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= self.MAX_PAGE_SIZE:
            raise ValueError("目录每页数量不正确。")
        if refresh or not self.revision:
            self.refresh()
        if revision is not None and revision != self.revision:
            raise ValueError("目录已更新，请重新载入。")
        sessions = [dict(item) for item in self.entries[offset:offset + limit]]
        next_offset = offset + len(sessions) if offset + len(sessions) < len(self.entries) else None
        return {
            "sessions": sessions,
            "total": len(self.entries),
            "offset": offset,
            "next_offset": next_offset,
            "generated_at": self.generated_at,
            "warning": self.warning,
            "revision": self.revision,
        }
