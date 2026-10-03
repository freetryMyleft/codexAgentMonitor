#!/usr/bin/env python3
"""Read-only Codex agent tree monitor. Python 3.10+, standard library only."""

from __future__ import annotations

import argparse
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
import json
import math
import os
from pathlib import Path
import shutil
import signal
import sys
import time
import unicodedata


STATUSES = {"idle", "running", "waiting", "done", "error", "interrupted", "unknown"}
MAX_LINE = 8 * 1024 * 1024


def clean(value: object) -> str:
    """Keep terminal control sequences and line breaks out of external text."""
    if not isinstance(value, (str, int, float)):
        return ""
    return "".join(c for c in str(value) if not unicodedata.category(c).startswith("C"))


def cell_width(text: str) -> int:
    return sum(0 if unicodedata.combining(c) else
               2 if unicodedata.east_asian_width(c) in ("W", "F") else 1 for c in text)


def fit(text: object, width: int, align: str = "left") -> str:
    text = clean(text)
    width = max(0, width)
    if cell_width(text) > width:
        result, used = "", 0
        for char in text:
            size = cell_width(char)
            if used + size > max(0, width - 1):
                break
            result += char
            used += size
        text = result + ("…" if width else "")
    padding = max(0, width - cell_width(text))
    if align == "center":
        return " " * (padding // 2) + text + " " * (padding - padding // 2)
    return text + " " * padding


def number(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value < 0 or value > 2**63 - 1 or (isinstance(value, float) and not math.isfinite(value)):
        return None
    return int(value)


def compact(value: int | None) -> str:
    if value is None:
        return "—"
    if value >= 1_000_000:
        return f"{value / 1_000_000:.2f}M"
    if value >= 1000:
        return f"{value / 1000:.1f}k"
    return str(value)


def event_clock(timestamp: object) -> str:
    if isinstance(timestamp, str):
        try:
            return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone().strftime("%H:%M:%S")
        except (ValueError, OverflowError, OSError):
            pass
    return datetime.now().strftime("%H:%M:%S")


@dataclass
class Agent:
    id: str
    parent_id: str | None = None
    name: str = ""
    role: str = "agent"
    model: str = "unknown"
    effort: str = "unknown"
    cwd: str = ""
    status: str = "unknown"
    activity: str = "no activity recorded"
    input_tokens: int | None = None
    cached_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None
    context_tokens: int | None = None
    context_window: int | None = None
    tool_calls: int = 0
    advice_calls: int = 0
    advice: str = ""
    updated_at: str = ""
    pending: dict[str, str] = field(default_factory=dict)

    @property
    def label(self) -> str:
        return self.name or self.role + " · " + self.id[:8]


class MonitorState:
    def __init__(self) -> None:
        self.agents: dict[str, Agent] = {}
        self.root_id: str | None = None
        self.logs: deque[tuple[str, str, str]] = deque(maxlen=100)
        self.decisions: deque[dict] = deque(maxlen=3)
        self.forks: int | None = None

    def agent(self, agent_id: str) -> Agent:
        if agent_id not in self.agents:
            self.agents[agent_id] = Agent(agent_id)
        return self.agents[agent_id]

    def children(self, parent_id: str) -> list[Agent]:
        return [a for a in self.agents.values() if a.parent_id == parent_id and a.id != parent_id]

    def log(self, agent: Agent, message: str, timestamp: object) -> None:
        self.logs.append((event_clock(timestamp), clean(agent.label), clean(message)))

    def usage(self, agent: Agent, usage: object) -> None:
        if not isinstance(usage, dict):
            return
        for source, target in [("input_tokens", "input_tokens"), ("cached_input_tokens", "cached_tokens"),
                               ("output_tokens", "output_tokens"), ("total_tokens", "total_tokens")]:
            value = number(usage.get(source))
            if value is not None:
                setattr(agent, target, value)
        if "total_tokens" not in usage and agent.input_tokens is not None and agent.output_tokens is not None:
            agent.total_tokens = agent.input_tokens + agent.output_tokens

    def settings(self, agent: Agent, payload: dict) -> None:
        for source, target in [("model", "model"), ("effort", "effort"),
                               ("reasoning_effort", "effort"), ("cwd", "cwd")]:
            if isinstance(payload.get(source), str):
                setattr(agent, target, clean(payload[source]))

    def consume(self, record: object, default_id: str) -> None:
        if not isinstance(record, dict):
            return
        kind = record.get("type")
        if not isinstance(kind, str):
            return
        normalized = {"agent", "status", "usage", "tool", "fork", "advice", "log"}
        if kind not in normalized | {"session_meta", "turn_context", "response_item", "event_msg", "token_usage_record"}:
            return
        payload = record.get("payload", {})
        if kind in normalized:
            payload = record
        if not isinstance(payload, dict):
            return
        identity = payload.get("agent_id", default_id)
        if kind == "session_meta":
            identity = payload.get("id", payload.get("session_id", default_id))
        if not isinstance(identity, str) or not identity:
            return
        is_new = identity not in self.agents
        agent = self.agent(identity)
        timestamp = record.get("timestamp")
        agent.updated_at = clean(timestamp)
        if kind in {"agent", "session_meta"}:
            parent = payload.get("parent_id", payload.get("parent_thread_id"))
            source = payload.get("source")
            spawn = source.get("subagent", {}).get("thread_spawn", {}) if isinstance(source, dict) and isinstance(source.get("subagent"), dict) else {}
            if isinstance(spawn, dict):
                parent = parent or spawn.get("parent_thread_id")
            if isinstance(parent, str) and parent != identity:
                agent.parent_id = parent
            role = payload.get("role", payload.get("agent_role"))
            if not role and isinstance(spawn, dict):
                role = spawn.get("agent_role")
            if not role and isinstance(source, dict) and isinstance(source.get("subagent"), dict):
                role = source["subagent"].get("other")
            if clean(role):
                agent.role = clean(role)
            elif is_new:
                agent.role = "main" if not agent.parent_id else "agent"
            if "name" in payload or "agent_nickname" in payload:
                agent.name = clean(payload.get("name", payload.get("agent_nickname")))
            elif isinstance(spawn, dict) and "agent_nickname" in spawn:
                agent.name = clean(spawn["agent_nickname"])
            self.settings(agent, payload)
            if isinstance(payload.get("status"), str) and payload["status"] in STATUSES:
                agent.status = payload["status"]
            if not agent.parent_id and self.root_id is None:
                self.root_id = agent.id
            self.log(agent, "session discovered", timestamp)
        elif kind == "turn_context":
            self.settings(agent, payload)
        elif kind == "token_usage_record":
            self.usage(agent, payload.get("thread_token_usage"))
        elif kind == "event_msg":
            event = payload.get("type")
            if not isinstance(event, str):
                return
            if event == "token_count":
                info = payload.get("info")
                if isinstance(info, dict):
                    self.usage(agent, info.get("total_token_usage"))
                    last = info.get("last_token_usage")
                    if isinstance(last, dict):
                        agent.context_tokens = number(last.get("total_tokens"))
                    agent.context_window = number(info.get("model_context_window"))
            elif event == "thread_settings_applied":
                settings = payload.get("thread_settings")
                if isinstance(settings, dict):
                    self.settings(agent, settings)
            elif event in {"task_started", "task_complete", "task_completed", "turn_aborted", "error"}:
                agent.status = {"task_started": "running", "task_complete": "done", "task_completed": "done",
                                "turn_aborted": "interrupted", "error": "error"}[event]
                agent.activity = "working" if agent.status == "running" else agent.status
                if agent.status != "running":
                    agent.pending.clear()
                self.log(agent, event, timestamp)
            elif event == "agent_message" and payload.get("phase") == "final_answer":
                agent.status, agent.activity = "done", "done"
                agent.pending.clear()
        elif kind == "response_item":
            item_type = payload.get("type")
            if not isinstance(item_type, str):
                return
            if item_type in {"function_call", "custom_tool_call"}:
                name = clean(payload.get("name")) or "unknown tool"
                call_id = payload.get("call_id")
                if isinstance(call_id, str):
                    agent.pending[call_id] = name
                agent.tool_calls += 1
                agent.status, agent.activity = "running", "tool: " + name
                self.log(agent, "→ " + name, timestamp)
            elif item_type in {"function_call_output", "custom_tool_call_output"}:
                call_id = payload.get("call_id")
                if isinstance(call_id, str):
                    agent.pending.pop(call_id, None)
                agent.activity = "tool: " + next(reversed(agent.pending.values())) if agent.pending else "working"
            elif item_type == "reasoning":
                agent.activity = "thinking"
            elif item_type == "message" and payload.get("role") == "assistant":
                if payload.get("channel") == "final":
                    agent.status, agent.activity = "done", "done"
                    agent.pending.clear()
                else:
                    agent.activity = "responding"
        elif kind == "status":
            status = payload.get("status")
            if isinstance(status, str) and status in STATUSES:
                agent.status = status
                agent.activity = clean(payload.get("message")) or status
                if status != "running":
                    agent.pending.clear()
                self.log(agent, agent.activity, timestamp)
        elif kind == "usage":
            self.usage(agent, payload)
        elif kind == "tool":
            agent.tool_calls += 1
            agent.activity = "tool: " + (clean(payload.get("name")) or "unknown")
            self.log(agent, agent.activity, timestamp)
        elif kind == "fork":
            count = number(payload.get("forks"))
            if count is not None:
                self.forks = count
            confidence = payload.get("confidence")
            if (isinstance(confidence, (int, float)) and not isinstance(confidence, bool)
                    and (not isinstance(confidence, float) or math.isfinite(confidence))):
                confidence = min(1.0, max(0.0, confidence))
            else:
                confidence = None
            decision = {"label": clean(payload.get("label")) or "decision", "confidence": confidence,
                        "route": clean(payload.get("route")) or "unknown"}
            self.decisions.append(decision)
            self.log(agent, f"fork · {decision['label']} → {decision['route']}", timestamp)
        elif kind == "advice":
            agent.advice_calls += 1
            agent.advice = clean(payload.get("message"))
            self.log(agent, "advice · " + agent.advice, timestamp)
        elif kind == "log":
            self.log(agent, clean(payload.get("message")), timestamp)


class FileTail:
    """Bounded binary reads retain incomplete JSON and UTF-8 until newline."""
    def __init__(self, path: Path, chunk_size: int = MAX_LINE) -> None:
        self.path = path
        self.chunk_size = chunk_size
        self.offset = 0
        self.pending = b""
        self.identity: tuple[int, int] | None = None
        self.bad_lines = 0
        self.reset = False
        self.backlog = False
        self.dropping = False
        self.error = ""

    def read(self) -> list[dict]:
        self.reset = False
        try:
            with self.path.open("rb") as stream:
                stat = os.fstat(stream.fileno())
                identity = (stat.st_dev, stat.st_ino)
                if self.identity is not None and (identity != self.identity or stat.st_size < self.offset):
                    self.offset, self.pending, self.bad_lines = 0, b"", 0
                    self.dropping, self.reset = False, True
                self.identity = identity
                stream.seek(self.offset)
                data = stream.read(self.chunk_size)
                self.offset = stream.tell()
                self.backlog = self.offset < stat.st_size
                self.error = ""
        except OSError as exc:
            self.error = clean(str(exc))
            self.backlog = False
            return []
        lines = (self.pending + data).split(b"\n")
        self.pending = lines.pop()
        records = []
        for line in lines:
            if self.dropping:
                self.dropping = False
                continue
            if not line.strip():
                continue
            if len(line) > MAX_LINE:
                self.bad_lines += 1
                continue
            try:
                value = json.loads(line)
                if isinstance(value, dict):
                    records.append(value)
                else:
                    self.bad_lines += 1
            except (ValueError, UnicodeDecodeError, RecursionError):
                self.bad_lines += 1
        if len(self.pending) > MAX_LINE:
            self.pending = b""
            if not self.dropping:
                self.bad_lines += 1
            self.dropping = True
        if self.dropping:
            self.pending = b""
        return records


class EventSource:
    def __init__(self, path: Path) -> None:
        self.tail = FileTail(path)
        self.description = "EVENTS · " + str(path)

    @property
    def backlog(self) -> bool:
        return self.tail.backlog

    @property
    def warning(self) -> str:
        return self.tail.error or (f"skipped {self.tail.bad_lines} invalid lines" if self.tail.bad_lines else "")

    def poll(self, state: MonitorState) -> None:
        records = self.tail.read()
        if self.tail.reset:
            state.__init__()
        for event in records:
            state.consume(event, "main")


class SessionSource:
    def __init__(self, directory: Path, session_id: str | None = None,
                 cwd: str | None = None, scan_interval: float = 5.0) -> None:
        self.directory = directory
        self.requested_id = session_id
        self.cwd = str(Path(cwd).expanduser().resolve()) if cwd else None
        self.scan_interval = scan_interval
        self.last_scan = -math.inf
        self.index: dict[Path, dict] = {}
        self.tails: dict[Path, FileTail] = {}
        self.root_id: str | None = None
        self.description = "waiting for session " + (session_id or "logs")
        self.scan_warning = ""

    @property
    def backlog(self) -> bool:
        return any(tail.backlog for tail in self.tails.values())

    @property
    def warning(self) -> str:
        errors = [tail.error for tail in self.tails.values() if tail.error]
        skipped = sum(tail.bad_lines for tail in self.tails.values())
        return self.scan_warning or (errors[0] if errors else f"skipped {skipped} invalid lines" if skipped else "")

    def scan(self) -> None:
        self.last_scan = time.monotonic()
        self.scan_warning = ""
        seen = set()
        try:
            paths = self.directory.rglob("*.jsonl")
            for path in paths:
                try:
                    stat = path.stat()
                    seen.add(path)
                    cached = self.index.get(path)
                    identity = (stat.st_dev, stat.st_ino)
                    if cached and cached["identity"] == identity and stat.st_size >= cached["size"]:
                        cached.update(mtime=stat.st_mtime, size=stat.st_size)
                        continue
                    with path.open("rb") as stream:
                        first_line = stream.readline(MAX_LINE + 1)
                    if not first_line.endswith(b"\n") or len(first_line) > MAX_LINE:
                        self.index.pop(path, None)
                        continue
                    first = json.loads(first_line)
                    if not isinstance(first, dict) or first.get("type") != "session_meta":
                        continue
                    payload = first.get("payload")
                    if not isinstance(payload, dict):
                        continue
                    temp = MonitorState()
                    temp.consume(first, path.stem)
                    if not temp.agents:
                        continue
                    agent = next(iter(temp.agents.values()))
                    self.index[path] = {"id": agent.id, "parent": agent.parent_id, "cwd": agent.cwd,
                                        "identity": identity, "size": stat.st_size, "mtime": stat.st_mtime}
                except (OSError, ValueError, RecursionError) as exc:
                    self.scan_warning = "some session metadata could not be read: " + clean(str(exc))
                    self.index.pop(path, None)
        except OSError as exc:
            self.scan_warning = clean(str(exc))
        self.index = {p: info for p, info in self.index.items() if p in seen}

    def poll(self, state: MonitorState) -> None:
        if time.monotonic() - self.last_scan >= self.scan_interval:
            self.scan()
        if self.root_id is None:
            candidates = [(path, info) for path, info in self.index.items()
                          if (not self.cwd or info["cwd"] == self.cwd)
                          and (info["id"].startswith(self.requested_id) if self.requested_id else not info["parent"])]
            ids = {info["id"] for _, info in candidates}
            if self.requested_id and len(ids) > 1:
                self.description = "ambiguous session prefix: " + self.requested_id
                return
            if not candidates:
                self.description = "waiting for session " + (self.requested_id or "logs")
                if not self.directory.exists():
                    self.scan_warning = "sessions directory does not exist: " + str(self.directory)
                return
            _, selected = max(candidates, key=lambda item: item[1]["mtime"])
            self.root_id = selected["id"]
        selected_ids = {self.root_id}
        while True:
            children = {info["id"] for info in self.index.values() if info["parent"] in selected_ids}
            if children <= selected_ids:
                break
            selected_ids |= children
        selected_paths = [path for path, info in self.index.items() if info["id"] in selected_ids]
        for path in selected_paths:
            if path not in self.tails:
                self.tails[path] = FileTail(path)
        state.root_id = self.root_id
        self.description = f"CODEX · {self.root_id} · {len(selected_paths)} log files"
        batches = [(path, tail.read()) for path, tail in self.tails.items()]
        if any(tail.reset for tail in self.tails.values()):
            # A replay must rebuild the entire tree, including cumulative counters.
            state.__init__()
            state.root_id = self.root_id
            self.tails = {path: FileTail(path) for path in selected_paths}
            batches = [(path, tail.read()) for path, tail in self.tails.items()]
        for path, records in batches:
            identity = self.index.get(path, {}).get("id", path.stem)
            for event in records:
                state.consume(event, identity)


def box(title: str, lines: list[str], width: int) -> list[str]:
    inside = max(0, width - 4)
    heading = fit(" " + title + " ", width - 2).rstrip()
    top = "┌" + heading + "─" * max(0, width - 2 - cell_width(heading)) + "┐"
    return [top] + ["│ " + fit(line, inside) + " │" for line in lines] + ["└" + "─" * (width - 2) + "┘"]


def context_bar(agent: Agent, width: int = 10) -> str:
    if agent.context_tokens is None or not agent.context_window:
        return "context —"
    fraction = min(1, agent.context_tokens / agent.context_window)
    filled = round(fraction * width)
    return f"ctx [{'█' * filled}{'░' * (width - filled)}] {fraction:.0%}"


class Dashboard:
    def agent_card(self, agent: Agent, width: int) -> list[str]:
        return box(agent.label, [agent.model, "effort: " + agent.effort,
                               context_bar(agent), agent.activity,
                               f"{agent.status.upper()} · tokens {compact(agent.total_tokens)}"], width)

    def tree(self, state: MonitorState, root: Agent) -> list[str]:
        lines = []
        visited = set()
        stack = [(root, "", "")]
        while stack:
            agent, prefix, connector = stack.pop()
            if agent.id in visited:
                lines.append(prefix + connector + "↻ " + agent.label)
                continue
            visited.add(agent.id)
            lines.append(prefix + connector + f"{agent.label} | {agent.status.upper()} | {agent.model} | {compact(agent.total_tokens)} tokens")
            children = state.children(agent.id)
            for index in range(len(children) - 1, -1, -1):
                last = index == len(children) - 1
                extension = "   " if connector == "└─ " else "│  " if connector else ""
                stack.append((children[index], prefix + extension, "└─ " if last else "├─ "))
        return lines

    def render(self, state: MonitorState, width: int, height: int, source: str,
               warning: str = "", demo: bool = False) -> str:
        width, height = max(1, width), max(1, height)
        header = "CODEX AGENT TREE  ·  " + ("DEMO / 模拟数据" if demo else "LIVE / 本地日志")
        agents = list(state.agents.values())
        counts = {status: sum(a.status == status for a in agents) for status in STATUSES}
        usage = [a.total_tokens for a in agents if a.total_tokens is not None]
        tokens = compact(sum(usage)) if usage else "—"
        unknown = len(agents) - len(usage)
        summary = f"agents {len(agents)} · running {counts['running']} · done {counts['done']} · errors {counts['error']} · tokens {tokens}"
        if unknown:
            summary += f" ({unknown} unknown)"
        top = [fit(header, width, "center"), "─" * width, fit(summary, width), fit(source, width)]
        root = state.agents.get(state.root_id or "")
        if not root and agents:
            root = next((a for a in agents if not a.parent_id), agents[0])
        body = []
        if root:
            if width >= 100 and height >= 30:
                side_width = 26
                center_width = width - side_width - 3
                architects = [a for a in agents if "architect" in a.role.lower()]
                side_lines = ["architect · on call", "", f"observed: {len(architects)}",
                              "advice calls: " + str(sum(a.advice_calls for a in architects)), ""]
                if architects:
                    architect = architects[-1]
                    side_lines += [architect.label, architect.model, "effort: " + architect.effort,
                                   "status: " + architect.status, "tokens: " + compact(architect.total_tokens),
                                   "", "last advice:", architect.advice or "not recorded"]
                else:
                    side_lines += ["no architect session", "observed in this tree", "", "advice: —"]
                side_lines += ["", "Only recorded data", "is displayed."]
                side = box("ARCHITECT", side_lines, side_width)
                card_width = min(center_width, 48)
                center = [fit(line, center_width, "center") for line in self.agent_card(root, card_width)]
                center += [fit("│", center_width, "center"), fit("▼", center_width, "center")]
                forks = "—" if state.forks is None else f"{state.forks:,}"
                decision_lines = []
                for decision in state.decisions:
                    prob = decision["confidence"]
                    bar = "░" * 10 if prob is None else "█" * round(prob * 10) + "░" * (10 - round(prob * 10))
                    value = "—" if prob is None else f"{prob:.2f}"
                    decision_lines.append(f"{decision['label']:<15} {bar} {value} {decision['route']}")
                if not decision_lines:
                    decision_lines = ["decision confidence: —", "Connect fork events to show probabilities."]
                fork_box = box("FORK LAYER · forks " + forks, decision_lines, min(62, center_width))
                center += [fit(line, center_width, "center") for line in fork_box]
                children = [child for child in state.children(root.id) if child not in architects]
                if children:
                    center += [fit("│", center_width, "center"), fit("▼", center_width, "center")]
                    column_count = min(3, len(children))
                    child_width = (center_width - 2 * (column_count - 1)) // column_count
                    cards = [self.agent_card(child, child_width) for child in children[:column_count]]
                    center += [fit("  ".join(row), center_width, "center") for row in zip(*cards)]
                    center += [fit("▼", center_width, "center")]
                    return_box = box("BACK TO MAIN · review / verify", [
                        f"recorded status: {root.status} · tools: {sum(a.tool_calls for a in agents)}",
                        "activity: " + root.activity], min(62, center_width))
                    center += [fit(line, center_width, "center") for line in return_box]
                body = [fit(side[i] if i < len(side) else "", side_width) + "   " +
                        (center[i] if i < len(center) else " " * center_width)
                        for i in range(max(len(side), len(center)))]
                # Full tree follows the cards so descendants beyond the first row remain visible.
                if len(children) > 3 or any(state.children(child.id) for child in children):
                    body += self.tree(state, root)[1:]
            else:
                body = ["", "MODEL " + root.model + " · effort " + root.effort,
                        context_bar(root), ""] + self.tree(state, root)
                if state.decisions:
                    body += ["", "FORK " + state.decisions[-1]["label"] + " → " + state.decisions[-1]["route"]]
        else:
            body = ["", "Waiting for agent events…", "Try --demo, --events PATH, or --sessions-dir PATH."]
        log_count = min(4, max(0, height // 6))
        footer = ["─" * width, "SESSION LOG"]
        footer += [f"{clock}  {name[:18]:<18}  {message}" for clock, name, message in list(state.logs)[-log_count:]] if log_count else []
        if warning:
            footer.append("NOTICE " + warning)
        footer.append("Ctrl+C exit · refresh local events · unknown values shown as —")
        available = max(0, height - len(top) - len(footer))
        if len(body) > available and available > 0:
            # For crowded trees, favor a complete compact tree over partial card rows.
            if root and len(agents) > 4:
                body = self.tree(state, root)
            if len(body) > available:
                omitted = len(body) - max(0, available - 1)
                body = body[:max(0, available - 1)] + [f"… {omitted} more rows · increase terminal height / use --once --height 80"]
        output = top + body[:available] + footer
        return "\n".join(fit(line, width) for line in output[:height])


def demo_events() -> list[dict]:
    """Sample values inspired by the reference image; never used in live mode."""
    return [
        {"type": "agent", "agent_id": "sol", "name": "SOL · main", "role": "main", "model": "demo-sol", "effort": "high", "status": "running"},
        {"type": "agent", "agent_id": "astra", "parent_id": "sol", "name": "ASTRA", "role": "architect", "model": "demo-astra", "status": "waiting", "effort": "high"},
        {"type": "agent", "agent_id": "worker", "parent_id": "sol", "name": "worker", "role": "worker", "model": "demo-sol", "effort": "medium", "status": "running"},
        {"type": "agent", "agent_id": "explorer", "parent_id": "sol", "name": "explorer", "role": "explorer", "model": "demo-luna", "effort": "medium", "status": "running"},
        {"type": "agent", "agent_id": "researcher", "parent_id": "sol", "name": "researcher", "role": "researcher", "model": "demo-luna", "effort": "medium", "status": "running"},
        {"type": "fork", "agent_id": "sol", "label": "which file", "confidence": 0.91, "route": "sharp", "forks": 1654},
        {"type": "fork", "agent_id": "sol", "label": "which tool", "confidence": 0.47, "route": "split", "forks": 1655},
        {"type": "fork", "agent_id": "sol", "label": "retry or stop", "confidence": 0.93, "route": "sharp", "forks": 1656},
        {"type": "advice", "agent_id": "astra", "message": "run migration; add regression tests"},
        {"type": "status", "agent_id": "explorer", "status": "done", "message": "mapped 4 call sites"},
        {"type": "tool", "agent_id": "worker", "name": "run tests"},
        {"type": "usage", "agent_id": "sol", "input_tokens": 42000, "cached_input_tokens": 30000, "output_tokens": 5000},
        {"type": "usage", "agent_id": "worker", "input_tokens": 12000, "output_tokens": 2400},
        {"type": "usage", "agent_id": "explorer", "input_tokens": 18000, "output_tokens": 900},
        {"type": "usage", "agent_id": "researcher", "input_tokens": 9000, "output_tokens": 1800},
        {"type": "usage", "agent_id": "astra", "input_tokens": 700000, "output_tokens": 1200},
    ]


class DemoSource:
    description = "DEMO · sample values · no connection to a running agent"
    warning = ""
    backlog = False

    def __init__(self) -> None:
        self.started = False
        self.tick = 0

    def poll(self, state: MonitorState) -> None:
        if not self.started:
            for event in demo_events():
                state.consume(event, "sol")
            self.started = True
            return
        self.tick += 1
        if self.tick % 3 == 0:
            target = "worker" if self.tick % 6 == 0 else "researcher"
            agent = state.agents[target]
            state.consume({"type": "usage", "agent_id": target,
                           "input_tokens": (agent.input_tokens or 0) + 320,
                           "output_tokens": (agent.output_tokens or 0) + 80}, "sol")
            state.consume({"type": "tool", "agent_id": target,
                           "name": "run tests" if target == "worker" else "fetch docs"}, "sol")


def positive_float(value: str) -> float:
    result = float(value)
    if not math.isfinite(result) or result <= 0:
        raise argparse.ArgumentTypeError("must be a finite positive number")
    return result


def positive_int(value: str) -> int:
    result = int(value)
    if result <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return result


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Codex Agent 树实时监控（只读，本地，零依赖）")
    modes = result.add_mutually_exclusive_group()
    modes.add_argument("--demo", action="store_true", help="显示图片风格的模拟数据")
    modes.add_argument("--events", type=Path, metavar="JSONL", help="监控标准化事件 JSONL 文件")
    result.add_argument("--sessions-dir", type=Path,
                        default=Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "sessions",
                        help="Codex sessions 目录（默认 $CODEX_HOME/sessions 或 ~/.codex/sessions）")
    result.add_argument("--session", help="固定会话 ID 或唯一前缀（默认选最近会话后固定）")
    result.add_argument("--cwd", help="仅选择此工作目录的主会话")
    result.add_argument("--list", action="store_true", help="列出最近 20 个主会话")
    result.add_argument("--once", action="store_true", help="打印一次快照后退出")
    result.add_argument("--json", action="store_true", help="输出一次 JSON 快照后退出")
    result.add_argument("--interval", type=positive_float, default=1.0, help="刷新秒数（默认 1）")
    result.add_argument("--width", type=positive_int, help="指定显示宽度")
    result.add_argument("--height", type=positive_int, help="指定显示行数")
    result.add_argument("--no-color", action="store_true", help="禁用 ANSI 颜色")
    return result


def snapshot(state: MonitorState, source: object) -> dict:
    return {"source": source.description, "root_id": state.root_id, "warning": source.warning,
            "agents": [{key: value for key, value in vars(agent).items() if key != "pending"}
                       for agent in state.agents.values()],
            "forks": state.forks, "decisions": list(state.decisions), "logs": list(state.logs)}


def colorize(frame: str) -> str:
    colors = {"DONE": "\033[32m", "RUNNING": "\033[36m", "ERROR": "\033[31m", "INTERRUPTED": "\033[33m"}
    lines = []
    for index, line in enumerate(frame.splitlines()):
        color = "\033[1;36m" if index == 0 else "\033[2m" if index in (1, 3) else ""
        for status, code in colors.items():
            if status in line:
                color = code
                break
        lines.append(color + line + ("\033[0m" if color else ""))
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.list and (args.demo or args.events):
        parser().error("--list is for Codex sessions; cannot combine with --demo or --events")
    source = DemoSource() if args.demo else EventSource(args.events.expanduser()) if args.events else SessionSource(
        args.sessions_dir.expanduser(), args.session, args.cwd)
    if args.list:
        source.scan()
        entries = sorted((info for info in source.index.values() if not info["parent"] and
                          (not source.cwd or info["cwd"] == source.cwd)), key=lambda info: info["mtime"], reverse=True)[:20]
        print("SESSION ID                            LAST LOG UPDATE      CWD")
        for info in entries:
            print(f"{clean(info['id']):<37} {datetime.fromtimestamp(info['mtime']).strftime('%Y-%m-%d %H:%M:%S')}  {clean(info['cwd'])}")
        if not entries:
            print("No matching sessions. " + clean(source.warning))
        return 0
    state = MonitorState()
    dashboard = Dashboard()
    once = args.once or args.json or not sys.stdout.isatty()
    terminal = sys.stdout.isatty() and not once
    use_color = terminal and not args.no_color and "NO_COLOR" not in os.environ
    stopped = False

    def stop(_signum: int, _frame: object) -> None:
        nonlocal stopped
        stopped = True

    previous = signal.signal(signal.SIGTERM, stop)
    try:
        if terminal:
            sys.stdout.write("\033[?1049h\033[?25l")
            sys.stdout.flush()
        while not stopped:
            source.poll(state)
            if once:
                while source.backlog:
                    source.poll(state)
                if args.json:
                    print(json.dumps(snapshot(state, source), ensure_ascii=False, indent=2))
                    return 0
            size = shutil.get_terminal_size((120, 40))
            width, height = args.width or size.columns, args.height or size.lines
            # Leave the final terminal row free to prevent scrolling/wrapping.
            if terminal and args.height is None:
                height = max(1, height - 1)
            frame = dashboard.render(state, width, height, source.description, source.warning, args.demo)
            if use_color:
                frame = colorize(frame)
            if terminal:
                sys.stdout.write("\033[H" + frame + "\033[J")
                sys.stdout.flush()
            else:
                print(frame)
            if once:
                return 0
            time.sleep(args.interval)
    except KeyboardInterrupt:
        pass
    except BrokenPipeError:
        # Pipelines such as `--once | head` may close before the full frame.
        return 0
    finally:
        signal.signal(signal.SIGTERM, previous)
        if terminal:
            sys.stdout.write("\033[0m\033[?25h\033[?1049l")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
