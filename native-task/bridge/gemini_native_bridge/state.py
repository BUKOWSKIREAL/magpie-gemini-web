"""State management, persistence, session snapshots, and ticket lifecycle."""
from __future__ import annotations

import hashlib
import json
import math
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from .config import RuntimeConfig, atomic_write_file
from .contract import BridgeError, CompletionRequest, SESSION, canonical, invalid, json_loads
from .protocol import MODEL_ID
from .transport import NativeTask


def make_tool_response(call_id: str, name: str, args: dict, created: int) -> dict:
    return {
        "id": f"chatcmpl-{secrets.token_hex(12)}",
        "object": "chat.completion",
        "created": created,
        "model": MODEL_ID,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "id": call_id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": canonical(args),
                    },
                }],
            },
            "finish_reason": "tool_calls",
        }],
    }


def make_final_response(text: str, created: int) -> dict:
    return {
        "id": f"chatcmpl-{secrets.token_hex(12)}",
        "object": "chat.completion",
        "created": created,
        "model": MODEL_ID,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": text,
            },
            "finish_reason": "stop",
        }],
    }


class Ticket:
    def __init__(self, task_id: str):
        self.task_id = task_id
        self.event = threading.Event()
        self.response: dict | None = None
        self.error: BridgeError | None = None

    def result(self, timeout: float | None = None) -> dict:
        if not self.event.wait(timeout):
            raise TimeoutError("Ticket timed out waiting for result.")
        if self.error is not None:
            raise self.error
        if self.response is None:
            raise BridgeError("empty_response", "Ticket finished without a response.", 409)
        return self.response


class _TaskSink:
    def __init__(self, manager: Manager, session_id: str, task_id: str):
        self.manager = manager
        self.session_id = session_id
        self.task_id = task_id

    def tool(self, name: str, arguments: dict) -> str:
        return self.manager._on_sink_tool(self.session_id, self.task_id, name, arguments)

    def complete(self, text: str) -> None:
        self.manager._on_sink_complete(self.session_id, self.task_id, text)

    def fail(self, error: BridgeError) -> None:
        self.manager._on_sink_fail(self.session_id, self.task_id, error)


