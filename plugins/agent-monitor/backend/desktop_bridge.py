#!/usr/bin/env python3
"""Persistent JSON stream consumed by the local sidebar monitoring backend."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import time

from agent_monitor import DemoSource, EventSource, SessionSource, snapshot
from sidebar_state import SidebarState, SessionNames, event_order


def desktop_snapshot(state, source, names=None):
    result = snapshot(state, source)
    result["generated_at"] = datetime.now(timezone.utc).isoformat()
    result["demo"] = isinstance(source, DemoSource)
    sessions = []
    if isinstance(source, SessionSource):
        roots = sorted((s for s in source.index.values() if not s["parent"]),
                       key=lambda s: s["mtime"], reverse=True)[:20]
        sessions = [{"id": s["id"], "cwd": s["cwd"], "title": names.get(s["id"]) if names else ""} for s in roots]
    result["sessions"] = sessions
    # Every file is replayed independently; merge flow records chronologically.
    result["flows"] = sorted(state.flows, key=event_order)
    result["session_title"] = names.get(state.root_id) if names else ("Agent 流转演示" if result["demo"] else "")
    for agent in result["agents"]:
        agent["session_title"] = names.get(agent["id"]) if names else ""
        agent["returned_at"] = agent.get("returned_at", "")
        agent["events"] = sorted(state.histories.get(agent["id"], []), key=event_order)
        agent["event_count"] = state.event_counts.get(agent["id"], 0)
        current = state.agents[agent["id"]]
        agent["active_tools"] = [tool for tool in current.pending.values()]
    return result


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--demo", action="store_true")
    group.add_argument("--events", type=Path)
    parser.add_argument("--session")
    parser.add_argument("--details-agent")
    parser.add_argument("--sessions-dir", type=Path,
                        default=Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "sessions")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    source = (DemoSource() if args.demo else EventSource(args.events) if args.events else
              SessionSource(args.sessions_dir, session_id=args.session))
    state = SidebarState(args.details_agent)
    names = SessionNames(args.sessions_dir.parent / "session_index.jsonl") if isinstance(source, SessionSource) else None
    running = True

    def stop(_signal, _frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    try:
        while running:
            source.poll(state)
            if names:
                names.poll()
            if args.once:
                while source.backlog:
                    source.poll(state)
            if args.details_agent:
                while source.backlog:
                    source.poll(state)
                data = {"agent_id": args.details_agent, "public_process": list(state.public_process),
                        "result": state.result, "result_truncated": state.result_truncated,
                        "demo": isinstance(source, DemoSource)}
                if data["demo"] and args.details_agent in state.agents:
                    data["public_process"] = [{"clock": "演示", "text": "模拟过程：读取代码、分析调用点并验证改动。", "truncated": False}]
                    data["result"] = "模拟结果：已完成 4 个调用点的梳理。" if state.agents[args.details_agent].status == "done" else ""
                print(json.dumps(data, ensure_ascii=False, separators=(",", ":")), flush=True)
                break
            print(json.dumps(desktop_snapshot(state, source, names), ensure_ascii=False, separators=(",", ":")), flush=True)
            if args.once:
                break
            time.sleep(0.15 if source.backlog else 1.5)
    except (BrokenPipeError, KeyboardInterrupt):
        pass


if __name__ == "__main__":
    main()
