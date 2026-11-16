#!/usr/bin/env python3
"""Codex queue/compaction contract fixture, without a model or user files."""
import json
import os
import sys
import threading
import time
import uuid

if '--version' in sys.argv:
    print('codex-cli 0.154.0')
    sys.exit()
lock = threading.Lock()
root = str(uuid.uuid4())
turn = None
compacting = False
servers = []


def emit(value):
    with lock:
        print(json.dumps(value), flush=True)


def notify(method, **params):
    emit({'method': method, 'params': params})


def finish(turn_id, text, delay):
    global turn, compacting
    time.sleep(delay)
    if text == 'compact':
        notify('item/completed', threadId=root, turnId=turn_id,
               item={'type': 'contextCompaction', 'id': turn_id + '-item'})
        time.sleep(0.1)  # The item finishes before the turn releases its writer.
    else:
        notify('item/agentMessage/delta', threadId=root, itemId=turn_id + '-reply', delta='DONE ' + text)
    if turn == turn_id:
        turn = None
        compacting = False
    notify('turn/completed', threadId=root, turn={'id': turn_id, 'status': 'completed', 'items': []})


for line in sys.stdin:
    msg = json.loads(line)
    if 'id' not in msg:
        continue
    method, params = msg['method'], msg.get('params', {})
    with open('queue-rpc.jsonl', 'a') as log:
        log.write(json.dumps({'method': method, 'params': params}) + '\n')
    result = {}
    if method == 'initialize':
        result = {'userAgent': 'codex-cli/0.154.0'}
    elif method == 'config/read':
        result = {'config': {'model': 'qa-model', 'model_reasoning_effort': 'low'}}
    elif method == 'model/list':
        result = {'data': [{'id': 'qa-model', 'model': 'qa-model', 'displayName': 'QA', 'isDefault': True,
                            'supportedReasoningEfforts': [], 'defaultReasoningEffort': 'low'}], 'nextCursor': None}
    elif method in ('thread/start', 'thread/resume'):
        if method == 'thread/resume':
            while os.path.exists('pause-resume'):
                time.sleep(0.01)
            if os.path.exists('fail-resume-once'):
                os.remove('fail-resume-once')
                emit({'id': msg['id'], 'error': {'code': -32600, 'message': 'RESUME_REJECTED'}})
                continue
        root = params.get('threadId', root)
        result = {'thread': {'id': root, 'turns': []}}
        servers = list(params.get('config', {}).get('mcp_servers', {}))
        for name in servers:
            notify('mcpServer/startupStatus/updated', name=name, status='ready')
    elif method == 'mcpServerStatus/list':
        result = {'data': [{'name': n, 'authStatus': 'unsupported', 'tools': {}} for n in servers], 'nextCursor': None}
    elif method == 'skills/list':
        result = {'data': []}
    elif method in ('turn/start', 'turn/steer', 'thread/compact/start'):
        text = 'compact' if method == 'thread/compact/start' else ' '.join(i.get('text', '') for i in params.get('input', []))
        if compacting or text == 'reject':
            emit({'id': msg['id'], 'error': {'code': -32600, 'message': 'cannot steer during compaction' if compacting else 'QUEUE_DELIVERY_REJECTED'}})
            continue
        if method == 'turn/steer':
            if turn is None:
                emit({'id': msg['id'], 'error': {'code': -32600, 'message': 'no active turn to steer'}})
                continue
            result = {'turnId': turn}
        else:
            turn = str(uuid.uuid4())
            compacting = text == 'compact'
            result = {} if compacting else {'turn': {'id': turn}}
            notify('turn/started', threadId=root, turn={'id': turn, 'status': 'inProgress', 'items': []})
        if compacting:
            notify('item/started', threadId=root, turnId=turn, item={'type': 'contextCompaction', 'id': turn + '-item'})
        else:
            notify('item/completed', threadId=root, turnId=turn, item={'type': 'userMessage', 'id': str(uuid.uuid4()),
                   'clientUserMessageId': params.get('clientUserMessageId'), 'content': [{'type': 'text', 'text': text}]})
        if method != 'turn/steer':
            threading.Thread(target=finish, args=(turn, text, 1.5 if text in ('compact', 'hold') else 0.15), daemon=True).start()
        if text == 'slow-ack':
            time.sleep(0.4)
        if compacting and os.path.exists('slow-compact-ack'):
            os.remove('slow-compact-ack')
            time.sleep(2.0)
    elif method == 'turn/interrupt':
        if turn:
            threading.Thread(target=finish, args=(turn, 'interrupted', 0), daemon=True).start()
    emit({'id': msg['id'], 'result': result})
