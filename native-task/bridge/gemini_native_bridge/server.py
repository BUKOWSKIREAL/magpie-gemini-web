"""HTTP server implementing local OpenAI-compatible endpoints."""
from __future__ import annotations

import hmac
import json
import re
import socket
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .config import RuntimeConfig
from .contract import BridgeError, MAX_REQUEST_BYTES, json_loads, parse_request
from .protocol import MODEL_ID
from .state import Manager

DIGITS = re.compile(r"^[0-9]+$")


class BridgeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        if hasattr(self, "connection") and hasattr(self.connection, "settimeout"):
            self.connection.settimeout(15.0)

    def log_message(self, format: str, *args: Any):
        pass

    @property
    def server_instance(self) -> BridgeServer:
        return self.server  # type: ignore

    def _send_error_json(self, status: int, code: str, message: str, sign_in_kept: bool = True):
        body = json.dumps({
            "error": {
                "code": code,
                "type": "invalid_request_error" if status < 500 else "api_error",
                "message": message,
                "param": None,
            }
        }).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            if sign_in_kept:
                self.send_header("X-Magpie-Sign-In", "kept")
            else:
                self.send_header("X-Magpie-Sign-In", "expired")
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def _check_auth(self) -> bool:
        auth_hdrs = self.headers.get_all("Authorization")
        if not auth_hdrs or len(auth_hdrs) > 1:
            self._send_error_json(401, "unauthorized", "Missing or duplicate Authorization header.", sign_in_kept=False)
            return False

        auth_hdr = auth_hdrs[0]
        if not auth_hdr.startswith("Bearer "):
            self._send_error_json(401, "unauthorized", "Authorization header must use Bearer scheme.", sign_in_kept=False)
            return False

        token = auth_hdr[7:].strip()
        expected = self.server_instance.config.api_key
        if not hmac.compare_digest(token.encode("utf-8"), expected.encode("utf-8")):
            self._send_error_json(401, "unauthorized", "Invalid local API key.", sign_in_kept=False)
            return False
        return True

    def _read_body_json(self) -> dict | None:
        te_hdrs = self.headers.get_all("Transfer-Encoding")
        if te_hdrs:
            self._send_error_json(400, "unsupported_transfer_encoding", "Transfer-Encoding is not supported.")
            return None

        cl_hdrs = self.headers.get_all("Content-Length")
        if not cl_hdrs:
            self._send_error_json(400, "missing_content_length", "Content-Length header is required.")
            return None
        if len(cl_hdrs) > 1:
            self._send_error_json(400, "duplicate_content_length", "Duplicate Content-Length headers are not permitted.")
            return None

        cl_str = cl_hdrs[0].strip()
        if len(cl_str) > 7:
            self._send_error_json(400, "request_too_large", f"Content-Length exceeds {MAX_REQUEST_BYTES} bytes limit.")
            return None

        if not DIGITS.fullmatch(cl_str):
            self._send_error_json(400, "invalid_content_length", "Content-Length must be an unsigned integer.")
            return None

        length = int(cl_str)
        if length > MAX_REQUEST_BYTES:
            self._send_error_json(400, "request_too_large", f"Content-Length exceeds {MAX_REQUEST_BYTES} bytes limit.")
            return None

        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                self._send_error_json(400, "truncated_body", "Request body was truncated.")
                return None
            parsed = json_loads(raw.decode("utf-8"))
            if parsed is None or not isinstance(parsed, dict):
                self._send_error_json(400, "invalid_json", "Request body must be valid JSON.")
                return None
            return parsed
        except UnicodeError:
            self._send_error_json(400, "invalid_utf8", "Request body must be valid UTF-8.")
            return None
        except Exception:
            self._send_error_json(400, "invalid_json", "Request body must be valid JSON.")
            return None

    def do_GET(self):
        if not self._check_auth():
            return

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/health":
            body = json.dumps({
                "service": "gemini-native-task",
                "version": "0.1.0",
                "instance_id": self.server_instance.config.instance_id,
                "active_tasks": 1 if self.server_instance.manager._active_task_id else 0,
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
            return

        if path == "/v1/models":
            body = json.dumps({
                "object": "list",
                "data": [{
                    "id": MODEL_ID,
                    "object": "model",
                    "created": self.server_instance.created_time,
                    "owned_by": "gemini-native-task",
                }],
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
            return

        if path.startswith("/v1/native/sessions/"):
            raw_session = path[len("/v1/native/sessions/"):]
            session_id = urllib.parse.unquote(raw_session)
            try:
                status_data = self.server_instance.manager.status(session_id)
                body = json.dumps(status_data).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)
                self.wfile.flush()
            except BridgeError as be:
                self._send_error_json(be.status, be.code, be.message)
            return

        self._send_error_json(404, "not_found", f"Path {path} not found.")

    def do_POST(self):
        if not self._check_auth():
            return

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/v1/native/shutdown":
            body_dict = self._read_body_json()
            if body_dict is None:
                return

            body = json.dumps({"status": "shutting_down"}).encode("utf-8")
            self.send_response(202)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
            threading.Thread(target=self.server_instance.stop, daemon=True).start()
            return

        if path.startswith("/v1/native/sessions/") and path.endswith("/cancel"):
            raw_session = path[len("/v1/native/sessions/"):-len("/cancel")]
            session_id = urllib.parse.unquote(raw_session)
            body_dict = self._read_body_json()
            if body_dict is None:
                return

            try:
                res = self.server_instance.manager.cancel(session_id)
                body = json.dumps(res).encode("utf-8")
                self.send_response(202)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)
                self.wfile.flush()
            except BridgeError as be:
                self._send_error_json(be.status, be.code, be.message)
            return

        if path == "/v1/chat/completions":
            gemini_sessions = self.headers.get_all("X-Gemini-Session") or []
            magpie_sessions = self.headers.get_all("X-Magpie-Session") or []

            if len(gemini_sessions) > 1 or len(magpie_sessions) > 1:
                self._send_error_json(400, "duplicate_session_header", "Duplicate session headers provided.")
                return

            sess_gemini = gemini_sessions[0] if gemini_sessions else None
            sess_magpie = magpie_sessions[0] if magpie_sessions else None

            if sess_gemini and sess_magpie and sess_gemini != sess_magpie:
                self._send_error_json(400, "session_header_conflict", "X-Gemini-Session and X-Magpie-Session must match.")
                return

            session_id = sess_gemini or sess_magpie
            if not session_id:
                self._send_error_json(400, "missing_session", "Provide a stable session ID via X-Gemini-Session header.")
                return

            body_dict = self._read_body_json()
            if body_dict is None:
                return

            try:
                comp_req = parse_request(body_dict)
                ticket = self.server_instance.manager.submit(session_id, comp_req)
            except BridgeError as be:
                self._send_error_json(be.status, be.code, be.message)
                return
            except Exception:
                self._send_error_json(409, "submission_failed", "Failed to submit completion request.")
                return

            if not comp_req.stream:
                try:
                    result = ticket.result(timeout=self.server_instance.config.task_timeout)
                    resp_bytes = json.dumps(result, ensure_ascii=False).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(resp_bytes)))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(resp_bytes)
                    self.wfile.flush()
                except BridgeError as be:
                    self._send_error_json(be.status, be.code, be.message)
                except TimeoutError:
                    self.server_instance.manager.abandon_delivery(session_id, ticket.task_id, comp_req.digest)
                    self._send_error_json(409, "task_timeout", "Task timed out waiting for completion.")
                except (BrokenPipeError, ConnectionResetError, OSError):
                    self.server_instance.manager.abandon_delivery(session_id, ticket.task_id, comp_req.digest)
                except Exception:
                    self._send_error_json(409, "execution_failed", "Task execution failed.")
                return

            # Streaming response (SSE)
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.send_header("X-Magpie-Sign-In", "kept")
                self.end_headers()
            except (BrokenPipeError, ConnectionResetError, OSError):
                self.server_instance.manager.abandon_delivery(session_id, ticket.task_id, comp_req.digest)
                return

            disconnected = False
            stream_deadline = time.monotonic() + self.server_instance.config.task_timeout
            interval = self.server_instance.heartbeat_interval

            while not ticket.event.wait(timeout=interval):
                if time.monotonic() >= stream_deadline:
                    self.server_instance.manager.abandon_delivery(session_id, ticket.task_id, comp_req.digest)
                    try:
                        err_chunk = f"data: {json.dumps({'error': {'code': 'task_timeout', 'type': 'api_error', 'message': 'Task timed out.'}})}\n\ndata: [DONE]\n\n".encode("utf-8")
                        self.wfile.write(err_chunk)
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError, OSError):
                        pass
                    return

                try:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    disconnected = True
                    break

            if disconnected:
                self.server_instance.manager.abandon_delivery(session_id, ticket.task_id, comp_req.digest)
                return

            if ticket.error is not None:
                err_chunk = f"data: {json.dumps(ticket.error.body())}\n\ndata: [DONE]\n\n".encode("utf-8")
                try:
                    self.wfile.write(err_chunk)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    self.server_instance.manager.abandon_delivery(session_id, ticket.task_id, comp_req.digest)
                return

            resp = ticket.response
            if resp is None:
                err_chunk = f"data: {json.dumps({'error': {'code': 'no_response', 'type': 'api_error', 'message': 'Empty ticket response.'}})}\n\ndata: [DONE]\n\n".encode("utf-8")
                try:
                    self.wfile.write(err_chunk)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    self.server_instance.manager.abandon_delivery(session_id, ticket.task_id, comp_req.digest)
                return

            resp_id = resp["id"]
            created = resp["created"]
            choice = resp["choices"][0]
            finish_reason = choice["finish_reason"]
            msg = choice["message"]

            chunks = [
                {
                    "id": resp_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": MODEL_ID,
                    "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
                }
            ]

            if msg.get("tool_calls"):
                tc = msg["tool_calls"][0]
                chunks.append({
                    "id": resp_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": MODEL_ID,
                    "choices": [{
                        "index": 0,
                        "delta": {
                            "tool_calls": [{
                                "index": 0,
                                "id": tc["id"],
                                "type": "function",
                                "function": {
                                    "name": tc["function"]["name"],
                                    "arguments": tc["function"]["arguments"],
                                },
                            }]
                        },
                        "finish_reason": None,
                    }],
                })
            elif msg.get("content"):
                chunks.append({
                    "id": resp_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": MODEL_ID,
                    "choices": [{"index": 0, "delta": {"content": msg["content"]}, "finish_reason": None}],
                })

            chunks.append({
                "id": resp_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": MODEL_ID,
                "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}],
            })

            try:
                for chunk in chunks:
                    self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8"))
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                self.server_instance.manager.abandon_delivery(session_id, ticket.task_id, comp_req.digest)
            return

        self._send_error_json(404, "not_found", f"Path {path} not found.")


class BridgeServer(ThreadingHTTPServer):
    def __init__(
        self,
        config: RuntimeConfig,
        manager: Manager | None = None,
        bind_port: int | None = None,
        heartbeat_interval: float = 10.0,
    ):
        self.config = config
        self.manager = manager or Manager(config)
        self.created_time = int(time.time())
        self.heartbeat_interval = heartbeat_interval
        self._stopped_event = threading.Event()
        self._stop_lock = threading.Lock()
        port = config.port if bind_port is None else bind_port
        super().__init__(("127.0.0.1", port), BridgeHandler)
        self.port = self.server_address[1]

    def handle_error(self, request, client_address):
        # Override to prevent emitting tracebacks to stdout/stderr
        pass

    def stop(self):
        with self._stop_lock:
            if self._stopped_event.is_set():
                return
            self._stopped_event.set()
        try:
            self.manager.close()
        finally:
            self.shutdown()
            self.server_close()
