"""Regressions at state, HTTP and native transport boundaries; no Google traffic."""
import copy
import hashlib
import http.client
import io
import json
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import h2.config
import h2.connection
import h2.events

from gemini_native_bridge.config import RuntimeConfig
from gemini_native_bridge.contract import BridgeError, parse_request
from gemini_native_bridge.protocol import (MODEL_ID, MODE_ID, TASK_RPC, TOOLS_RPC, TURN_RPC,
    FrameReader, decode_struct, encode_varint, frame, one, optional, pb, struct_obj)
from gemini_native_bridge.server import BridgeHandler, BridgeServer
from gemini_native_bridge.state import Manager
from gemini_native_bridge.transport import NativeTask


class Transport:
    def __init__(self, config, request, sink):
        self.sink, self.stopped, self.results = sink, False, []
    def start(self): pass
    def stop(self): self.stopped = True
    def submit_result(self, call_id, value): self.results.append((call_id, value))


def request(messages=None):
    return parse_request({'model': MODEL_ID, 'messages': messages or [{'role': 'user', 'content': 'one'}],
        'tools': [{'type': 'function', 'function': {'name': 'read_fixture', 'parameters': {
            'type': 'object', 'properties': {'path': {'type': 'string'}}, 'required': ['path'],
            'additionalProperties': False}}}]})


class Boundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = RuntimeConfig(self.root, 'local-test-key-01234567890', 'instance', self.root/'auth',
            self.root/'binary', hashlib.sha256(b'fixture').hexdigest(), 'fixture', task_timeout=60)
        self.manager = Manager(self.config, Transport)
        self.addCleanup(self.manager.close)

    def begin(self, session='session'):
        req = request()
        ticket = self.manager.submit(session, req)
        return req, ticket, self.manager._active_transport

    def phase(self):
        req, ticket, transport = self.begin()
        call_id = transport.sink.tool('read_fixture', {'path': 'one'})
        message = ticket.result(1)['choices'][0]['message']
        continuation = request(req.messages + [message, {'role': 'tool', 'tool_call_id': call_id, 'content': 'one'}])
        return req, ticket, transport, continuation

    def test_close_cancel_persist_errors_before_ticket_and_survive_restart(self):
        for action, code in [('close', 'service_stopped'), ('cancel', 'cancelled')]:
            with self.subTest(action=action):
                req, ticket, transport = self.begin(action)
                real_set = ticket.event.set
                def published():
                    saved = json.loads(self.manager._snapshot_path(action).read_text())
                    self.assertEqual(saved['requests'][req.digest]['error']['code'], code)
                    real_set()
                ticket.event.set = published
                if action == 'close': self.manager.close()
                else: self.manager.cancel(action)
                with self.assertRaises(BridgeError) as error: ticket.result(1)
                self.assertEqual(error.exception.code, code)
                self.assertTrue(transport.stopped)
                self.manager.close()
                with self.assertRaises(BridgeError) as error: self.manager.submit('new', req)
                self.assertEqual(error.exception.code, 'service_stopped')
                self.manager = Manager(self.config, Transport)
                self.addCleanup(self.manager.close)
                with self.assertRaises(BridgeError) as error: self.manager.submit(action, req)
                self.assertEqual(error.exception.code, code)

    def test_invalid_parallel_empty_and_pending_completion(self):
        for scenario in ['invalid', 'parallel', 'empty', 'pending_complete']:
            req, ticket, transport = self.begin(scenario)
            if scenario in ['parallel', 'pending_complete']:
                transport.sink.tool('read_fixture', {'path': 'one'})
                first_response = ticket.result(1)
            if scenario == 'invalid':
                with self.assertRaises(BridgeError): transport.sink.tool('read_fixture', {'wrong': True})
            elif scenario == 'parallel':
                with self.assertRaises(BridgeError): transport.sink.tool('read_fixture', {'path': 'two'})
            elif scenario == 'empty': transport.sink.complete('')
            else: transport.sink.complete('two')
            self.assertEqual(self.manager.status(scenario)['status'], 'failed')
            self.assertTrue(transport.stopped)
            if scenario in ['parallel', 'pending_complete']:
                self.assertEqual(ticket.result(1), first_response)
                self.assertIsNone(ticket.error)
            else:
                with self.assertRaises(BridgeError): ticket.result(1)

    def test_inflight_busy_stale_delivery_and_completed_cache(self):
        req, ticket, transport, continuation = self.phase()
        with self.assertRaises(BridgeError) as error: self.manager.submit('another', request())
        self.assertEqual(error.exception.code, 'concurrency_limit')
        next_ticket = self.manager.submit('session', continuation)
        with self.assertRaises(BridgeError) as error: self.manager.submit('session', continuation)
        self.assertEqual(error.exception.code, 'request_in_progress')
        self.manager.abandon_delivery('session', ticket.task_id, req.digest)
        self.assertFalse(next_ticket.event.is_set())
        transport.sink.complete('one')
        final = next_ticket.result(1)
        self.assertEqual(self.manager.cancel('session')['status'], 'complete')
        self.manager.close()
        self.manager = Manager(self.config, Transport)
        self.addCleanup(self.manager.close)
        self.assertEqual(self.manager.submit('session', continuation).result(1), final)
        new_req = request(continuation.messages + [final['choices'][0]['message'], {'role': 'user', 'content': 'two'}])
        new_ticket = self.manager.submit('session', new_req)
        self.manager.abandon_delivery('session', ticket.task_id, continuation.digest)
        transport.sink.complete('stale')
        self.assertFalse(new_ticket.event.is_set())
        self.assertEqual(self.manager.status('session')['task_id'], new_ticket.task_id)

    def test_corruption_and_missing_active_journal_latch(self):
        req, ticket, transport = self.begin()
        self.manager._snapshot_path('session').unlink()
        with self.assertRaises(BridgeError) as error: self.manager.status('session')
        self.assertEqual(error.exception.code, 'state_corrupt')
        with self.assertRaises(BridgeError) as error: ticket.result(1)
        self.assertEqual(error.exception.code, 'state_corrupt')
        self.assertTrue(transport.stopped)
        with self.assertRaises(BridgeError) as error: self.manager.submit('new', request())
        self.assertEqual(error.exception.code, 'state_storage_failed')

    def test_malformed_snapshots_refuse_startup_without_transport(self):
        req, ticket, transport, continuation = self.phase()
        path = self.manager._snapshot_path('session')
        good = json.loads(path.read_text())
        self.manager.close()
        def mutation(name):
            value = copy.deepcopy(good)
            if name == 'instance': value['instance_id'] = 'wrong'
            elif name == 'record': value['requests'][req.digest]['response']['choices'] = [None]
            elif name == 'id': del value['requests'][req.digest]['response']['id']
            elif name == 'arguments': value['pending']['arguments'] = {'path': 'different'}
            return value
        for name in ['instance', 'record', 'id', 'arguments', 'filename', 'truncated']:
            with self.subTest(name=name):
                path.write_text(json.dumps(mutation(name)))
                wrong = path.with_name('wrong.json')
                if name == 'filename': path.rename(wrong)
                if name == 'truncated': path.write_text('{')
                factory = MagicMock()
                try:
                    with self.assertRaises(BridgeError) as error: Manager(self.config, factory)
                    self.assertEqual(error.exception.code, 'state_corrupt')
                    factory.assert_not_called()
                finally:
                    if wrong.exists(): wrong.rename(path)
        path.unlink()

    def test_directory_fsync_failure_never_publishes_tool(self):
        req, ticket, transport = self.begin()
        with patch('gemini_native_bridge.config.os.fsync', side_effect=[None, OSError('fixture')]):
            with self.assertRaises(BridgeError): transport.sink.tool('read_fixture', {'path': 'one'})
        self.assertIsNone(ticket.response)
        with self.assertRaises(BridgeError) as error: ticket.result(1)
        self.assertEqual(error.exception.code, 'state_storage_failed')
        self.assertTrue(transport.stopped)

    def test_http_headers_and_disconnect_paths(self):
        server = BridgeServer(self.config, self.manager, bind_port=0, heartbeat_interval=0.01)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 2)
        self.addCleanup(server.stop)
        base = [('Authorization', 'Bearer '+self.config.api_key), ('X-Gemini-Session', 'http')]
        cases = [
            (base + [('Authorization', 'Bearer duplicate')], '2', b'{}', 'unauthorized'),
            (base + [('X-Gemini-Session', 'duplicate')], '2', b'{}', 'duplicate_session_header'),
            (base + [('Transfer-Encoding', 'chunked')], '2', b'{}', 'unsupported_transfer_encoding'),
            (base, '9'*5000, b'', 'request_too_large'),
            (base, '1048577', b'', 'request_too_large'),
            (base, '+2', b'{}', 'invalid_content_length'),
            (base, '4', b'null', 'invalid_json'),
            ([], '2', b'{}', 'unauthorized'),
            (base[:1], '2', b'{}', 'missing_session'),
        ]
        for headers, length, body, expected in cases:
            conn = http.client.HTTPConnection('127.0.0.1', server.port, timeout=3)
            try:
                conn.putrequest('POST', '/v1/chat/completions')
                for key, value in headers: conn.putheader(key, value)
                conn.putheader('Content-Length', length)
                conn.endheaders(body)
                response = conn.getresponse()
                self.assertEqual(json.loads(response.read())['error']['code'], expected)
            finally: conn.close()
        # Exercise the handler's actual write failures without relying on TCP buffer timing.
        for stream in [True, False]:
            req = request()
            ticket = self.manager.submit('write-'+str(stream), req)
            transport = self.manager._active_transport
            transport.sink.tool('read_fixture', {'path': 'one'})
            handler = object.__new__(BridgeHandler)
            handler.server = server
            handler.path = '/v1/chat/completions'
            handler.headers = {'unused': ''}
            from email.message import Message
            handler.headers = Message()
            handler.headers['Authorization'] = 'Bearer '+self.config.api_key
            handler.headers['X-Gemini-Session'] = 'write-'+str(stream)
            body = {'model': MODEL_ID, 'messages': req.messages, 'tools': req.catalog.tools, 'stream': stream}
            handler._read_body_json = lambda: body
            handler.send_response = MagicMock()
            handler.send_header = MagicMock()
            handler.end_headers = MagicMock(side_effect=BrokenPipeError if stream else None)
            handler.wfile = MagicMock()
            handler.wfile.write.side_effect = BrokenPipeError
            handler.do_POST()
            self.assertEqual(self.manager.status('write-'+str(stream))['status'], 'abandoned')
            self.assertTrue(transport.stopped)

    def test_saved_turn_real_recovery_rejects_protocol_and_wrong_route(self):
        source = self.root/'source'
        source.mkdir()
        source.joinpath('turn-template.bin').write_bytes(frame(pb(1, b'c_fixture') + encode_varint(16) + encode_varint(100)))
        auth = MagicMock()
        auth.headers.return_value = ([[":path", TASK_RPC]], [])
        task = NativeTask(self.config, request(), MagicMock(), auth)
        task.conversation = task.output.conversation = b'c_fixture'
        task.output.request = b'r_fixture'
        for malformed in [True, False]:
            task.output.mode_id = MODE_ID if malformed else 'different'
            model = pb(2, pb(1, b'one')) + encode_varint(19*8) + encode_varint(2)
            turn = pb(1, pb(1, b'c_fixture') + pb(2, b'r_fixture')) + pb(4, pb(1, model))
            data = b'\xff\xff' if malformed else frame(pb(1, turn))
            with patch('gemini_native_bridge.transport.unary', return_value=({}, data)) as retrieve:
                with self.assertRaises(BridgeError) as error: task._recover_saved_turn(time.monotonic()+5)
                self.assertEqual(error.exception.code, 'native_protocol_error')
                retrieve.assert_called_once()

    def test_native_task_real_h2_tool_roundtrip(self):
        client_sock, peer = socket.socketpair()
        self.addCleanup(peer.close)
        self.addCleanup(client_sock.close)
        client_sock.settimeout(2)
        peer.settimeout(2)
        conn = h2.connection.H2Connection(h2.config.H2Configuration(client_side=False, header_encoding='utf-8'))
        reader = FrameReader()
        observed = []
        failure = []
        def send(): peer.sendall(conn.data_to_send())
        def call(name, args): return frame(pb(2, pb(1, pb(1, name) + pb(2, b'ctx') + pb(3, struct_obj(args)))))
        def peer_loop():
            try:
                conn.initiate_connection()
                send()
                while True:
                    for event in conn.receive_data(peer.recv(65536)):
                        if isinstance(event, h2.events.RequestReceived):
                            conn.send_headers(event.stream_id, [(':status', '200')])
                            if event.stream_id == 1:
                                conn.increment_flow_control_window(1024)
                                identifiers = pb(1, b'c_fixture') + pb(2, b'r_fixture')
                                conn.send_data(1, frame(pb(1003, pb(1, pb(2, identifiers) + pb(25, MODE_ID.encode())))))
                            else: conn.send_data(3, call(b'list_mcp', {}))
                        elif isinstance(event, h2.events.DataReceived):
                            conn.acknowledge_received_data(event.flow_controlled_length, event.stream_id)
                            if event.stream_id != 3: continue
                            for message in reader.feed(event.data):
                                if optional(message, 2) is None: continue  # subscription envelope
                                fn = one(one(message, 2), 1)
                                name = one(fn, 1)
                                payload = decode_struct(one(fn, 3))
                                observed.append((name, payload))
                                if name == b'list_mcp':
                                    conn.send_data(3, call(b'execute_mcp', {'ServerName': 'agent_bridge', 'ToolName': 'read_fixture', 'Arguments': {'path': 'one'}}))
                                else:
                                    model = pb(2, pb(1, b'fixture-result')) + encode_varint(19*8) + encode_varint(2)
                                    conn.send_data(1, frame(pb(1003, pb(1, pb(1, model)))))
                                    conn.send_headers(1, [('grpc-status', '0')], end_stream=True)
                                    conn.send_data(3, frame(pb(3, b'')))
                        elif isinstance(event, h2.events.StreamEnded) and event.stream_id == 3:
                            conn.send_headers(3, [('grpc-status', '0')], end_stream=True)
                            send()
                            return
                    send()
            except Exception as error: failure.append(error)
        worker = threading.Thread(target=peer_loop, daemon=True)
        worker.start()
        wrapped = MagicMock()
        wrapped.__enter__.return_value = wrapped
        wrapped.selected_alpn_protocol.return_value = 'h2'
        wrapped.recv.side_effect = client_sock.recv
        wrapped.sendall.side_effect = client_sock.sendall
        wrapped.settimeout.side_effect = client_sock.settimeout
        auth = MagicMock()
        def headers(rpc): return [[":method", "POST"], [":scheme", "https"], [":authority", "robinfrontend-pa.googleapis.com:443"], [":path", rpc], ["content-type", "application/grpc"]]
        auth.headers.return_value = (headers(TASK_RPC), headers(TOOLS_RPC))
        (self.root/'source').mkdir()
        (self.root/'source/task-template.bin').write_bytes(b'fixture')
        sink = MagicMock()
        task = NativeTask(self.config, request(), sink, auth)
        def tool(name, args):
            task.submit_result('call_fixture', 'fixture-result')
            return 'call_fixture'
        sink.tool.side_effect = tool
        with patch('gemini_native_bridge.transport.is_app_running', return_value=False), \
             patch('gemini_native_bridge.transport.build_task_request', return_value=frame(b'fixture')), \
             patch('gemini_native_bridge.transport.socket.create_connection', return_value=client_sock), \
             patch('gemini_native_bridge.transport.ssl.create_default_context') as tls:
            tls.return_value.wrap_socket.return_value = wrapped
            task._run()
        worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(failure, [])
        sink.fail.assert_not_called()
        sink.complete.assert_called_once_with('fixture-result')
        sink.tool.assert_called_once_with('read_fixture', {'path': 'one'})
        self.assertEqual([entry[0] for entry in observed], [b'list_mcp', b'execute_mcp'])
        self.assertEqual(observed[1][1]['output'], 'fixture-result')
