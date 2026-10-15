"""Native Task HTTP/2 transport implementation."""
from __future__ import annotations

import collections
import queue
import secrets
import socket
import ssl
import subprocess
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import unquote

import h2.config
import h2.connection
import h2.events

from .auth import AuthManager
from .config import RuntimeConfig, require_macos
from .contract import BridgeError, CompletionRequest, render_prompt
from .protocol import (
    HOST,
    MAX_FRAME,
    MODE_ID,
    ProtocolError,
    SERVER_NAME,
    TASK_RPC,
    TOOLS_RPC,
    TURN_RPC,
    FrameReader,
    TaskOutput,
    build_task_request,
    decode_struct,
    fields,
    frame,
    messages,
    one,
    pb,
    tool_reply,
    turn_request,
    validate_headers,
)


def is_app_running() -> bool:
    try:
        res = subprocess.run(["pgrep", "-x", "Gemini"], capture_output=True, timeout=5)
        if res.returncode == 0:
            return True
        if res.returncode == 1:
            return False
        raise BridgeError("app_state_unavailable", "pgrep returned unexpected status.", 409)
    except BridgeError:
        raise
    except Exception as e:
        raise BridgeError("app_state_unavailable", "Cannot determine whether Gemini.app is running.", 409) from e


class H2Writer:
    """Bounded HTTP/2 outbound writer with per-stream frame splitting and FIFO end markers."""

    def __init__(self, client: h2.connection.H2Connection):
        self.client = client
        self.queues: dict[int, collections.deque[list[Any]]] = collections.defaultdict(collections.deque)
        self.closed_streams: set[int] = set()

    def queue_data(self, stream_id: int, data: bytes, end_stream: bool = False):
        if stream_id in self.closed_streams:
            raise ValueError(f"Cannot queue data on stream {stream_id} after end_stream.")
        if end_stream:
            self.closed_streams.add(stream_id)
        self.queues[stream_id].append([bytearray(data), end_stream])

    def drain(self) -> bool:
        sent_any = False
        active_streams = list(self.queues.keys())
        for sid in active_streams:
            q = self.queues[sid]
            while q:
                item = q[0]
                chunk, is_end = item[0], item[1]
                if len(chunk) == 0:
                    if is_end:
                        self.client.end_stream(sid)
                        q.popleft()
                        sent_any = True
                        continue
                    else:
                        q.popleft()
                        continue

                window = self.client.local_flow_control_window(sid)
                conn_window = self.client.outbound_flow_control_window
                max_frame = self.client.max_outbound_frame_size
                sendable = min(window, conn_window, max_frame, len(chunk))
                if sendable <= 0:
                    break

                to_send = bytes(chunk[:sendable])
                del chunk[:sendable]
                end_now = len(chunk) == 0 and is_end
                if len(chunk) == 0:
                    q.popleft()

                self.client.send_data(sid, to_send, end_stream=end_now)
                sent_any = True
        return sent_any


def grpc_failure(status: str, message: str = "") -> BridgeError:
    if status == "8" and unquote(message).endswith(": Remy quota exhausted"):
        return BridgeError("native_quota_exhausted", "The account's native Task quota is exhausted. Wait for its quota to reset.", 409)
    return BridgeError("grpc_error", f"Native RPC failed with grpc-status {status}.", 409)


