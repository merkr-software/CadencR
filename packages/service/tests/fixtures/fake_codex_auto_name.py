#!/usr/bin/env python3
"""Minimal Codex app-server fixture for concurrent naming and prompt delivery."""

import json
from pathlib import Path
from runpy import run_path
import sys
import uuid

if '--version' in sys.argv:
    print('codex-cli 0.154.0')
    sys.exit(0)

fixture_dir = Path(__file__).resolve().parent
pause_at = run_path(str(fixture_dir / 'provider_gate.py'))['pause_at']
thread_id = str(uuid.uuid4())
thread_cwd = None
servers = []


def emit(value):
    print(json.dumps(value), flush=True)


def notify(method, **params):
    emit({'method': method, 'params': {'threadId': thread_id, **params}})


for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request:
        continue
    method, params = request['method'], request.get('params', {})
    result = {}
    if method == 'initialize':
        result = {'userAgent': 'codex-cli/0.154.0'}
    elif method == 'config/read':
        result = {'config': {'model': 'qa-model', 'model_reasoning_effort': 'low'}}
    elif method == 'model/list':
        result = {'data': [{'id': 'qa-model', 'model': 'qa-model', 'displayName': 'QA',
                            'isDefault': True, 'supportedReasoningEfforts': [],
                            'defaultReasoningEffort': 'low'}], 'nextCursor': None}
    elif method in ('thread/start', 'thread/resume', 'thread/read'):
        thread_id = params.get('threadId', thread_id)
        thread_cwd = params.get('cwd', thread_cwd)
        result = {'thread': {'id': thread_id, 'turns': []}}
        if method == 'thread/start':
            servers = list(params.get('config', {}).get('mcp_servers', {}))
            for server in servers:
                notify('mcpServer/startupStatus/updated', name=server, status='ready')
    elif method == 'mcpServerStatus/list':
        result = {'data': [{'name': server, 'authStatus': 'unsupported', 'tools': []}
                           for server in servers], 'nextCursor': None}
    elif method in ('skills/list', 'thread/list'):
        result = {'data': [], 'nextCursor': None}
    elif method == 'turn/start':
        text = ' '.join(item.get('text', '') for item in params['input'])
        naming = text.startswith("Now name this session. User's first message:")
        with (fixture_dir / 'turns.jsonl').open('a', encoding='utf-8') as log:
            log.write(json.dumps({'kind': 'naming' if naming else 'prompt',
                                  'cwd': thread_cwd}) + '\n')

        turn_id = str(uuid.uuid4())
        turn = {'id': turn_id, 'items': []}
        emit({'id': request['id'], 'result': {'turn': turn}})
        notify('turn/started', turn={**turn, 'status': 'inProgress'})
        if naming:
            pause_at('naming-result')
            answer = '__FEATURE_NAME_START__Check Login Flow__FEATURE_NAME_END__'
        else:
            notify('item/completed', turnId=turn_id,
                   item={'type': 'userMessage', 'id': turn_id + '-user',
                         'clientUserMessageId': params.get('clientUserMessageId'),
                         'content': params['input']})
            answer = 'PONG'
        notify('item/agentMessage/delta', turnId=turn_id, itemId=turn_id + '-reply', delta=answer)
        notify('turn/completed', turn={**turn, 'status': 'completed'})
        continue
    emit({'id': request['id'], 'result': result})
