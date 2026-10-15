"""Test H2Writer bounded framing, FIFO stream close, FrameReader, in-memory H2 server, and native transport error boundaries."""
import socket
import ssl
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import h2.config
import h2.connection
import h2.events

from gemini_native_bridge.contract import BridgeError, parse_request
from gemini_native_bridge.protocol import (
    FrameReader,
    MODEL_ID,
    ProtocolError,
    TASK_RPC,
    TURN_RPC,
    TaskOutput,
    encode_varint,
    frame,
    pb,
    struct_obj,
)
from gemini_native_bridge.transport import H2Writer, NativeTask, unary


class TestTransport(unittest.TestCase):
    def test_h2_writer_fifo_end_marker_and_rejections(self):
        client = h2.connection.H2Connection(
            config=h2.config.H2Configuration(client_side=True, header_encoding="utf-8")
        )
        client.initiate_connection()
        headers = [(":method", "POST"), (":authority", "example.com"), (":scheme", "https"), (":path", "/test")]
        client.send_headers(1, headers)

        writer = H2Writer(client)
        writer.queue_data(1, b"part1", end_stream=False)
        writer.queue_data(1, b"part2", end_stream=True)

        with self.assertRaises(ValueError):
            writer.queue_data(1, b"part3", end_stream=False)

        server = h2.connection.H2Connection(config=h2.config.H2Configuration(client_side=False, header_encoding="utf-8"))
        server.initiate_connection()

        writer.drain()
        data = client.data_to_send()
        events = server.receive_data(data)

        received_chunks = []
        stream_ended_at_end = False
        for ev in events:
            if isinstance(ev, h2.events.DataReceived):
                received_chunks.append(ev.data)
            elif isinstance(ev, h2.events.StreamEnded):
                stream_ended_at_end = True

        self.assertEqual(b"".join(received_chunks), b"part1part2")
        self.assertTrue(stream_ended_at_end)

    def test_h2_writer_framing_and_flow_control(self):
        client = h2.connection.H2Connection(
            config=h2.config.H2Configuration(client_side=True, header_encoding="utf-8")
        )
        client.initiate_connection()
        headers = [(":method", "POST"), (":authority", "example.com"), (":scheme", "https"), (":path", "/test")]
        client.send_headers(1, headers)

        writer = H2Writer(client)
        payload = b"abcdefghij" * 10000  # 100,000 bytes
        writer.queue_data(1, payload, end_stream=True)

        sent_bytes = bytearray()
        end_stream_seen = False
        frame_count = 0

        server = h2.connection.H2Connection(config=h2.config.H2Configuration(client_side=False, header_encoding="utf-8"))
        server.initiate_connection()

        while True:
            writer.drain()
            data = client.data_to_send()
            if not data:
                break
            events = server.receive_data(data)
            for ev in events:
                if isinstance(ev, h2.events.DataReceived):
                    frame_count += 1
                    self.assertLessEqual(len(ev.data), 16384)
                    sent_bytes.extend(ev.data)
                    server.acknowledge_received_data(ev.flow_controlled_length, ev.stream_id)
                elif isinstance(ev, h2.events.StreamEnded):
                    end_stream_seen = True

            server_out = server.data_to_send()
            if server_out:
                client.receive_data(server_out)

        self.assertEqual(bytes(sent_bytes), payload)
        self.assertTrue(end_stream_seen)
        self.assertGreater(frame_count, 6)

    def test_frame_reader_parsing_and_rejections(self):
        reader = FrameReader()
        msg1 = b"hello_grpc_world"
        raw1 = frame(msg1)
        out1 = reader.feed(raw1[:7])
        self.assertEqual(out1, [])
        out2 = reader.feed(raw1[7:])
        self.assertEqual(out2, [msg1])
        reader.finish()

        # Compressed frame rejection
        reader2 = FrameReader()
        bad_compressed = b"\x01\x00\x00\x00\x04test"
        with self.assertRaises(ProtocolError):
            reader2.feed(bad_compressed)

        # Truncated frame rejection on finish
        reader3 = FrameReader()
        reader3.feed(raw1[:10])
        with self.assertRaises(ProtocolError):
            reader3.finish()

    def test_native_tool_callback_handling(self):
        body = {
            "model": MODEL_ID,
            "messages": [{"role": "user", "content": "one"}],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "read_fixture",
                    "description": "Read fixture",
                    "parameters": {
                        "type": "object",
                        "properties": {"value": {"type": "string"}},
                        "required": ["value"],
                        "additionalProperties": False,
                    },
                },
            }],
        }
        req = parse_request(body)
        sink = MagicMock()
        sink.tool.return_value = "call_mock_123"

        config = MagicMock()
        config.task_timeout = 60
        task = NativeTask(config, req, sink)
        writer = MagicMock()

        # Unknown native function
        unknown_msg = pb(2, pb(1, pb(1, b"unknown_func") + pb(2, b"ctx") + pb(3, struct_obj({}))))
        with self.assertRaises(BridgeError) as ctx:
            task._handle_tool_message(unknown_msg, writer)
        self.assertEqual(ctx.exception.code, "unsupported_native_function")

        # execute_mcp with invalid schema
        invalid_args_payload = {
            "ServerName": "agent_bridge",
            "ToolName": "read_fixture",
            "Arguments": {"wrong_key": 123},
        }
        invalid_msg = pb(2, pb(1, pb(1, b"execute_mcp") + pb(2, b"ctx") + pb(3, struct_obj(invalid_args_payload))))
        with self.assertRaises(BridgeError) as ctx:
            task._handle_tool_message(invalid_msg, writer)
        self.assertEqual(ctx.exception.code, "invalid_upstream_arguments")

        # execute_mcp with non-boolean destructiveHint
        bad_hint_payload = {
            "ServerName": "agent_bridge",
            "ToolName": "read_fixture",
            "Arguments": {"value": "ok"},
            "destructiveHint": "not_a_bool",
        }
        bad_hint_msg = pb(2, pb(1, pb(1, b"execute_mcp") + pb(2, b"ctx") + pb(3, struct_obj(bad_hint_payload))))
        with self.assertRaises(BridgeError) as ctx:
            task._handle_tool_message(bad_hint_msg, writer)
        self.assertEqual(ctx.exception.code, "invalid_destructive_hint")

        # Valid tool call
        valid_args_payload = {
            "ServerName": "agent_bridge",
            "ToolName": "read_fixture",
            "Arguments": {"value": "test_ok"},
        }
        valid_msg = pb(2, pb(1, pb(1, b"execute_mcp") + pb(2, b"ctx_valid") + pb(3, struct_obj(valid_args_payload))))
        task._handle_tool_message(valid_msg, writer)
        sink.tool.assert_called_once_with("read_fixture", {"value": "test_ok"})
        self.assertEqual(task.pending_call_id, "call_mock_123")

        # Simultaneous parallel tool call fails
        with self.assertRaises(BridgeError) as ctx:
            task._handle_tool_message(valid_msg, writer)
        self.assertEqual(ctx.exception.code, "unsupported_parallel_call")

    def test_task_output_partial_text_followed_by_empty_terminal_remains_incomplete(self):
        output = TaskOutput()
        partial_model = pb(2, pb(1, b"partial intermediate text"))
        output._model(partial_model)
        self.assertEqual(output.text, "partial intermediate text")
        self.assertFalse(output.complete)

        terminal_no_text_model = encode_varint(19 * 8 + 0) + encode_varint(2)
        output._model(terminal_no_text_model)
        self.assertEqual(output.text, "")
        self.assertEqual(output.completeness, 2)
        self.assertFalse(output.complete)

    @patch("gemini_native_bridge.transport.is_app_running", return_value=False)
    @patch("gemini_native_bridge.transport.build_task_request", return_value=b"mock_body")
    @patch("socket.create_connection")
    def test_cancel_during_auth_results_in_zero_socket_calls(self, mock_connect, mock_build, mock_app):
        body = {"model": MODEL_ID, "messages": [{"role": "user", "content": "one"}]}
        req = parse_request(body)
        sink = MagicMock()

        config = MagicMock()
        config.task_timeout = 60
        config.data_dir = MagicMock()
        (config.data_dir / "source" / "task-template.bin").exists.return_value = True
        (config.data_dir / "source" / "task-template.bin").read_bytes.return_value = b"template_bytes"

        auth_mgr = MagicMock()
        def cancel_during_auth():
            task.stop()
            return ([["header", "val"]], [["header", "val"]])
        auth_mgr.headers.side_effect = cancel_during_auth

        task = NativeTask(config, req, sink, auth_manager=auth_mgr)
        task._run()

        self.assertEqual(mock_connect.call_count, 0)
        sink.fail.assert_called_once()
        self.assertEqual(sink.fail.call_args[0][0].code, "cancelled")

    def test_in_memory_h2_server_unary_success_with_window_update_0_and_error_boundaries(self):
        def run_test_scenario(server_action):
            client_sock, server_sock = socket.socketpair()
            fake_ssl = MagicMock()
            fake_ssl.selected_alpn_protocol.return_value = "h2"
            fake_ssl.recv.side_effect = client_sock.recv
            fake_ssl.sendall.side_effect = client_sock.sendall
            fake_ssl.__enter__.return_value = fake_ssl
            fake_ssl.__exit__.return_value = None

            server_conn = h2.connection.H2Connection(h2.config.H2Configuration(client_side=False, header_encoding="utf-8"))
            server_conn.initiate_connection()
            server_sock.sendall(server_conn.data_to_send())

            def server_thread_func():
                try:
                    server_action(server_sock, server_conn)
                except Exception:
                    pass
                finally:
                    try:
                        server_sock.close()
                    except Exception:
                        pass

            st = threading.Thread(target=server_thread_func, daemon=True)
            st.start()

            headers = [
                [":authority", "robinfrontend-pa.googleapis.com:443"],
                [":scheme", "https"],
                [":method", "POST"],
                [":path", TURN_RPC],
                ["content-type", "application/grpc"],
            ]

            with patch("socket.create_connection", return_value=client_sock):
                with patch("ssl.create_default_context") as mock_ctx:
                    mock_ctx.return_value.wrap_socket.return_value = fake_ssl
                    res = unary(headers, frame(b"ping"), rpc_path=TURN_RPC, timeout=3.0)
            st.join(timeout=2.0)
            return res

        # 1. Success with WindowUpdated(stream_id=0)
        def server_ok(sock, conn):
            while True:
                raw = sock.recv(65536)
                if not raw:
                    break
                events = conn.receive_data(raw)
                sock.sendall(conn.data_to_send())
                for ev in events:
                    if isinstance(ev, h2.events.RequestReceived):
                        conn.increment_flow_control_window(1024)
                        conn.send_headers(1, [(":status", "200")])
                        conn.send_data(1, frame(b"turn_response_data"))
                        conn.send_headers(1, [("grpc-status", "0")], end_stream=True)
                        sock.sendall(conn.data_to_send())
                        time.sleep(0.05)
                        return

        h, data = run_test_scenario(server_ok)
        self.assertEqual(h[":status"], "200")
        self.assertEqual(h["grpc-status"], "0")
        self.assertEqual(data, frame(b"turn_response_data"))

        # 2. HTTP 403 failure
        def server_403(sock, conn):
            while True:
                raw = sock.recv(65536)
                if not raw:
                    break
                conn.receive_data(raw)
                sock.sendall(conn.data_to_send())
                conn.send_headers(1, [(":status", "403")], end_stream=True)
                sock.sendall(conn.data_to_send())
                time.sleep(0.05)
                return

        with self.assertRaises(BridgeError) as ctx:
            run_test_scenario(server_403)
        self.assertEqual(ctx.exception.code, "rpc_http_error")

        # 3. grpc-status 16 failure
        def server_grpc16(sock, conn):
            while True:
                raw = sock.recv(65536)
                if not raw:
                    break
                conn.receive_data(raw)
                sock.sendall(conn.data_to_send())
                conn.send_headers(1, [(":status", "200")])
                conn.send_headers(1, [("grpc-status", "16")], end_stream=True)
                sock.sendall(conn.data_to_send())
                time.sleep(0.05)
                return

        with self.assertRaises(BridgeError) as ctx:
            run_test_scenario(server_grpc16)
        self.assertEqual(ctx.exception.code, "grpc_error")

        # 4. Unexpected application stream (e.g. stream 2)
        def server_unexpected_stream(sock, conn):
            while True:
                raw = sock.recv(65536)
                if not raw:
                    break
                conn.receive_data(raw)
                sock.sendall(conn.data_to_send())
                conn.send_headers(2, [(":method", "GET"), (":path", "/"), (":scheme", "https"), (":authority", "localhost")])
                sock.sendall(conn.data_to_send())
                time.sleep(0.05)
                return

        with self.assertRaises(BridgeError) as ctx:
            run_test_scenario(server_unexpected_stream)
        self.assertEqual(ctx.exception.code, "unexpected_stream")

        # 5. Missing trailers / EOF before stream ended
        def server_missing_trailers(sock, conn):
            raw = sock.recv(65536)
            conn.receive_data(raw)
            conn.send_headers(1, [(":status", "200")])
            conn.send_data(1, frame(b"data"))
            sock.sendall(conn.data_to_send())
            sock.close()  # clean EOF without stream end

        with self.assertRaises(BridgeError) as ctx:
            run_test_scenario(server_missing_trailers)
        self.assertEqual(ctx.exception.code, "transport_eof")



if __name__ == "__main__":
    unittest.main()
