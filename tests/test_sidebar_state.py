import json
from pathlib import Path
import tempfile
import unittest

from sidebar_state import SidebarState, SessionNames
from desktop_bridge import desktop_snapshot
from agent_monitor import DemoSource


class SidebarTests(unittest.TestCase):
    def state(self):
        state = SidebarState()
        state.consume({'type': 'agent', 'agent_id': 'root'}, 'root')
        state.consume({'type': 'agent', 'agent_id': 'child', 'parent_id': 'root'}, 'child')
        return state

    def test_completion_history_survives_global_event_eviction(self):
        state = self.state()
        state.consume({'type': 'event_msg', 'payload': {'type': 'task_complete'}}, 'child')
        for _ in range(110):
            state.consume({'type': 'tool', 'name': 'read', 'agent_id': 'root'}, 'root')
        self.assertTrue(state.agents['child'].returned_at)
        self.assertTrue(any(e['phase'] == 'return' for e in state.histories['child']))
        state.consume({'type': 'event_msg', 'payload': {'type': 'task_started'}}, 'child')
        self.assertEqual(state.agents['child'].returned_at, '')

    def test_tool_result_records_summary_without_result_body(self):
        state = self.state()
        for payload in [{'type': 'function_call', 'name': 'exec', 'call_id': 'a', 'arguments': 'SECRET'},
                        {'type': 'function_call_output', 'call_id': 'a', 'output': 'SECRET RESULT'},
                        {'type': 'message', 'role': 'assistant', 'channel': 'final', 'content': 'SECRET ANSWER'}]:
            state.consume({'type': 'response_item', 'payload': payload}, 'child')
        source = DemoSource()
        data = desktop_snapshot(state, source)
        child = next(a for a in data['agents'] if a['id'] == 'child')
        self.assertEqual([e['phase'] for e in child['events']], ['dispatch', 'tool', 'tool_result', 'return'])
        self.assertNotIn('SECRET', json.dumps(data))

    def test_session_names_follow_renames_and_truncation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'session_index.jsonl'
            path.write_text(json.dumps({'id': 'root', 'thread_name': '监控脚本'}) + '\n')
            names = SessionNames(path)
            names.poll()
            self.assertEqual(names.get('root'), '监控脚本')
            with path.open('a') as stream:
                stream.write(json.dumps({'id': 'root', 'thread_name': '新标题'}) + '\n')
            names.poll()
            self.assertEqual(names.get('root'), '新标题')
            path.write_text('{}\n')
            names.poll()
            self.assertEqual(names.get('root'), '')

    def test_node_history_is_bounded_and_reports_truncation(self):
        state = self.state()
        for _ in range(310):
            state.consume({'type': 'tool', 'name': 'read', 'agent_id': 'child'}, 'child')
        data = desktop_snapshot(state, DemoSource())
        child = next(a for a in data['agents'] if a['id'] == 'child')
        self.assertEqual(len(child['events']), 300)
        self.assertGreater(child['event_count'], 300)

    def test_malformed_item_type_does_not_crash_and_attribution_uses_agent_id(self):
        state = self.state()
        state.consume({'type': 'response_item', 'payload': {'type': [], 'agent_id': 'child'}}, 'root')
        state.consume({'type': 'response_item', 'payload': {'type': 'function_call', 'agent_id': 'child', 'name': 'read', 'call_id': 'x'}}, 'root')
        state.consume({'type': 'response_item', 'payload': {'type': 'function_call_output', 'agent_id': 'child', 'call_id': 'x'}}, 'root')
        self.assertEqual(state.histories['child'][-1]['detail'], '工具完成 · read（未判定成功或失败）')

    def test_running_again_clears_prior_return(self):
        state = self.state()
        state.consume({'type': 'event_msg', 'payload': {'type': 'task_complete'}}, 'child')
        self.assertTrue(state.agents['child'].returned_at)
        state.consume({'type': 'status', 'agent_id': 'child', 'status': 'running'}, 'root')
        self.assertEqual(state.agents['child'].returned_at, '')