class Manager:
    """Manages Task sessions, persistent snapshots, and ticket dispatch."""

    def __init__(self, config: RuntimeConfig, transport_factory=NativeTask):
        self.config = config
        self.transport_factory = transport_factory
        self.sessions_dir = self.config.data_dir / "sessions"
        self.sessions_dir.mkdir(parents=True, mode=0o700, exist_ok=True)

        self._lock = threading.RLock()
        self._storage_failed = False
        self._closed = False

        self._active_task_id: str | None = None
        self._active_session_id: str | None = None
        self._active_digest: str | None = None
        self._active_request: CompletionRequest | None = None
        self._active_transport: Any = None
        self._active_ticket: Ticket | None = None
        self._task_start_time: float | None = None
        self._pending_deadline: float | None = None

        self._stop_watchdog = threading.Event()
        self._watchdog_thread = threading.Thread(target=self._watchdog_loop, daemon=True, name="ManagerWatchdog")
        self._recover_and_start()

    def _snapshot_path(self, session_id: str) -> Path:
        key = canonical([self.config.instance_id, session_id])
        h = hashlib.sha256(key.encode()).hexdigest()
        return self.sessions_dir / f"{h}.json"

    def _clear_active(self):
        self._active_task_id = None
        self._active_session_id = None
        self._active_digest = None
        self._active_request = None
        self._active_ticket = None
        self._task_start_time = None
        self._pending_deadline = None
        self._active_transport = None

    def _storage_fault(self, error: BridgeError) -> BridgeError:
        self._storage_failed = True
        if self._active_transport is not None:
            try:
                self._active_transport.stop()
            except Exception:
                pass
        ticket = self._active_ticket
        self._clear_active()
        if ticket and not ticket.event.is_set():
            ticket.error = error
            ticket.event.set()
        return error

    def _validate_snapshot(self, data: Any, path: Path, expected_session: str | None = None) -> dict:
        def need(condition):
            if not condition:
                raise BridgeError("state_corrupt", "Session journal failed validation.", 409)

        def ident(value):
            return isinstance(value, str) and SESSION.fullmatch(value) is not None

        def error_record(value):
            if value is not None:
                need(isinstance(value, dict))
                need(isinstance(value.get("code"), str) and bool(value["code"]))
                need(isinstance(value.get("message"), str))
                need(type(value.get("status")) is int and 400 <= value["status"] <= 499)

        def tool_call(value):
            need(isinstance(value, dict) and ident(value.get("id")) and value.get("type") == "function")
            fn = value.get("function")
            need(isinstance(fn, dict) and ident(fn.get("name")) and isinstance(fn.get("arguments"), str))
            args = json_loads(fn["arguments"])
            need(isinstance(args, dict))
            return value["id"], fn["name"], args

        need(isinstance(data, dict) and type(data.get("version")) is int and data["version"] == 1)
        need(data.get("instance_id") == self.config.instance_id and ident(data.get("session_id")))
        session = data["session_id"]
        need(expected_session in (None, session) and self._snapshot_path(session) == path)
        need(ident(data.get("task_id")) and ident(data.get("signature")))
        need(type(data.get("calls")) is int and 0 <= data["calls"] <= self.config.max_tool_calls)
        need(type(data.get("updated_at")) in (int, float) and math.isfinite(data["updated_at"]))
        need(isinstance(data.get("history"), list) and bool(data["history"]))
        for message in data["history"]:
            need(isinstance(message, dict) and message.get("role") in {"system", "developer", "user", "assistant", "tool"})
            need(isinstance(message.get("content"), str))
            if message.get("role") == "tool":
                need(ident(message.get("tool_call_id")))
            if "tool_calls" in message:
                need(message["role"] == "assistant" and isinstance(message["tool_calls"], list) and bool(message["tool_calls"]))
                for call in message["tool_calls"]:
                    tool_call(call)

        need(isinstance(data.get("requests"), dict) and 1 <= len(data["requests"]) <= 256)
        current_records = []
        current_tools = []
        for request_id, record in data["requests"].items():
            need(ident(request_id) and isinstance(record, dict) and ident(record.get("task_id")))
            need("response" in record and "error" in record)
            response, error = record["response"], record["error"]
            need(response is None or error is None)
            error_record(error)
            if record["task_id"] == data["task_id"]:
                current_records.append(record)
            if response is None:
                continue
            need(isinstance(response, dict) and ident(response.get("id")) and response.get("object") == "chat.completion")
            choices = response.get("choices")
            need(isinstance(choices, list) and len(choices) == 1 and isinstance(choices[0], dict))
            choice = choices[0]
            need(type(choice.get("index")) is int and choice["index"] == 0)
            message = choice.get("message")
            need(isinstance(message, dict) and message.get("role") == "assistant")
            if choice.get("finish_reason") == "tool_calls":
                calls = message.get("tool_calls")
                need(isinstance(calls, list) and len(calls) == 1)
                details = tool_call(calls[0])
                if record["task_id"] == data["task_id"]:
                    current_tools.append(details)
            else:
                need(choice.get("finish_reason") == "stop" and isinstance(message.get("content"), str) and bool(message["content"].strip()))
        need(bool(current_records))
        need("error" in data and "pending" in data)
        error_record(data["error"])
        status = data.get("status")
        need(status in {"running", "waiting_for_tool", "complete", "failed", "abandoned", "interrupted"})
        if status == "waiting_for_tool":
            pending = data["pending"]
            need(isinstance(pending, dict) and ident(pending.get("id")) and ident(pending.get("name")))
            need(isinstance(pending.get("arguments"), dict))
            need(type(pending.get("received_at")) in (int, float) and math.isfinite(pending["received_at"]))
            last = data["history"][-1]
            need(last.get("role") == "assistant" and len(last.get("tool_calls", [])) == 1)
            details = (pending["id"], pending["name"], pending["arguments"])
            need(tool_call(last["tool_calls"][0]) == details and details in current_tools)
        else:
            need(data["pending"] is None)
        if status == "running":
            need(any(r["response"] is None and r["error"] is None for r in current_records))
        if status in {"running", "waiting_for_tool", "complete"}:
            need(data["error"] is None)
        else:
            need(data["error"] is not None)
        return data

    def _load_snapshot(self, session_id: str) -> dict | None:
        path = self._snapshot_path(session_id)
        if not path.exists():
            if self._active_session_id == session_id:
                raise self._storage_fault(BridgeError("state_corrupt", "Active session snapshot disappeared.", 409))
            return None

        try:
            raw_text = path.read_text(encoding="utf-8")
            data = json_loads(raw_text)
            return self._validate_snapshot(data, path, expected_session=session_id)
        except BridgeError as be:
            raise self._storage_fault(be)
        except Exception as e:
            raise self._storage_fault(BridgeError("state_corrupt", "Session journal cannot be read or validated.", 409)) from e

    def _save_snapshot(self, snapshot: dict):
        if self._storage_failed:
            raise BridgeError("state_storage_failed", "Storage is in a failed state.", 409)

        session_id = snapshot["session_id"]
        path = self._snapshot_path(session_id)
        data = json.dumps(snapshot, indent=2).encode()
        try:
            atomic_write_file(path, data, mode=0o600)
        except Exception as e:
            raise self._storage_fault(BridgeError("state_storage_failed", "Session journal could not be persisted.", 409)) from e

    def _record_terminal_error(self, snapshot: dict, error: BridgeError, status: str):
        snapshot["status"] = status
        snapshot["pending"] = None
        snapshot["error"] = {"code": error.code, "message": error.message, "status": error.status}
        snapshot["updated_at"] = time.time()
        for record in snapshot.get("requests", {}).values():
            if record.get("task_id") == snapshot.get("task_id") and record.get("response") is None and record.get("error") is None:
                record["error"] = dict(snapshot["error"])

    def _recover_and_start(self):
        with self._lock:
            # 1. Validate all files and filename bindings first
            validated = []
            for p in self.sessions_dir.glob("*.json"):
                try:
                    raw = p.read_text(encoding="utf-8")
                    data = json_loads(raw)
                    snap = self._validate_snapshot(data, p)
                    validated.append((p, snap))
                except Exception as e:
                    self._storage_failed = True
                    raise BridgeError("state_corrupt", f"Corrupt snapshot found on startup: {p}", 409) from e

            # 2. Record interruption on any active snapshot
            for p, snap in validated:
                if snap.get("status") in ("running", "waiting_for_tool"):
                    interr_err = BridgeError("interrupted", "Task interrupted on daemon restart.", 409)
                    self._record_terminal_error(snap, interr_err, "interrupted")
                    atomic_write_file(p, json.dumps(snap, indent=2).encode(), mode=0o600)

        self._watchdog_thread.start()

    def submit(self, session_id: str, request: CompletionRequest) -> Ticket:
        if not isinstance(session_id, str) or not SESSION.fullmatch(session_id):
            raise invalid("invalid_session_id", "Session ID must be 1-256 non-whitespace ASCII characters.")

        with self._lock:
            if self._closed:
                raise BridgeError("service_stopped", "Bridge service is closed.", 409)
            if self._storage_failed:
                raise BridgeError("state_storage_failed", "Storage is in a failed state.", 409)

            # Enforce total deadline of existing active task if any
            now = time.monotonic()
            if self._task_start_time is not None and now - self._task_start_time >= self.config.task_timeout:
                if self._active_session_id and self._active_task_id:
                    err = BridgeError("task_timeout", f"Task exceeded budget of {self.config.task_timeout}s.", 409)
                    self._on_sink_fail(self._active_session_id, self._active_task_id, err)

            snapshot = self._load_snapshot(session_id)

            if snapshot is None:
                # New session
                if request.messages[-1]["role"] == "tool":
                    raise BridgeError("unknown_task", "Cannot submit a tool result to an unknown session.", 409)
                if request.messages[-1]["role"] != "user":
                    raise invalid("invalid_initial_message", "A new session must end in a user message.")

                existing_count = len(list(self.sessions_dir.glob("*.json")))
                if existing_count >= 128:
                    raise BridgeError("session_capacity", "Maximum stored sessions reached (128).", 409)

                if self._active_task_id is not None:
                    raise BridgeError("concurrency_limit", "Another native task is currently active.", 409)

                task_id = "task_" + secrets.token_hex(12)
                snapshot = {
                    "version": 1,
                    "session_id": session_id,
                    "instance_id": self.config.instance_id,
                    "task_id": task_id,
                    "status": "running",
                    "signature": request.signature,
                    "history": request.messages,
                    "pending": None,
                    "calls": 0,
                    "error": None,
                    "requests": {
                        request.digest: {
                            "task_id": task_id,
                            "response": None,
                            "error": None,
                        }
                    },
                    "updated_at": time.time(),
                }
                self._save_snapshot(snapshot)

                ticket = Ticket(task_id)
                self._active_task_id = task_id
                self._active_session_id = session_id
                self._active_digest = request.digest
                self._active_request = request
                self._active_ticket = ticket
                self._task_start_time = time.monotonic()
                self._pending_deadline = None

                sink = _TaskSink(self, session_id, task_id)
                try:
                    self._active_transport = self.transport_factory(self.config, request, sink)
                    self._active_transport.start()
                except Exception as e:
                    err = BridgeError("startup_failed", "Failed to start native transport.", 409)
                    self._on_sink_fail(session_id, task_id, err)
                    raise err from e

                return ticket

            # Existing session
            if len(snapshot.get("requests", {})) >= 256 and request.digest not in snapshot.get("requests", {}):
                raise BridgeError("session_capacity", "Session request capacity reached (256). Open a new session.", 409)

            # Check cached request
            req_record = snapshot.get("requests", {}).get(request.digest)
            if req_record is not None:
                if req_record.get("response") is not None:
                    cached_resp = req_record["response"]
                    finish_reason = cached_resp["choices"][0]["finish_reason"]
                    if finish_reason == "tool_calls":
                        call_id = cached_resp["choices"][0]["message"]["tool_calls"][0]["id"]
                        # Enforce deadlines before returning cached tool call
                        if self._pending_deadline is not None and time.monotonic() >= self._pending_deadline:
                            err = BridgeError("tool_timeout", "Tool deadline expired.", 409)
                            self._on_sink_fail(session_id, snapshot["task_id"], err)
                            raise err

                        if (
                            snapshot["status"] == "waiting_for_tool"
                            and snapshot["pending"]
                            and snapshot["pending"]["id"] == call_id
                        ):
                            t = Ticket(req_record["task_id"])
                            t.response = cached_resp
                            t.event.set()
                            return t
                        else:
                            raise BridgeError(
                                "stale_tool_phase",
                                "Cached tool-call response cannot be replayed after the tool phase has advanced or ended.",
                                410,
                            )
                    else:
                        t = Ticket(req_record["task_id"])
                        t.response = cached_resp
                        t.event.set()
                        return t

                elif req_record.get("error") is not None:
                    err = req_record["error"]
                    raise BridgeError(err["code"], err["message"], err.get("status", 409))
                else:
                    raise BridgeError("request_in_progress", "An identical request is already in progress.", 409)

            # Check if this is a tool result
            if request.messages[-1]["role"] == "tool":
                if snapshot["status"] != "waiting_for_tool" or not snapshot["pending"]:
                    raise BridgeError("unexpected_tool_result", "Session is not waiting for a tool result.", 409)

                # Deadline check before accepting tool result
                if self._pending_deadline is not None and time.monotonic() >= self._pending_deadline:
                    err = BridgeError("tool_timeout", f"Tool response exceeded deadline ({self.config.tool_timeout}s).", 409)
                    self._on_sink_fail(session_id, snapshot["task_id"], err)
                    raise err

                if request.signature != snapshot["signature"]:
                    raise BridgeError("signature_mismatch", "Request signature changed during active task.", 409)
                if request.messages[:-1] != snapshot["history"]:
                    raise BridgeError("history_mismatch", "History prefix does not match active task history.", 409)

                tool_msg = request.messages[-1]
                if tool_msg["tool_call_id"] != snapshot["pending"]["id"]:
                    raise BridgeError(
                        "tool_call_id_mismatch",
                        "Submitted tool result ID does not match the pending call.",
                        409,
                    )

                if (
                    self._active_task_id != snapshot["task_id"]
                    or self._active_session_id != session_id
                    or self._active_transport is None
                ):
                    err = BridgeError("interrupted", "Task was interrupted and cannot be resumed.", 409)
                    self._on_sink_fail(session_id, snapshot["task_id"], err)
                    raise err

                pending_call_id = snapshot["pending"]["id"]
                tool_text = tool_msg["content"]

                snapshot["history"].append(tool_msg)
                snapshot["pending"] = None
                snapshot["status"] = "running"
                snapshot["updated_at"] = time.time()
                snapshot["requests"][request.digest] = {
                    "task_id": snapshot["task_id"],
                    "response": None,
                    "error": None,
                }
                self._save_snapshot(snapshot)

                ticket = Ticket(snapshot["task_id"])
                self._active_ticket = ticket
                self._active_digest = request.digest
                self._pending_deadline = None

                try:
                    self._active_transport.submit_result(pending_call_id, tool_text)
                except Exception as e:
                    err = BridgeError("transport_failure", "Failed to submit tool result to transport.", 409)
                    self._on_sink_fail(session_id, snapshot["task_id"], err)
                    raise err from e

                return ticket

            else:
                # New user turn
                if snapshot["status"] in ("running", "waiting_for_tool"):
                    raise BridgeError("session_busy", "Session is currently busy with an active task.", 409)

                stored_history = snapshot["history"]
                incoming_history = request.messages
                if len(incoming_history) <= len(stored_history) or incoming_history[:len(stored_history)] != stored_history:
                    raise BridgeError("history_diverged", "Incoming history does not match stored history prefix; open a new session.", 409)
                if incoming_history[-1]["role"] != "user":
                    raise invalid("invalid_continuation", "Appended continuation message must be a user turn.")

                if self._active_task_id is not None:
                    raise BridgeError("concurrency_limit", "Another native task is currently active.", 409)

                new_task_id = "task_" + secrets.token_hex(12)
                snapshot["task_id"] = new_task_id
                snapshot["status"] = "running"
                snapshot["signature"] = request.signature
                snapshot["history"] = request.messages
                snapshot["pending"] = None
                snapshot["error"] = None
                snapshot["calls"] = 0
                snapshot["updated_at"] = time.time()
                snapshot["requests"][request.digest] = {
                    "task_id": new_task_id,
                    "response": None,
                    "error": None,
                }
                self._save_snapshot(snapshot)

                ticket = Ticket(new_task_id)
                self._active_task_id = new_task_id
                self._active_session_id = session_id
                self._active_digest = request.digest
                self._active_request = request
                self._active_ticket = ticket
                self._task_start_time = time.monotonic()
                self._pending_deadline = None

                sink = _TaskSink(self, session_id, new_task_id)
                try:
                    self._active_transport = self.transport_factory(self.config, request, sink)
                    self._active_transport.start()
                except Exception as e:
                    err = BridgeError("startup_failed", "Failed to start native transport.", 409)
                    self._on_sink_fail(session_id, new_task_id, err)
                    raise err from e

                return ticket

    def _on_sink_tool(self, session_id: str, task_id: str, name: str, arguments: dict) -> str:
        with self._lock:
            # 1. Stale callback check
            if self._closed or task_id != self._active_task_id or session_id != self._active_session_id:
                return ""

            snapshot = self._load_snapshot(session_id)
            if snapshot is None or snapshot["task_id"] != task_id:
                return ""

            # Check deadline before tool publication
            now = time.monotonic()
            if self._task_start_time is not None and now - self._task_start_time >= self.config.task_timeout:
                err = BridgeError("task_timeout", f"Task exceeded budget of {self.config.task_timeout}s.", 409)
                self._on_sink_fail(session_id, task_id, err)
                raise err

            # 2. Status check
            if snapshot["status"] != "running" or snapshot.get("pending") is not None:
                error = BridgeError("unsupported_parallel_call", "A tool is already pending.", 409)
                self._on_sink_fail(session_id, task_id, error)
                raise error

            # 3. Active catalog validation
            if self._active_request is None:
                error = BridgeError("missing_request", "Active request missing.", 409)
                self._on_sink_fail(session_id, task_id, error)
                raise error

            try:
                self._active_request.active_catalog.validate(name, arguments)
            except Exception:
                err = BridgeError("invalid_upstream_arguments", "The upstream tool arguments do not satisfy the supplied JSON Schema.", 409)
                self._on_sink_fail(session_id, task_id, err)
                raise err

            # 4. Capacity check
            if len(snapshot.get("requests", {})) >= 256:
                error = BridgeError("session_capacity", "Open a new session before another tool phase.", 409)
                self._on_sink_fail(session_id, task_id, error)
                raise error

            snapshot["calls"] += 1
            if snapshot["calls"] > self.config.max_tool_calls:
                err = BridgeError("max_tool_calls_exceeded", f"Exceeded maximum tool calls ({self.config.max_tool_calls}).", 409)
                self._on_sink_fail(session_id, task_id, err)
                raise err

            call_id = "call_" + secrets.token_hex(12)
            resp = make_tool_response(call_id, name, arguments, int(time.time()))

            snapshot["history"].append({
                "role": "assistant",
                "content": "",
                "tool_calls": resp["choices"][0]["message"]["tool_calls"],
            })
            snapshot["pending"] = {
                "id": call_id,
                "name": name,
                "arguments": arguments,
                "received_at": time.time(),
            }
            snapshot["status"] = "waiting_for_tool"
            snapshot["updated_at"] = time.time()

            digest = self._active_digest
            if digest and digest in snapshot["requests"]:
                snapshot["requests"][digest]["response"] = resp

            # Save state BEFORE publishing ticket!
            self._save_snapshot(snapshot)

            self._pending_deadline = time.monotonic() + self.config.tool_timeout

            ticket = self._active_ticket
            if ticket and not ticket.event.is_set():
                ticket.response = resp
                ticket.event.set()

            return call_id

    def _on_sink_complete(self, session_id: str, task_id: str, text: str) -> None:
        with self._lock:
            if self._closed or task_id != self._active_task_id or session_id != self._active_session_id:
                return

            snapshot = self._load_snapshot(session_id)
            if snapshot is None or snapshot["task_id"] != task_id:
                return

            now = time.monotonic()
            if self._task_start_time is not None and now - self._task_start_time >= self.config.task_timeout:
                error = BridgeError("task_timeout", f"Task exceeded budget of {self.config.task_timeout}s.", 409)
                self._on_sink_fail(session_id, task_id, error)
                return

            if snapshot["status"] != "running" or snapshot.get("pending") is not None or not text or not text.strip():
                error = BridgeError("incomplete_task", "Invalid completion state.", 409)
                self._on_sink_fail(session_id, task_id, error)
                return

            resp = make_final_response(text, int(time.time()))
            snapshot["history"].append(resp["choices"][0]["message"])
            snapshot["status"] = "complete"
            snapshot["pending"] = None
            snapshot["error"] = None
            snapshot["updated_at"] = time.time()

            digest = self._active_digest
            if digest and digest in snapshot["requests"]:
                snapshot["requests"][digest]["response"] = resp

            # Save BEFORE publishing
            self._save_snapshot(snapshot)

            ticket = self._active_ticket
            self._clear_active()

            if ticket and not ticket.event.is_set():
                ticket.response = resp
                ticket.event.set()

    def _on_sink_fail(self, session_id: str, task_id: str, error: BridgeError) -> None:
        with self._lock:
            if task_id != self._active_task_id or session_id != self._active_session_id:
                return

            snapshot = None
            try:
                snapshot = self._load_snapshot(session_id)
            except Exception:
                pass

            if snapshot is not None and snapshot["task_id"] == task_id:
                if snapshot["status"] != "complete":
                    self._record_terminal_error(snapshot, error, "failed")
                    try:
                        self._save_snapshot(snapshot)
                    except Exception:
                        pass

            if self._active_transport is not None:
                try:
                    self._active_transport.stop()
                except Exception:
                    pass

            ticket = self._active_ticket
            self._clear_active()

            if ticket and not ticket.event.is_set():
                ticket.error = error
                ticket.event.set()

    def abandon_delivery(self, session_id: str, task_id: str, request_digest: str):
        """Conditionally abandon active delivery if session, task, and digest match current request."""
        with self._lock:
            if (
                self._active_session_id == session_id
                and self._active_task_id == task_id
                and self._active_digest == request_digest
            ):
                self.cancel(session_id)

    def status(self, session_id: str) -> dict:
        if not isinstance(session_id, str) or not SESSION.fullmatch(session_id):
            raise invalid("invalid_session_id", "Session ID must be 1-256 non-whitespace ASCII characters.")

        with self._lock:
            snap = self._load_snapshot(session_id)
            if snap is None:
                raise BridgeError("session_not_found", "Session not found.", 404)
            return {
                "session_id": snap["session_id"],
                "instance_id": self.config.instance_id,
                "status": snap["status"],
                "task_id": snap["task_id"],
                "calls": snap.get("calls", 0),
                "pending_tool": snap["pending"]["id"] if snap.get("pending") else None,
                "pending_tool_name": snap["pending"]["name"] if snap.get("pending") else None,
            }

    def cancel(self, session_id: str) -> dict:
        if not isinstance(session_id, str) or not SESSION.fullmatch(session_id):
            raise invalid("invalid_session_id", "Session ID must be 1-256 non-whitespace ASCII characters.")

        with self._lock:
            snap = self._load_snapshot(session_id)
            if snap is None:
                raise BridgeError("session_not_found", "Session not found.", 404)

            task_id = snap["task_id"]
            if snap["status"] in ("complete", "failed", "abandoned", "interrupted"):
                return {"status": snap["status"], "native_cancel_confirmed": False}

            cancel_err = BridgeError("cancelled", "Task locally abandoned.", 409)
            ticket = self._active_ticket if self._active_task_id == task_id else None
            transport = self._active_transport if self._active_task_id == task_id else None
            self._record_terminal_error(snap, cancel_err, "abandoned")
            try:
                self._save_snapshot(snap)
            finally:
                if transport is not None:
                    transport.stop()
            if self._active_task_id == task_id:
                self._clear_active()
            if ticket and not ticket.event.is_set():
                ticket.error = cancel_err
                ticket.event.set()
            return {"status": "abandoned", "native_cancel_confirmed": False}

    def close(self) -> None:
        with self._lock:
            self._closed = True

        self._stop_watchdog.set()
        if self._watchdog_thread.is_alive():
            self._watchdog_thread.join(timeout=2.0)

        with self._lock:
            if self._active_transport is not None:
                try:
                    self._active_transport.stop()
                except Exception:
                    pass

            if self._active_session_id and self._active_task_id:
                snap = None
                try:
                    snap = self._load_snapshot(self._active_session_id)
                except Exception:
                    pass
                if snap and snap["status"] in ("running", "waiting_for_tool"):
                    close_err = BridgeError("service_stopped", "Bridge service closed.", 409)
                    self._record_terminal_error(snap, close_err, "abandoned")
                    try:
                        self._save_snapshot(snap)
                    except Exception:
                        pass

            ticket = self._active_ticket
            self._clear_active()

            if ticket and not ticket.event.is_set():
                ticket.error = BridgeError("service_stopped", "Bridge service closed.", 409)
                ticket.event.set()

    def _watchdog_loop(self):
        while not self._stop_watchdog.wait(0.2):
            with self._lock:
                if self._closed or self._storage_failed:
                    continue
                if self._active_task_id is None:
                    continue
                task_id = self._active_task_id
                session_id = self._active_session_id
                if not session_id:
                    continue

                now = time.monotonic()
                if self._task_start_time is not None and now - self._task_start_time >= self.config.task_timeout:
                    err = BridgeError("task_timeout", f"Task exceeded budget of {self.config.task_timeout}s.", 409)
                    self._on_sink_fail(session_id, task_id, err)
                    continue

                if self._pending_deadline is not None and now >= self._pending_deadline:
                    err = BridgeError(
                        "tool_timeout",
                        f"Tool response exceeded deadline ({self.config.tool_timeout}s).",
                        409,
                    )
                    self._on_sink_fail(session_id, task_id, err)