def unary(
    headers: list[list[str]],
    request_data: bytes,
    *,
    rpc_path: str,
    timeout: float = 15.0,
) -> tuple[dict[str, str], bytes]:
    """Execute a single bounded gRPC unary request over HTTP/2."""
    if rpc_path not in (TASK_RPC, TOOLS_RPC, TURN_RPC):
        raise BridgeError("invalid_rpc_path", f"Path {rpc_path} is not permitted.")

    validate_headers(headers, rpc_path)

    deadline = time.monotonic() + timeout
    context = ssl.create_default_context()
    context.set_alpn_protocols(["h2"])

    client = h2.connection.H2Connection(
        config=h2.config.H2Configuration(client_side=True, header_encoding="utf-8")
    )
    writer = H2Writer(client)
    reader = FrameReader()
    response_headers: dict[str, str] = {}
    response_data = bytearray()
    stream_ended = False

    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise BridgeError("timeout", "Unary request timed out.", 409)

    with socket.create_connection((HOST, 443), timeout=min(timeout, remaining)) as raw_sock:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise BridgeError("timeout", "Unary request timed out.", 409)
        raw_sock.settimeout(remaining)
        with context.wrap_socket(raw_sock, server_hostname=HOST, suppress_ragged_eofs=False) as sock:
            if sock.selected_alpn_protocol() != "h2":
                raise BridgeError("h2_not_negotiated", "Server did not negotiate HTTP/2.")

            client.initiate_connection()
            client.send_headers(1, headers)
            writer.queue_data(1, request_data, end_stream=True)
            writer.drain()
            sock.sendall(client.data_to_send())

            sock.settimeout(0.25)
            while not stream_ended:
                if time.monotonic() >= deadline:
                    raise BridgeError("timeout", "Unary request timed out.", 409)

                writer.drain()
                outgoing = client.data_to_send()
                if outgoing:
                    sock.sendall(outgoing)

                try:
                    data = sock.recv(65536)
                except socket.timeout:
                    continue
                except (ssl.SSLEOFError, ConnectionResetError, BrokenPipeError) as e:
                    raise BridgeError("transport_eof", "Connection terminated unexpectedly.", 409) from e

                if not data:
                    break

                for event in client.receive_data(data):
                    sid = getattr(event, "stream_id", None)
                    # WindowUpdated(stream_id=0) or None is connection-level; allow 0 and 1
                    if sid not in (None, 0, 1) and not isinstance(event, (h2.events.ConnectionTerminated, h2.events.PingAckReceived)):
                        raise BridgeError("unexpected_stream", "Unexpected application stream.", 409)

                    if isinstance(event, (h2.events.ResponseReceived, h2.events.TrailersReceived)):
                        if event.stream_id == 1:
                            response_headers.update(dict(event.headers))
                            status = response_headers.get(":status")
                            if status is not None and status != "200":
                                raise BridgeError("rpc_http_error", f"RPC HTTP status {status}", 409)
                            grpc_st = response_headers.get("grpc-status")
                            if grpc_st is not None and grpc_st != "0":
                                raise grpc_failure(grpc_st, response_headers.get("grpc-message", ""))
                    elif isinstance(event, h2.events.DataReceived):
                        if event.stream_id == 1:
                            client.acknowledge_received_data(event.flow_controlled_length, event.stream_id)
                            response_data.extend(event.data)
                            if len(response_data) > 16 * 1024 * 1024:
                                raise BridgeError("oversized_response", "Unary response exceeded 16 MiB.", 409)
                            reader.feed(event.data)
                    elif isinstance(event, h2.events.StreamEnded):
                        if event.stream_id == 1:
                            if response_headers.get(":status") != "200":
                                raise BridgeError("rpc_http_error", "RPC failed with non-200 status.", 409)
                            if response_headers.get("grpc-status") != "0":
                                raise BridgeError("grpc_error", "RPC failed with nonzero or missing grpc-status.", 409)
                            reader.finish()
                            stream_ended = True
                    elif isinstance(event, h2.events.WindowUpdated):
                        writer.drain()
                    elif isinstance(event, h2.events.StreamReset):
                        if event.stream_id == 1:
                            raise BridgeError("stream_reset", f"Stream 1 reset by server with code {event.error_code}.", 409)
                    elif isinstance(event, h2.events.ConnectionTerminated):
                        raise BridgeError("connection_terminated", "Connection terminated by server.", 409)

    if not stream_ended:
        raise BridgeError("transport_eof", "Connection closed before StreamEnded.", 409)

    return response_headers, bytes(response_data)


