"""Test state machine, persistence, snapshots, ticket lifecycle, and HTTP integration."""
import hashlib
import http.client
import json
import socket
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from gemini_native_bridge.config import RuntimeConfig
from gemini_native_bridge.contract import BridgeError, parse_request
from gemini_native_bridge.protocol import MODEL_ID
from gemini_native_bridge.server import BridgeServer
from gemini_native_bridge.state import Manager


class FakeTransport:
    instances = []

    def __init__(self, config, request, sink):
        self.config = config
        self.request = request
        self.sink = sink
        self.stopped = False
        self.results = []
        FakeTransport.instances.append(self)

    def start(self):
        pass

    def submit_result(self, call_id: str, text: str):
        self.results.append((call_id, text))

    def stop(self):
        self.stopped = True


class TestStateAndServer(unittest.TestCase):
    def setUp(self):
        FakeTransport.instances.clear()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp_dir.name)
        self.source_dir = self.data_dir / "source"
        self.source_dir.mkdir(parents=True, mode=0o700)

        self.config = RuntimeConfig(
            data_dir=self.data_dir,
            api_key="test_api_key_valid_string_value__",
            instance_id="inst_test_01",
            auth_file=self.data_dir / "auth.bin",
            binary=self.data_dir / "Gemini",
            subject_sha256=hashlib.sha256(b"sub").hexdigest(),
            account_label="Account1",
            port=18084,
            task_timeout=60,
            tool_timeout=10,
            max_tool_calls=5,
        )

        self.tools = [{
            "type": "function",
            "function": {
                "name": "write_fixture",
                "description": "Writes fixture",
                "parameters": {
                    "type": "object",
                    "properties": {"value": {"type": "string"}},
                    "required": ["value"],
                    "additionalProperties": False,
                },
            },
        }]

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_state_lifecycle_multi_turn_and_caching(self):
        manager = Manager(self.config, transport_factory=FakeTransport)
        session_id = "sess_001"

        # 1. Initial request
        body1 = {
            "model": MODEL_ID,
            "messages": [{"role": "user", "content": "one"}],
            "tools": self.tools,
        }
        req1 = parse_request(body1)
        ticket1 = manager.submit(session_id, req1)
        self.assertEqual(len(FakeTransport.instances), 1)
        transport = FakeTransport.instances[0]

        snapshot_at_publication = None
        orig_set = ticket1.event.set

        def spy_set():
            nonlocal snapshot_at_publication
            snapshot_at_publication = manager._load_snapshot(session_id)
            orig_set()

        ticket1.event.set = spy_set

        call_id_1 = transport.sink.tool("write_fixture", {"value": "first"})
        resp1 = ticket1.result(timeout=2.0)
        self.assertEqual(resp1["choices"][0]["finish_reason"], "tool_calls")
        tc1 = resp1["choices"][0]["message"]["tool_calls"][0]
        self.assertEqual(tc1["id"], call_id_1)

        # Snapshot on disk was already in waiting_for_tool during publication
        self.assertIsNotNone(snapshot_at_publication)
        self.assertEqual(snapshot_at_publication["status"], "waiting_for_tool")
        self.assertEqual(snapshot_at_publication["pending"]["id"], call_id_1)

        # 2. Replay of same request while waiting returns cached tool response
        ticket1_replay = manager.submit(session_id, req1)
        resp1_replay = ticket1_replay.result(timeout=1.0)
        self.assertEqual(resp1_replay["choices"][0]["message"]["tool_calls"][0]["id"], call_id_1)

        # 3. Wrong submission boundaries with no extra upstream submission
        inst_count_before = len(FakeTransport.instances)

        body_wrong_sess = {
            "model": MODEL_ID,
            "messages": [
                {"role": "user", "content": "one"},
                resp1["choices"][0]["message"],
                {"role": "tool", "tool_call_id": call_id_1, "content": "res"},
            ],
            "tools": self.tools,
        }
        with self.assertRaises(BridgeError) as ctx:
            manager.submit("unknown_sess_xyz", parse_request(body_wrong_sess))
        self.assertEqual(ctx.exception.code, "unknown_task")

        body_wrong_id = {
            "model": MODEL_ID,
            "messages": [
                {"role": "user", "content": "one"},
                resp1["choices"][0]["message"],
                {"role": "tool", "tool_call_id": "call_different_id", "content": "res"},
            ],
            "tools": self.tools,
        }
        with self.assertRaises(BridgeError) as ctx:
            manager.submit(session_id, parse_request(body_wrong_id))
        self.assertEqual(ctx.exception.code, "tool_call_id_mismatch")

        body_bad_hist = {
            "model": MODEL_ID,
            "messages": [
                {"role": "user", "content": "modified_prompt"},
                resp1["choices"][0]["message"],
                {"role": "tool", "tool_call_id": call_id_1, "content": "res"},
            ],
            "tools": self.tools,
        }
        with self.assertRaises(BridgeError) as ctx:
            manager.submit(session_id, parse_request(body_bad_hist))
        self.assertEqual(ctx.exception.code, "history_mismatch")

        body_bad_tools = {
            "model": MODEL_ID,
            "messages": [
                {"role": "user", "content": "one"},
                resp1["choices"][0]["message"],
                {"role": "tool", "tool_call_id": call_id_1, "content": "res"},
            ],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "different_tool",
                    "description": "Diff",
                    "parameters": {"type": "object"},
                },
            }],
        }
        with self.assertRaises(BridgeError) as ctx:
            manager.submit(session_id, parse_request(body_bad_tools))
        self.assertEqual(ctx.exception.code, "signature_mismatch")

        self.assertEqual(len(FakeTransport.instances), inst_count_before)

        # 4. User submits valid tool result
        body2 = {
            "model": MODEL_ID,
            "messages": [
                {"role": "user", "content": "one"},
                resp1["choices"][0]["message"],
                {"role": "tool", "tool_call_id": call_id_1, "content": "result_1"},
            ],
            "tools": self.tools,
        }
        req2 = parse_request(body2)
        ticket2 = manager.submit(session_id, req2)
        self.assertEqual(transport.results, [(call_id_1, "result_1")])

        # Attempting to replay old tool phase yields 410 stale_tool_phase
        with self.assertRaises(BridgeError) as ctx:
            manager.submit(session_id, req1)
        self.assertEqual(ctx.exception.status, 410)

        # Upstream triggers second tool
        call_id_2 = transport.sink.tool("write_fixture", {"value": "second"})
        resp2 = ticket2.result(timeout=2.0)
        self.assertEqual(resp2["choices"][0]["message"]["tool_calls"][0]["id"], call_id_2)

        # 5. User submits second tool result
        body3 = {
            "model": MODEL_ID,
            "messages": [
                {"role": "user", "content": "one"},
                resp1["choices"][0]["message"],
                {"role": "tool", "tool_call_id": call_id_1, "content": "result_1"},
                resp2["choices"][0]["message"],
                {"role": "tool", "tool_call_id": call_id_2, "content": "result_2"},
            ],
            "tools": self.tools,
        }
        req3 = parse_request(body3)
        ticket3 = manager.submit(session_id, req3)

        # Assert exactly 2 submit_result calls
        self.assertEqual(len(transport.results), 2)
        self.assertEqual(transport.results[1], (call_id_2, "result_2"))

        # Upstream completes
        transport.sink.complete("final answer text")
        resp3 = ticket3.result(timeout=2.0)
        self.assertEqual(resp3["choices"][0]["finish_reason"], "stop")
        self.assertEqual(resp3["choices"][0]["message"]["content"], "final answer text")

        # 6. Exact same final request returns identical cached response ID without new submission
        ticket3_cached = manager.submit(session_id, req3)
        resp3_cached = ticket3_cached.result(timeout=1.0)
        self.assertEqual(resp3_cached["id"], resp3["id"])
        self.assertEqual(resp3_cached["choices"][0]["message"]["content"], "final answer text")
        self.assertEqual(len(FakeTransport.instances), 1)

        # 7. Second user turn starts second Task
        body4 = {
            "model": MODEL_ID,
            "messages": body3["messages"] + [
                resp3["choices"][0]["message"],
                {"role": "user", "content": "two"},
            ],
            "tools": self.tools,
        }
        req4 = parse_request(body4)
        ticket4 = manager.submit(session_id, req4)
        self.assertEqual(len(FakeTransport.instances), 2)
        transport2 = FakeTransport.instances[1]

        # Verify stale callback from Task 1 cannot alter Task 2
        stale_res = transport.sink.tool("write_fixture", {"value": "stale"})
        self.assertEqual(stale_res, "")
        self.assertEqual(manager._active_task_id, ticket4.task_id)

        transport2.sink.complete("second answer")
        resp4 = ticket4.result(timeout=2.0)
        self.assertEqual(resp4["choices"][0]["message"]["content"], "second answer")

        manager.close()

    def test_crash_recovery_and_corrupt_refusal(self):
        (self.data_dir / "sessions").mkdir(parents=True, exist_ok=True)
        crash_session = "sess_crashed"
        key = json.dumps([self.config.instance_id, crash_session], sort_keys=True, separators=(",", ":"))
        h = hashlib.sha256(key.encode()).hexdigest()
        snap_file = self.data_dir / "sessions" / f"{h}.json"

        crashed_snapshot = {
            "version": 1,
            "session_id": crash_session,
            "instance_id": self.config.instance_id,
            "task_id": "task_crashed_123",
            "status": "running",
            "signature": "sig",
            "history": [{"role": "user", "content": "one"}],
            "pending": None,
            "calls": 0,
            "error": None,
            "requests": {
                "in_flight_digest": {"task_id": "task_crashed_123", "response": None, "error": None},
                "completed_digest": {"task_id": "task_crashed_123", "response": {"id": "chatcmpl-done", "object": "chat.completion", "choices": [{"index": 0, "message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}]}, "error": None},
            },
            "updated_at": time.time(),
        }
        snap_file.write_text(json.dumps(crashed_snapshot))

        mgr = Manager(self.config, transport_factory=FakeTransport)
        snap_after = mgr._load_snapshot(crash_session)
        self.assertEqual(snap_after["status"], "interrupted")
        self.assertIsNone(snap_after["pending"])
        self.assertEqual(snap_after["requests"]["in_flight_digest"]["error"]["code"], "interrupted")
        self.assertEqual(snap_after["requests"]["completed_digest"]["response"]["id"], "chatcmpl-done")

        # Refusal on corrupt snapshot
        corrupt_session = "sess_corrupted"
        k_corrupt = json.dumps([self.config.instance_id, corrupt_session], sort_keys=True, separators=(",", ":"))
        h_corrupt = hashlib.sha256(k_corrupt.encode()).hexdigest()
        (self.data_dir / "sessions" / f"{h_corrupt}.json").write_text("{invalid_json_truncated")

        inst_before = len(FakeTransport.instances)
        with self.assertRaises(BridgeError) as ctx:
            Manager(self.config, transport_factory=FakeTransport)
        self.assertEqual(ctx.exception.code, "state_corrupt")
        self.assertEqual(len(FakeTransport.instances), inst_before)
        mgr.close()

    def test_storage_failure_latch(self):
        manager = Manager(self.config, transport_factory=FakeTransport)
        body = {"model": MODEL_ID, "messages": [{"role": "user", "content": "one"}], "tools": self.tools}
        req = parse_request(body)
        ticket = manager.submit("sess_latch", req)
        transport = FakeTransport.instances[-1]

        with patch("gemini_native_bridge.state.atomic_write_file", side_effect=OSError("Disk write failed")):
            with self.assertRaises(BridgeError) as ctx:
                transport.sink.tool("write_fixture", {"value": "x"})
            self.assertEqual(ctx.exception.code, "state_storage_failed")

        with self.assertRaises(BridgeError) as ctx:
            ticket.result(timeout=1.0)
        self.assertEqual(ctx.exception.code, "state_storage_failed")
        self.assertTrue(transport.stopped)

        with self.assertRaises(BridgeError) as ctx:
            manager.submit("sess_latch_2", req)
        self.assertEqual(ctx.exception.code, "state_storage_failed")
        manager.close()

    def test_deadline_enforcement_at_submit_and_late_callback(self):
        short_config = RuntimeConfig(
            data_dir=self.data_dir,
            api_key=self.config.api_key,
            instance_id="inst_short",
            auth_file=self.config.auth_file,
            binary=self.config.binary,
            subject_sha256=self.config.subject_sha256,
            account_label="Acc",
            port=18085,
            task_timeout=60,
            tool_timeout=1,
            max_tool_calls=5,
        )
        manager = Manager(short_config, transport_factory=FakeTransport)
        body = {"model": MODEL_ID, "messages": [{"role": "user", "content": "one"}], "tools": self.tools}
        req = parse_request(body)
        ticket = manager.submit("sess_deadline", req)
        transport = FakeTransport.instances[-1]

        cid = transport.sink.tool("write_fixture", {"value": "first"})
        resp = ticket.result(timeout=1.0)

        # Advance deadline into past
        manager._pending_deadline = time.monotonic() - 1.0

        body_tool = {
            "model": MODEL_ID,
            "messages": [
                {"role": "user", "content": "one"},
                resp["choices"][0]["message"],
                {"role": "tool", "tool_call_id": cid, "content": "res"},
            ],
            "tools": self.tools,
        }
        with self.assertRaises(BridgeError) as ctx:
            manager.submit("sess_deadline", parse_request(body_tool))
        self.assertEqual(ctx.exception.code, "tool_timeout")

        # Late abandon_delivery from earlier task does not alter state
        manager.abandon_delivery("sess_deadline", "old_task_id", "old_digest")
        st = manager.status("sess_deadline")
        self.assertEqual(st["status"], "failed")

        manager.close()

    def test_http_server_endpoints_and_streaming(self):
        manager = Manager(self.config, transport_factory=FakeTransport)
        server = BridgeServer(self.config, manager, bind_port=0, heartbeat_interval=0.05)
        srv_thread = threading.Thread(target=server.serve_forever, daemon=True)
        srv_thread.start()
        time.sleep(0.05)

        base_url = f"http://127.0.0.1:{server.port}"
        auth_hdr = {"Authorization": f"Bearer {self.config.api_key}"}

        try:
            # 1. Duplicate Content-Length rejected using http.client (urllib replaces duplicate headers)
            conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=5)
            conn.putrequest("POST", "/v1/chat/completions")
            conn.putheader("Authorization", f"Bearer {self.config.api_key}")
            conn.putheader("X-Gemini-Session", "dup_cl_sess")
            conn.putheader("Content-Type", "application/json")
            conn.putheader("Content-Length", "2")
            conn.putheader("Content-Length", "2")
            conn.endheaders()
            conn.send(b'{}')
            resp = conn.getresponse()
            self.assertEqual(resp.status, 400)
            err_data = json.loads(resp.read().decode())
            self.assertEqual(err_data["error"]["code"], "duplicate_content_length")
            conn.close()

            # 2. Conflicting session headers rejected
            req_conf_sess = urllib.request.Request(
                f"{base_url}/v1/chat/completions",
                data=b'{"model":"gemini-task-argon","messages":[{"role":"user","content":"one"}]}',
                headers={**auth_hdr, "Content-Type": "application/json", "X-Gemini-Session": "sessA", "X-Magpie-Session": "sessB"},
            )
            try:
                urllib.request.urlopen(req_conf_sess)
                self.fail("Expected 400")
            except urllib.error.HTTPError as e:
                self.assertEqual(e.code, 400)
                data = json.loads(e.read())
                self.assertEqual(data["error"]["code"], "session_header_conflict")

            # 3. JSON null body rejected with 400
            req_null = urllib.request.Request(
                f"{base_url}/v1/chat/completions",
                data=b"null",
                headers={**auth_hdr, "Content-Type": "application/json", "X-Gemini-Session": "sess_null"},
            )
            try:
                urllib.request.urlopen(req_null)
                self.fail("Expected 400")
            except urllib.error.HTTPError as e:
                self.assertEqual(e.code, 400)
                data = json.loads(e.read())
                self.assertEqual(data["error"]["code"], "invalid_json")

            # 4. Streaming SSE response
            stream_payload = json.dumps({"model": MODEL_ID, "messages": [{"role": "user", "content": "one"}], "stream": True}).encode()
            req_stream = urllib.request.Request(
                f"{base_url}/v1/chat/completions",
                data=stream_payload,
                headers={**auth_hdr, "Content-Type": "application/json", "X-Gemini-Session": "http_stream_test"},
            )

            def complete_stream_later():
                time.sleep(0.1)
                FakeTransport.instances[-1].sink.complete("streamed_text")

            threading.Thread(target=complete_stream_later, daemon=True).start()
            with urllib.request.urlopen(req_stream) as res:
                self.assertEqual(res.status, 200)
                self.assertEqual(res.headers.get("Content-Type"), "text/event-stream")
                self.assertEqual(res.headers.get("X-Magpie-Sign-In"), "kept")
                content = res.read().decode()
                self.assertIn("data: [DONE]", content)
                self.assertIn('"delta": {"content": "streamed_text"}', content)
        finally:
            server.stop()
            srv_thread.join(timeout=2.0)


if __name__ == "__main__":
    unittest.main()
