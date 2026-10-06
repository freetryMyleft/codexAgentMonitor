import json
import importlib
from pathlib import Path
import sys
import tempfile
import unittest

from sidebar_state import SidebarState, SessionNames
from desktop_bridge import desktop_snapshot
from agent_monitor import DemoSource

_plugin_backend = Path(__file__).resolve().parents[1] / 'plugins' / 'agent-monitor' / 'backend'
sys.path.insert(0, str(_plugin_backend))
try:
    SessionCatalog = importlib.import_module('session_catalog').SessionCatalog
except (ImportError, AttributeError):
    SessionCatalog = None
finally:
    sys.path.remove(str(_plugin_backend))


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

    def test_catalog_pages_all_sessions_including_children_without_log_bodies(self):
        self.assertIsNotNone(SessionCatalog, 'the independent session catalog should be available')
        with tempfile.TemporaryDirectory() as directory:
            sessions = Path(directory) / 'sessions'
            sessions.mkdir()
            names = Path(directory) / 'session_index.jsonl'
            names.write_text(json.dumps({'id': 'root-00', 'thread_name': 'Catalog title'}) + '\n')
            for index in range(26):
                session_id = f'root-{index:02d}'
                parent = 'root-00' if index >= 24 else None
                records = [{'type': 'session_meta', 'payload': {'id': session_id, 'parent_thread_id': parent,
                           'cwd': f'/project-{index % 2}'}, 'timestamp': '2026-10-04T01:00:00Z'}]
                if index == 1:
                    records.extend([
                        {'type': 'event_msg', 'payload': {'type': 'task_started'}, 'timestamp': '2026-10-04T01:01:00Z'},
                        {'type': 'log', 'payload': {'message': 'later note'}, 'timestamp': '2026-10-04T01:09:00Z'},
                    ])
                if index == 2:
                    records.append({'type': 'response_item', 'payload': {'type': 'message', 'content': 'PRIVATE LOG BODY'}})
                (sessions / f'{session_id}.jsonl').write_text(''.join(json.dumps(record) + '\n' for record in records))
            catalog = SessionCatalog(sessions, names)
            first = catalog.page(offset=0, limit=17, refresh=True)
            second = catalog.page(offset=first['next_offset'], limit=17, revision=first['revision'])
            all_sessions = first['sessions'] + second['sessions']
            self.assertEqual(first['total'], 26)
            self.assertEqual(len(all_sessions), 26)
            self.assertEqual(first['sessions'][0]['id'], 'root-00')
            self.assertEqual(next(item for item in all_sessions if item['id'] == 'root-00')['title'], 'Catalog title')
            self.assertEqual(next(item for item in all_sessions if item['id'] == 'root-24')['parent_id'], 'root-00')
            active = next(item for item in all_sessions if item['id'] == 'root-01')
            self.assertEqual(active['status'], 'running')
            self.assertEqual(active['status_at'], '2026-10-04T01:01:00Z')
            self.assertEqual(active['updated_at'], '2026-10-04T01:09:00Z')
            unknown = next(item for item in all_sessions if item['id'] == 'root-03')
            self.assertEqual(unknown['status'], 'unknown')
            self.assertEqual(unknown['status_at'], '')
            self.assertNotIn('PRIVATE LOG BODY', json.dumps(all_sessions))

    def test_catalog_rejects_stale_page_revision_after_refresh(self):
        self.assertIsNotNone(SessionCatalog, 'the independent session catalog should be available')
        with tempfile.TemporaryDirectory() as directory:
            sessions = Path(directory) / 'sessions'
            sessions.mkdir()
            (sessions / 'first.jsonl').write_text(json.dumps({'type': 'session_meta', 'payload': {'id': 'first'}}) + '\n')
            catalog = SessionCatalog(sessions)
            page = catalog.page(offset=0, limit=1, refresh=True)
            (sessions / 'second.jsonl').write_text(json.dumps({'type': 'session_meta', 'payload': {'id': 'second'}}) + '\n')
            refreshed = catalog.page(offset=0, limit=1, refresh=True)
            self.assertNotEqual(page['revision'], refreshed['revision'])
            with self.assertRaisesRegex(ValueError, '目录已更新'):
                catalog.page(offset=1, limit=1, revision=page['revision'])

    def test_catalog_invalid_unicode_does_not_hide_valid_sessions(self):
        with tempfile.TemporaryDirectory() as directory:
            sessions = Path(directory) / 'sessions'
            sessions.mkdir()
            for session_id, parent in [('valid', None), ('malformed', '\ud800')]:
                records = [
                    {'type': 'session_meta', 'payload': {'id': session_id, 'parent_thread_id': parent}},
                    {'type': 'status', 'status': 'running', 'timestamp': '\ud800'},
                ]
                (sessions / f'{session_id}.jsonl').write_text(''.join(json.dumps(record) + '\n' for record in records))
            page = SessionCatalog(sessions).page(refresh=True)
            self.assertEqual(page['total'], 2)
            json.dumps(page, ensure_ascii=False).encode('utf-8')

    def test_catalog_explicit_unknown_clears_running_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            sessions = Path(directory)
            records = [
                {'type': 'session_meta', 'payload': {'id': 'root'}},
                {'type': 'status', 'status': 'running', 'timestamp': '2026-10-04T01:00:00Z'},
                {'type': 'status', 'status': 'unknown', 'timestamp': '2026-10-04T02:00:00Z'},
            ]
            (sessions / 'root.jsonl').write_text(''.join(json.dumps(record) + '\n' for record in records))
            row = SessionCatalog(sessions).page(refresh=True)['sessions'][0]
            self.assertEqual(row['status'], 'unknown')
            self.assertEqual(row['status_at'], '')
