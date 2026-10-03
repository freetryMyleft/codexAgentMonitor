"""Sidebar-only event history and titles; leaves the terminal parser unchanged."""

from collections import deque
from datetime import datetime, timezone
from pathlib import Path

from agent_monitor import FileTail, MonitorState, clean, event_clock


def event_order(event):
    try:
        value = datetime.fromisoformat(event['timestamp'].replace('Z', '+00:00'))
        return value.replace(tzinfo=timezone.utc).timestamp() if value.tzinfo is None else value.timestamp()
    except (ValueError, OverflowError, OSError):
        return 0


class SidebarState(MonitorState):
    def __init__(self, details_agent=None):
        self.details_agent = details_agent or getattr(self, 'details_agent', None)
        super().__init__()
        self.flows = deque(maxlen=100)
        self.histories = {}
        self.event_counts = {}
        self.public_process = deque(maxlen=20)
        self.result = ''
        self.result_truncated = False

    def record_event(self, agent, message, timestamp, phase):
        recorded_at = clean(timestamp) or datetime.now(timezone.utc).isoformat()
        if phase == 'return':
            agent.returned_at = recorded_at
        elif phase in {'start', 'review'} and agent.status == 'running':
            agent.returned_at = ''
        event = {'agent_id': agent.id, 'parent_id': agent.parent_id, 'name': agent.label,
                 'phase': phase, 'detail': clean(message), 'timestamp': recorded_at,
                 'clock': event_clock(timestamp)}
        # Sort before limiting: session files can be replayed in any order.
        self.flows = deque(sorted([*self.flows, event], key=event_order)[-100:], maxlen=100)
        self.histories.setdefault(agent.id, deque(maxlen=300)).append(event)
        self.event_counts[agent.id] = self.event_counts.get(agent.id, 0) + 1

    def log(self, agent, message, timestamp):
        super().log(agent, message, timestamp)
        phase = ('dispatch' if message == 'session discovered' and agent.parent_id else
                 'start' if message == 'task_started' else
                 'return' if message in {'task_complete', 'task_completed'} and agent.parent_id else
                 'complete' if message in {'task_complete', 'task_completed'} else
                 'interrupt' if message == 'turn_aborted' else
                 'review' if message.startswith('advice') else
                 'decision' if message.startswith('fork') else
                 'tool' if message.startswith(('→', 'tool:')) else 'event')
        if phase == 'tool' and any(t in message for t in ('spawn_agent', 'send_message', 'followup_task')):
            phase = 'dispatch'
        elif phase == 'tool' and any(t in message for t in ('wait_agent', 'wait_threads')):
            phase = 'wait'
        if phase == 'event' and agent.status == 'done':
            phase = 'return' if agent.parent_id else 'complete'
        if phase == 'start' and agent.role.endswith('reviewer'):
            phase = 'review'
        self.record_event(agent, message, timestamp, phase)

    def consume(self, record, default_id):
        kind = record.get('type') if isinstance(record, dict) else None
        normalized = {'agent', 'status', 'usage', 'tool', 'fork', 'advice', 'log'}
        payload = record if isinstance(record, dict) and kind in normalized else record.get('payload', {}) if isinstance(record, dict) else {}
        identity = payload.get('agent_id', default_id) if isinstance(payload, dict) else default_id
        if not isinstance(identity, str) or not identity:
            super().consume(record, default_id)
            return
        old = self.agents.get(identity)
        previous_status = old.status if old else None
        previous_activity = old.activity if old else None
        call_id = payload.get('call_id') if isinstance(payload.get('call_id'), str) else None
        tool = old.pending.get(call_id, '未知工具') if old and call_id else '未知工具'
        super().consume(record, default_id)
        agent = self.agents.get(identity)
        if not agent or not isinstance(payload, dict):
            return
        timestamp = record.get('timestamp')
        if agent.status == 'running' and previous_status != 'running':
            agent.returned_at = ''
        if kind == 'status' and payload.get('status') == 'running':
            agent.returned_at = ''
        item_type = payload.get('type')
        if not isinstance(item_type, str):
            return
        if kind == 'response_item' and item_type in {'function_call_output', 'custom_tool_call_output'}:
            self.record_event(agent, '工具完成 · ' + tool + '（未判定成功或失败）', timestamp, 'tool_result')
        elif kind == 'response_item' and item_type == 'reasoning' and previous_activity != 'thinking':
            self.record_event(agent, '正在推理（不展示内部思维正文）', timestamp, 'thinking')
        elif ((kind == 'response_item' and payload.get('type') == 'message' and payload.get('role') == 'assistant' and payload.get('channel') == 'final') or
              (kind == 'event_msg' and payload.get('type') == 'agent_message' and payload.get('phase') == 'final_answer')):
            self.log(agent, 'task_complete', timestamp)
        if agent.id == self.details_agent:
            self.capture_public(kind, payload, timestamp)

    def capture_public(self, kind, payload, timestamp):
        # Only public commentary and final answers, never reasoning/analysis items.
        channel = payload.get('channel') if kind == 'response_item' and payload.get('type') == 'message' and payload.get('role') == 'assistant' else None
        if kind == 'event_msg' and payload.get('type') == 'agent_message':
            channel = {'final_answer': 'final', 'commentary': 'commentary'}.get(payload.get('phase')) if isinstance(payload.get('phase'), str) else None
        if not isinstance(channel, str) or channel not in {'final', 'commentary'}:
            return
        content = payload.get('content', payload.get('message', ''))
        if isinstance(content, list):
            content = '\n'.join(item['text'] for item in content if isinstance(item, dict) and item.get('type') in ('output_text', 'text') and isinstance(item.get('text'), str))
        if not isinstance(content, str):
            return
        text = '\n'.join(clean(line) for line in content.splitlines())
        if channel == 'final':
            self.result, self.result_truncated = text[:12000], len(text) > 12000
        elif text:
            self.public_process.append({'text': text[:2000], 'truncated': len(text) > 2000, 'clock': event_clock(timestamp)})


class SessionNames:
    def __init__(self, path: Path):
        self.tail = FileTail(path)
        self.names = {}

    def poll(self):
        records = self.tail.read()
        if self.tail.reset:
            self.names.clear()
        for record in records:
            identity, title = record.get('id'), record.get('thread_name')
            if isinstance(identity, str) and isinstance(title, str):
                self.names[identity] = clean(title)[:512]

    def get(self, identity):
        return self.names.get(identity, '')
