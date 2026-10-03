"""Regression tests use synthetic logs, never the user's session contents."""

import json
import contextlib
import io
import signal
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_monitor import Dashboard, DemoSource, EventSource, FileTail, MonitorState, SessionSource, cell_width, main


def record(kind, payload):
    return {"timestamp": "2026-10-03T06:00:00Z", "type": kind, "payload": payload}


def meta(agent_id, parent=None):
    return record("session_meta", {"id": agent_id, "parent_thread_id": parent,
                                  "cwd": "/demo", "agent_role": "worker" if parent else "main"})


class StateTests(unittest.TestCase):
    def setUp(self):
        self.state = MonitorState()
        self.state.consume(meta("main"), "main")

    def test_cumulative_tokens_are_not_added_or_doubled_between_formats(self):
        usage = {"input_tokens": 100, "cached_input_tokens": 40,
                 "output_tokens": 20, "total_tokens": 120}
        self.state.consume(record("token_usage_record", {"thread_token_usage": usage}), "main")
        for _ in range(3):
            self.state.consume(record("event_msg", {"type": "token_count", "info": {
                "total_token_usage": usage, "last_token_usage": usage,
                "model_context_window": 200}}), "main")
        agent = self.state.agents["main"]
        self.assertEqual(agent.total_tokens, 120)
        self.assertEqual(agent.cached_tokens, 40)
        self.assertEqual(agent.context_tokens, 120)

    def test_usage_unknown_differs_from_zero(self):
        self.assertIsNone(self.state.agents["main"].total_tokens)
        self.state.consume({"type": "usage", "agent_id": "main", "input_tokens": 0,
                            "output_tokens": 0}, "main")
        self.assertEqual(self.state.agents["main"].total_tokens, 0)

    def test_turn_lifecycle_and_model_settings(self):
        self.state.consume(record("turn_context", {"model": "test-model", "effort": "high"}), "main")
        self.state.consume(record("event_msg", {"type": "task_started"}), "main")
        self.assertEqual(self.state.agents["main"].status, "running")
        self.state.consume(record("event_msg", {"type": "task_complete"}), "main")
        self.assertEqual(self.state.agents["main"].status, "done")
        self.state.consume(record("event_msg", {"type": "task_started"}), "main")
        self.state.consume(record("event_msg", {"type": "turn_aborted"}), "main")
        self.assertEqual(self.state.agents["main"].status, "interrupted")
        self.state.consume(record("event_msg", {"type": "thread_settings_applied",
            "thread_settings": {"model": "new-model", "reasoning_effort": "medium"}}), "main")
        self.assertEqual(self.state.agents["main"].model, "new-model")
        self.assertEqual(self.state.agents["main"].effort, "medium")

    def test_function_and_custom_tools_and_final_message(self):
        self.state.consume(record("response_item", {"type": "function_call", "name": "exec_command",
                                                    "call_id": "call-1"}), "main")
        self.assertEqual(self.state.agents["main"].activity, "tool: exec_command")
        self.state.consume(record("response_item", {"type": "function_call_output",
                                                    "call_id": "call-1"}), "main")
        self.assertEqual(self.state.agents["main"].activity, "working")
        self.state.consume(record("response_item", {"type": "custom_tool_call", "name": "apply_patch",
                                                    "call_id": "call-2"}), "main")
        self.assertEqual(self.state.agents["main"].tool_calls, 2)
        self.state.consume(record("response_item", {"type": "message", "role": "assistant",
                                                    "channel": "final"}), "main")
        self.assertEqual(self.state.agents["main"].status, "done")

    def test_parent_hierarchy_with_child_arriving_first(self):
        state = MonitorState()
        state.consume(meta("child", "root"), "child")
        state.consume(meta("root"), "root")
        self.assertEqual(state.agents["child"].parent_id, "root")
        self.assertEqual([a.id for a in state.children("root")], ["child"])

    def test_normalized_events_preserve_fork_advice_and_error(self):
        for e in [
            {"type": "agent", "agent_id": "astra", "parent_id": "main", "role": "architect",
             "name": "ASTRA", "model": "review-model"},
            {"type": "fork", "agent_id": "main", "label": "which tool", "confidence": 0.47,
             "route": "split", "forks": 1656},
            {"type": "advice", "agent_id": "astra", "message": "run migration"},
            {"type": "status", "agent_id": "astra", "status": "error", "message": "repeat error"},
        ]:
            self.state.consume(e, "main")
        self.assertEqual(self.state.forks, 1656)
        self.assertEqual(self.state.decisions[-1]["route"], "split")
        self.assertEqual(self.state.agents["astra"].advice, "run migration")
        self.assertEqual(self.state.agents["astra"].status, "error")

    def test_bad_shapes_and_unknown_events_do_not_crash(self):
        for data in [None, [], 4, {}, {"type": "event_msg", "payload": None},
                     record("token_usage_record", {"thread_token_usage": "bad"}),
                     {"type": "usage", "agent_id": [], "input_tokens": "bad"},
                     {"type": "fork", "confidence": "bad", "forks": -8},
                     {"type": "agent", "status": []},
                     record("event_msg", {"type": []}),
                     record("response_item", {"type": []}),
                     {"type": "usage", "input_tokens": 10**400},
                     {"type": "fork", "confidence": 10**400}]:
            self.state.consume(data, "main")
        self.assertIsNone(self.state.agents["main"].total_tokens)

    def test_spawn_source_metadata_and_missing_token_info(self):
        self.state.consume(record("session_meta", {"id": "child", "source": {"subagent": {
            "thread_spawn": {"parent_thread_id": "main", "agent_role": "explorer", "agent_nickname": "Scout"}}}}), "child")
        self.assertEqual(self.state.agents["child"].label, "Scout")
        self.assertEqual(self.state.agents["child"].parent_id, "main")
        self.state.consume(record("event_msg", {"type": "token_count", "info": None}), "main")
        self.assertIsNone(self.state.agents["main"].total_tokens)

    def test_partial_updates_preserve_name_and_role_and_extreme_time_falls_back(self):
        self.state.consume({"type": "agent", "agent_id": "astra", "name": "ASTRA", "role": "architect",
                            "parent_id": "main"}, "main")
        self.state.consume({"type": "agent", "agent_id": "astra", "model": "new-model"}, "main")
        agent = self.state.agents["astra"]
        self.assertEqual((agent.name, agent.role, agent.parent_id), ("ASTRA", "architect", "main"))
        self.state.consume({"type": "log", "agent_id": "main", "message": "safe",
                            "timestamp": "0001-01-01T00:00:00+23:59"}, "main")
        self.assertEqual(self.state.logs[-1][2], "safe")

    def test_parallel_calls_keep_pending_activity_until_all_finish(self):
        for call_id in ["a", "b"]:
            self.state.consume(record("response_item", {"type": "function_call", "name": call_id,
                                                       "call_id": call_id}), "main")
        self.state.consume(record("response_item", {"type": "function_call_output", "call_id": "a"}), "main")
        self.assertEqual(self.state.agents["main"].activity, "tool: b")
        self.state.consume(record("response_item", {"type": "function_call_output", "call_id": "b"}), "main")
        self.assertEqual(self.state.agents["main"].activity, "working")