class NativeTask:
    """Active streaming Task transport session."""

    def __init__(self, config: RuntimeConfig, request: CompletionRequest, sink, auth_manager: AuthManager | None = None):
        self.config = config
        self.request = request
        self.sink = sink
        self.auth_manager = auth_manager or AuthManager(config)
        self.stop_event = threading.Event()
        self.result_queue: queue.Queue[tuple[str, str]] = queue.Queue()
        self._thread: threading.Thread | None = None

        self.pending_call_id: str | None = None
        self.pending_context: bytes | None = None
        self.pending_function: bytes | None = None
        self.pending_tool_name: str | None = None
        self.conversation: bytes | None = None
        self.output = TaskOutput()

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True, name="NativeTaskTransport")
        self._thread.start()

    def submit_result(self, call_id: str, text: str) -> None:
        self.result_queue.put((call_id, text))

    def stop(self) -> None:
        self.stop_event.set()

    def _check_active(self, deadline: float, check_app: bool = False):
        if self.stop_event.is_set():
            raise BridgeError("cancelled", "Task locally cancelled; native_cancel_confirmed: false.", 409)
        if time.monotonic() >= deadline:
            raise BridgeError("task_timeout", f"Task exceeded budget of {self.config.task_timeout}s.", 409)
        if check_app and is_app_running():
            raise BridgeError("app_running", "Close Gemini before using the native Task provider.", 409)

    def _run(self) -> None:
        try:
            require_macos()
            deadline = time.monotonic() + self.config.task_timeout

            self._check_active(deadline, check_app=True)

            prompt = render_prompt(self.request)
            task_template_path = self.config.data_dir / "source" / "task-template.bin"
            if not task_template_path.exists():
                raise BridgeError("missing_template", "task-template.bin is missing.", 409)
            task_body = build_task_request(task_template_path.read_bytes(), prompt)

            self._check_active(deadline, check_app=False)

            task_headers, tool_headers = self.auth_manager.headers()

            self._check_active(deadline, check_app=True)

            context = ssl.create_default_context()
            context.set_alpn_protocols(["h2"])

            client = h2.connection.H2Connection(
                config=h2.config.H2Configuration(client_side=True, header_encoding="utf-8")
            )
            writer = H2Writer(client)
            task_reader = FrameReader()
            tool_reader = FrameReader()

            ended_streams: set[int] = set()
            stream_headers: dict[int, dict[str, str]] = collections.defaultdict(dict)
            tool_subscribed = False
            last_rx = time.monotonic()
            pending_ping: bytes | None = None

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise BridgeError("task_timeout", "Task timed out.", 409)

            self._check_active(deadline)
            with socket.create_connection((HOST, 443), timeout=min(15.0, remaining)) as raw_sock:
                self._check_active(deadline)
                raw_sock.settimeout(max(0.01, min(15.0, deadline - time.monotonic())))
                with context.wrap_socket(raw_sock, server_hostname=HOST, suppress_ragged_eofs=False) as sock:
                    if sock.selected_alpn_protocol() != "h2":
                        raise BridgeError("h2_not_negotiated", "Server did not negotiate HTTP/2.")

                    self._check_active(deadline, check_app=True)

                    client.initiate_connection()
                    client.send_headers(1, task_headers)
                    writer.queue_data(1, task_body, end_stream=True)
                    writer.drain()

                    self._check_active(deadline, check_app=False)
                    sock.sendall(client.data_to_send())

                    sock.settimeout(0.25)

                    while True:
                        if 1 in ended_streams:
                            # Stream 1 ended. Require explicit conversation and tool stream finish
                            if not self.conversation:
                                raise BridgeError("incomplete_task", "Stream 1 ended without conversation identifier.", 409)
                            if 3 in ended_streams or not tool_subscribed:
                                break
                        elif {1, 3} <= ended_streams:
                            break

                        self._check_active(deadline, check_app=True)

                        try:
                            cid, text = self.result_queue.get_nowait()
                            if self.pending_call_id is None or cid != self.pending_call_id:
                                raise BridgeError("tool_call_id_mismatch", "Submitted result does not match pending call.", 409)
                            reply_payload = {"output": text, "tool": self.pending_tool_name, "server": SERVER_NAME}
                            reply_bytes = tool_reply(self.pending_function, self.pending_context, reply_payload)
                            writer.queue_data(3, frame(reply_bytes))
                            self.pending_call_id = None
                            self.pending_context = None
                            self.pending_function = None
                            self.pending_tool_name = None
                        except queue.Empty:
                            pass

                        now = time.monotonic()
                        if pending_ping is None and (now - last_rx) >= 15.0:
                            pending_ping = secrets.token_bytes(8)
                            client.ping(pending_ping)

                        writer.drain()
                        outgoing = client.data_to_send()
                        if outgoing:
                            sock.sendall(outgoing)

                        try:
                            data = sock.recv(65536)
                        except socket.timeout:
                            continue
                        except (ssl.SSLEOFError, ConnectionResetError, BrokenPipeError) as e:
                            raise BridgeError("transport_eof", "Transport closed unexpectedly.", 409) from e

                        if not data:
                            raise BridgeError("transport_eof", "Transport EOF received.", 409)

                        last_rx = time.monotonic()
                        for event in client.receive_data(data):
                            sid = getattr(event, "stream_id", None)
                            if sid not in (None, 0, 1, 3) and not isinstance(event, (h2.events.ConnectionTerminated, h2.events.PingAckReceived)):
                                raise BridgeError("unexpected_stream", "Unexpected application stream.", 409)

                            if isinstance(event, (h2.events.ResponseReceived, h2.events.TrailersReceived)):
                                if sid in (1, 3):
                                    stream_headers[sid].update(dict(event.headers))
                                    st = stream_headers[sid].get(":status")
                                    if st is not None and st != "200":
                                        raise BridgeError("rpc_http_error", f"Stream {sid} failed with HTTP status {st}", 409)
                                    grpc_st = stream_headers[sid].get("grpc-status")
                                    if grpc_st is not None and grpc_st != "0":
                                        raise grpc_failure(grpc_st, stream_headers[sid].get("grpc-message", ""))
                            elif isinstance(event, h2.events.DataReceived):
                                if sid in (1, 3):
                                    client.acknowledge_received_data(event.flow_controlled_length, sid)
                                    reader = task_reader if sid == 1 else tool_reader
                                    msgs = reader.feed(event.data)
                                    for msg in msgs:
                                        if sid == 1:
                                            self._handle_task_message(msg, client, writer, tool_headers, tool_subscribed)
                                            if self.conversation and not tool_subscribed:
                                                tool_subscribed = True
                                        else:
                                            self._handle_tool_message(msg, writer)
                            elif isinstance(event, h2.events.StreamEnded):
                                if sid in (1, 3):
                                    # Require accumulated status 200 and grpc-status 0
                                    st = stream_headers[sid].get(":status")
                                    grpc_st = stream_headers[sid].get("grpc-status")
                                    if st != "200":
                                        raise BridgeError("rpc_http_error", f"Stream {sid} ended with invalid HTTP status {st}", 409)
                                    if grpc_st != "0":
                                        raise BridgeError("grpc_error", f"Stream {sid} ended with invalid or missing grpc-status {grpc_st}", 409)

                                    reader = task_reader if sid == 1 else tool_reader
                                    reader.finish()
                                    ended_streams.add(sid)
                            elif isinstance(event, h2.events.WindowUpdated):
                                writer.drain()
                            elif isinstance(event, h2.events.PingAckReceived):
                                if pending_ping is not None and event.ping_data == pending_ping:
                                    pending_ping = None
                            elif isinstance(event, h2.events.StreamReset):
                                if sid in (1, 3):
                                    raise BridgeError("stream_reset", f"Stream {sid} reset by upstream.", 409)
                            elif isinstance(event, h2.events.ConnectionTerminated):
                                if not {1, 3} <= ended_streams:
                                    raise BridgeError("connection_terminated", "Connection terminated by server.", 409)

            if self.pending_call_id is not None:
                raise BridgeError("pending_tool_lost", "Transport ended while a tool call was pending.", 409)

            if self.output.complete:
                self.output.check_route(final=True)
                self.sink.complete(self.output.text)
                return

            self.sink.complete(self._recover_saved_turn(deadline))

        except BridgeError as be:
            self.sink.fail(be)
        except ProtocolError:
            self.sink.fail(BridgeError("native_protocol_error", "Native response failed protocol or model validation.", 409))
        except Exception:
            self.sink.fail(BridgeError("transport_failure", "Native transport encountered a fatal error.", 409))

    def _recover_saved_turn(self, deadline: float) -> str:
        template_path = self.config.data_dir / "source" / "turn-template.bin"
        if not template_path.exists():
            raise BridgeError("incomplete_task", "Stored-turn template is missing.", 409)
        template = template_path.read_bytes()
        read_deadline = min(time.monotonic() + 20.0, deadline)
        while time.monotonic() < read_deadline:
            self._check_active(read_deadline)
            task_headers, _ = self.auth_manager.headers()
            self._check_active(read_deadline)
            headers = [[k, TURN_RPC if k == ":path" else v] for k, v in task_headers]
            try:
                request = turn_request(template, self.conversation)
                _, response = unary(headers, request, rpc_path=TURN_RPC,
                                    timeout=min(15.0, read_deadline - time.monotonic()))
                self._check_active(read_deadline)
                if self.output.feed_saved(response) and self.output.complete:
                    self.output.check_route(final=True)
                    return self.output.text
            except ProtocolError:
                raise BridgeError("native_protocol_error", "Stored turn failed protocol or model validation.", 409) from None
            except BridgeError as error:
                if error.code not in {"transport_eof", "transport_failure", "timeout", "connection_terminated"}:
                    raise
            except (OSError, ssl.SSLError):
                pass  # Read-only retrieval may retry within this one bounded budget.
            if self.stop_event.wait(max(0, min(2.0, read_deadline - time.monotonic()))):
                self._check_active(read_deadline)
        raise BridgeError("incomplete_task", "Task ended without complete final text.", 409)

    def _handle_task_message(
        self,
        msg: bytes,
        client: h2.connection.H2Connection,
        writer: H2Writer,
        tool_headers: list[list[str]],
        tool_subscribed: bool,
    ):
        self.output.feed(msg)
        self.output.check_route(final=False)
        if self.output.conversation and not tool_subscribed:
            self.conversation = self.output.conversation
            client.send_headers(3, tool_headers)
            writer.queue_data(3, frame(pb(1, pb(1, self.conversation))))

    def _handle_tool_message(self, msg: bytes, writer: H2Writer):
        for n, w, v, _ in fields(msg):
            if n == 5 and v:
                if self.conversation and v != self.conversation:
                    raise BridgeError("conversation_mismatch", "Tool conversation mismatch.", 409)
            elif n == 3:
                if self.pending_call_id is not None:
                    raise BridgeError("pending_tool_lost", "Upstream ended tool stream while a tool was pending.", 409)
                writer.queue_data(3, b"", end_stream=True)
            elif n == 2 and w == 2:
                call = one(v, 1)
                func_name_bytes = one(call, 1)
                field2 = one(call, 2)
                payload = decode_struct(one(call, 3))

                if func_name_bytes == b"list_mcp":
                    if payload:
                        raise BridgeError("invalid_list_args", "Unexpected arguments for list_mcp.", 409)
                    ad = self.request.active_catalog.advertisement()
                    reply_bytes = tool_reply(func_name_bytes, field2, ad)
                    writer.queue_data(3, frame(reply_bytes))
                elif func_name_bytes == b"execute_mcp":
                    srv = payload.get("ServerName")
                    tool_name = payload.get("ToolName")
                    args = payload.get("Arguments")
                    if srv != SERVER_NAME:
                        raise BridgeError("invalid_server_name", "Invalid server name in execute_mcp payload.", 409)
                    allowed_keys = {"ServerName", "ToolName", "Arguments", "destructiveHint"}
                    if set(payload.keys()) - allowed_keys:
                        raise BridgeError("unexpected_tool_keys", "Unexpected envelope keys in execute_mcp.", 409)
                    if "destructiveHint" in payload and not isinstance(payload["destructiveHint"], bool):
                        raise BridgeError("invalid_destructive_hint", "destructiveHint must be a boolean.", 409)
                    if not isinstance(tool_name, str) or not isinstance(args, dict):
                        raise BridgeError("invalid_execute_payload", "Malformed execute_mcp payload.", 409)

                    self.request.active_catalog.validate(tool_name, args)

                    if self.pending_call_id is not None:
                        raise BridgeError("unsupported_parallel_call", "Simultaneous parallel tool calls are not supported.", 409)

                    downstream_id = self.sink.tool(tool_name, args)
                    if not downstream_id or self.stop_event.is_set():
                        raise BridgeError("cancelled", "Task is no longer active.", 409)
                    self.pending_call_id = downstream_id
                    self.pending_context = field2
                    self.pending_function = func_name_bytes
                    self.pending_tool_name = tool_name
                else:
                    raise BridgeError("unsupported_native_function", "Unsupported native tool function requested.", 409)