class TailTests(unittest.TestCase):
    def test_missing_file_is_reported_and_later_creation_recovers(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "missing.jsonl"
            tail = FileTail(p)
            self.assertEqual(tail.read(), [])
            self.assertTrue(tail.error)
            p.write_text('{}\n')
            self.assertEqual(tail.read(), [{}])
            self.assertEqual(tail.error, "")

    def test_oversized_line_is_skipped_without_losing_next_record(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "events.jsonl"
            p.write_bytes(b'x' * 103 + b'\n{}\n')
            tail = FileTail(p, chunk_size=30)
            output = []
            with patch("agent_monitor.MAX_LINE", 100):
                for _ in range(6):
                    output.extend(tail.read())
            self.assertEqual(output, [{}])
            self.assertEqual(tail.bad_lines, 1)

    def test_event_source_reset_and_invalid_line_warning(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "events.jsonl"
            p.write_text('{"type":"tool","agent_id":"root","name":"call"}\ninvalid\n')
            source = EventSource(p)
            state = MonitorState()
            source.poll(state)
            self.assertEqual(state.agents["root"].tool_calls, 1)
            self.assertIn("invalid", source.warning)
            replacement = Path(d) / "replacement"
            replacement.write_text('{"type":"agent","agent_id":"new"}\n')
            replacement.replace(p)
            source.poll(state)
            self.assertEqual(set(state.agents), {"new"})

    def test_partial_line_and_invalid_json_then_append(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "events.jsonl"
            p.write_bytes(b'{"type":"status","agent_id":"root",')
            tail = FileTail(p)
            self.assertEqual(tail.read(), [])
            with p.open("ab") as f:
                f.write(b'"status":"running"}\nnot-json\n{}\n')
            self.assertEqual(len(tail.read()), 2)
            self.assertEqual(tail.bad_lines, 1)
            self.assertEqual(tail.read(), [])

    def test_truncation_and_replacement_restart_reader(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "events.jsonl"
            p.write_text('{"message":"long initial record"}\n')
            tail = FileTail(p)
            tail.read()
            p.write_text('{}\n')
            self.assertEqual(tail.read(), [{}])
            self.assertTrue(tail.reset)
            replacement = Path(d) / "new.jsonl"
            replacement.write_text('{"new":true}\n')
            replacement.replace(p)
            self.assertEqual(tail.read(), [{"new": True}])
            self.assertTrue(tail.reset)

    def test_byte_budget_and_partial_utf8(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "events.jsonl"
            raw = json.dumps({"message": "中文"}, ensure_ascii=False).encode() + b'\n'
            p.write_bytes(raw)
            tail = FileTail(p, chunk_size=5)
            output = []
            for _ in range(20):
                output.extend(tail.read())
            self.assertEqual(output, [{"message": "中文"}])


class SourceTests(unittest.TestCase):
    def write_session(self, path, events):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(e) + "\n" for e in events))

    def test_selects_root_and_recursive_descendants_not_unrelated_sessions(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            self.write_session(root / "a.jsonl", [meta("root")])
            self.write_session(root / "b.jsonl", [meta("child", "root")])
            self.write_session(root / "c.jsonl", [meta("grandchild", "child")])
            self.write_session(root / "d.jsonl", [meta("unrelated")])
            source = SessionSource(root, session_id="root")
            state = MonitorState()
            source.poll(state)
            self.assertEqual(set(state.agents), {"root", "child", "grandchild"})
            self.assertEqual(state.root_id, "root")

    def test_late_child_and_usage_update_are_discovered(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            self.write_session(root / "a.jsonl", [meta("root")])
            source = SessionSource(root, session_id="root", scan_interval=0)
            state = MonitorState()
            source.poll(state)
            self.write_session(root / "child.jsonl", [meta("child", "root")])
            source.poll(state)
            self.assertIn("child", state.agents)
            with (root / "a.jsonl").open("a") as f:
                f.write(json.dumps(record("event_msg", {"type": "task_complete"})) + "\n")
            source.poll(state)
            self.assertEqual(state.agents["root"].status, "done")

    def test_pinned_child_is_supported_and_missing_session_reports_waiting(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            self.write_session(root / "a.jsonl", [meta("child", "outside")])
            state = MonitorState()
            SessionSource(root, session_id="child").poll(state)
            self.assertEqual(state.root_id, "child")
            waiting = SessionSource(root, session_id="missing")
            waiting.poll(MonitorState())
            self.assertIn("missing", waiting.description)

    def test_prefix_ambiguity_cwd_filter_and_fixed_selection(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            self.write_session(root / "a.jsonl", [meta("root-a")])
            self.write_session(root / "b.jsonl", [meta("root-b")])
            ambiguous = SessionSource(root, session_id="root")
            state = MonitorState()
            ambiguous.poll(state)
            self.assertIn("ambiguous", ambiguous.description)
            self.assertFalse(state.agents)
            source = SessionSource(root, cwd="/demo", scan_interval=0)
            source.poll(state)
            selected = state.root_id
            self.write_session(root / "c.jsonl", [meta("root-c")])
            source.poll(state)
            self.assertEqual(state.root_id, selected)
            self.assertNotIn("root-c", state.agents)

    def test_replaced_session_rebuilds_counts_and_missing_directory_warns(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            path = root / "a.jsonl"
            call = record("response_item", {"type": "function_call", "name": "test"})
            self.write_session(path, [meta("root"), call, call])
            source = SessionSource(root, scan_interval=0)
            state = MonitorState()
            source.poll(state)
            self.assertEqual(state.agents["root"].tool_calls, 2)
            replacement = root / "replacement"
            self.write_session(replacement, [meta("root"), call])
            replacement.replace(path)
            source.poll(state)
            self.assertEqual(state.agents["root"].tool_calls, 1)
            missing = SessionSource(root / "missing")
            missing.poll(MonitorState())
            self.assertIn("does not exist", missing.warning)


class RenderTests(unittest.TestCase):
    def test_unicode_width_and_control_characters(self):
        self.assertEqual(cell_width("中文abc"), 7)
        state = MonitorState()
        state.consume({"type": "agent", "agent_id": "root", "name": "bad\x1b[2J\n中文",
                       "status": "running"}, "root")
        state.root_id = "root"
        rendered = Dashboard().render(state, 110, 36, "source\x1b]0;title\x07")
        self.assertNotIn("\x1b", rendered)
        self.assertNotIn("\x07", rendered)
        self.assertTrue(all(cell_width(line) <= 110 for line in rendered.splitlines()))

    def test_wide_and_narrow_and_tiny_layouts_keep_status(self):
        state = MonitorState()
        state.consume(meta("root"), "root")
        state.root_id = "root"
        for i in range(12):
            state.consume(meta(f"child-{i}", "root"), f"child-{i}")
        for width, height in [(140, 42), (80, 24), (40, 12), (12, 3)]:
            rendered = Dashboard().render(state, width, height, "fixture")
            self.assertLessEqual(len(rendered.splitlines()), height)
            self.assertTrue(all(cell_width(line) <= width for line in rendered.splitlines()))
        wide = Dashboard().render(state, 140, 42, "fixture")
        self.assertIn("child-11", wide)

    def test_cycles_cannot_hang_renderer(self):
        state = MonitorState()
        for agent_id, parent in [("a", "b"), ("b", "a")]:
            state.consume({"type": "agent", "agent_id": agent_id, "parent_id": parent}, agent_id)
        state.root_id = "a"
        self.assertTrue(Dashboard().render(state, 100, 30, "fixture"))


class CLITests(unittest.TestCase):
    def run_cli(self, argv):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(main(argv), 0)
        return output.getvalue()

    def test_demo_json_and_plain_snapshot(self):
        snapshot = json.loads(self.run_cli(["--demo", "--json"]))
        self.assertEqual(snapshot["root_id"], "sol")
        self.assertEqual(len(snapshot["agents"]), 5)
        self.assertNotIn("pending", snapshot["agents"][0])
        frame = self.run_cli(["--demo", "--once", "--width", "120", "--height", "39"])
        self.assertIn("DEMO", frame)
        self.assertIn("researcher", frame)
        self.assertIn("BACK TO MAIN", frame)
        self.assertIn("FORK LAYER", frame)
        self.assertIn("ARCHITECT", frame)
        self.assertNotIn("\x1b", frame)

    def test_event_file_and_list_and_no_session(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            p = root / "events.jsonl"
            p.write_text('{"type":"agent","agent_id":"root","name":"Fixture"}\n')
            frame = self.run_cli(["--events", str(p), "--once"])
            self.assertIn("Fixture", frame)
            session = root / "session.jsonl"
            session.write_text(json.dumps(meta("session-id")) + "\n")
            listing = self.run_cli(["--sessions-dir", d, "--list"])
            self.assertIn("session-id", listing)
            no_sessions = self.run_cli(["--sessions-dir", str(root / "missing"), "--once"])
            self.assertIn("Waiting", no_sessions)
            self.assertIn("NOTICE", no_sessions)

    def test_keyboard_interrupt_and_sigterm_restore_terminal(self):
        class Terminal(io.StringIO):
            def isatty(self):
                return True

        for exit_method in ["keyboard", "signal"]:
            output = Terminal()
            def stop(_interval):
                if exit_method == "keyboard":
                    raise KeyboardInterrupt
                signal.raise_signal(signal.SIGTERM)
            with contextlib.redirect_stdout(output), patch("agent_monitor.time.sleep", side_effect=stop):
                self.assertEqual(main(["--demo", "--width", "120", "--height", "40"]), 0)
            frame = output.getvalue()
            self.assertTrue(frame.startswith("\x1b[?1049h\x1b[?25l"))
            self.assertTrue(frame.endswith("\x1b[0m\x1b[?25h\x1b[?1049l"))

    def test_demo_updates_and_cli_rejects_invalid_options(self):
        source = DemoSource()
        state = MonitorState()
        source.poll(state)
        initial = state.agents["worker"].total_tokens
        for _ in range(6):
            source.poll(state)
        self.assertGreater(state.agents["worker"].total_tokens, initial)
        for argv in [["--interval", "nan"], ["--width", "0"], ["--list", "--demo"]]:
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
                main(argv)
            self.assertEqual(caught.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
