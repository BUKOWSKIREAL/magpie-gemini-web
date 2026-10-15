"""Validated Gemini 1.128.14.1166 wire paths. No networking or credential I/O."""
from __future__ import annotations

import math
import struct
import uuid
from dataclasses import dataclass
from typing import Any

HOST = "robinfrontend-pa.googleapis.com"
TASK_RPC = "/assistant.mobile.robin.RobinService/ProcessQuery"
TOOLS_RPC = "/assistant.mobile.robin.notify.GeminiNotifyService/ExecuteRemoteTools"
TURN_RPC = "/assistant.mobile.robin.RobinService/ListConversationTurns"
MODEL_ID = "gemini-task-argon"
MODE_ID = "95a4c0abcba24364"
SERVER_NAME = "agent_bridge"
BINARY_SHA256 = "8cd89234b23182234e8e211e1449ae44e0a831b2185e98f4d1371a83c66f8964"
MAX_FRAME = 8 * 1024 * 1024


class ProtocolError(ValueError):
    pass


def varint(data: bytes, offset: int) -> tuple[int, int]:
    value = 0
    for shift in range(0, 70, 7):
        if offset >= len(data):
            raise ProtocolError("truncated_varint")
        byte = data[offset]
        offset += 1
        if shift == 63 and byte > 1:
            raise ProtocolError("varint_overflow")
        value |= (byte & 127) << shift
        if byte < 128:
            return value, offset
    raise ProtocolError("invalid_varint")


def encode_varint(value: int) -> bytes:
    if not isinstance(value, int) or value < 0 or value >= 1 << 64:
        raise ProtocolError("invalid_unsigned_integer")
    out = bytearray()
    while value > 127:
        out.append((value & 127) | 128)
        value >>= 7
    out.append(value)
    return bytes(out)


def fields(data: bytes):
    result = []
    pos = 0
    while pos < len(data):
        start = pos
        key, pos = varint(data, pos)
        number, wire = key >> 3, key & 7
        if not 0 < number < 1 << 29:
            raise ProtocolError("invalid_field_number")
        if wire == 0:
            value, pos = varint(data, pos)
        elif wire in (1, 5, 2):
            if wire == 2:
                size, pos = varint(data, pos)
            else:
                size = 8 if wire == 1 else 4
            if size > len(data) - pos:
                raise ProtocolError("truncated_field")
            value = data[pos:pos + size]
            pos += size
        else:
            raise ProtocolError("unsupported_wire_type")
        result.append((number, wire, value, data[start:pos]))
    return result


def one(data: bytes, number: int):
    found = [v for n, _, v, _ in fields(data) if n == number]
    if len(found) != 1:
        raise ProtocolError("missing_or_repeated_field")
    return found[0]


def optional(data: bytes, number: int, default=None):
    found = [v for n, _, v, _ in fields(data) if n == number]
    if len(found) > 1:
        raise ProtocolError("repeated_scalar_field")
    return found[0] if found else default


def pb(number: int, value: bytes) -> bytes:
    if not isinstance(value, bytes):
        raise ProtocolError("expected_bytes")
    return encode_varint(number * 8 + 2) + encode_varint(len(value)) + value


def replace(data: bytes, path: list[int], value) -> bytes:
    out = []
    found = False
    for number, wire, current, raw in fields(data):
        if number != path[0]:
            out.append(raw)
            continue
        if found:
            raise ProtocolError("repeated_replace_target")
        found = True
        if len(path) > 1:
            if wire != 2:
                raise ProtocolError("expected_nested_message")
            current = replace(current, path[1:], value)
        else:
            current = value
        tag = encode_varint(number * 8 + wire)
        if wire == 0:
            out.append(tag + encode_varint(current))
        elif wire == 2:
            out.append(tag + encode_varint(len(current)) + current)
        else:
            raise ProtocolError("unsupported_replace_type")
    if not found:
        raise ProtocolError("missing_replace_target")
    return b"".join(out)


def frame(message: bytes) -> bytes:
    if len(message) > MAX_FRAME:
        raise ProtocolError("frame_too_large")
    return b"\0" + len(message).to_bytes(4, "big") + message


class FrameReader:
    def __init__(self):
        self.buffer = bytearray()
        self.total = 0

    def feed(self, chunk: bytes) -> list[bytes]:
        self.total += len(chunk)
        if self.total > 32 * 1024 * 1024:
            raise ProtocolError("response_too_large")
        self.buffer.extend(chunk)
        out = []
        while len(self.buffer) >= 5:
            size = int.from_bytes(self.buffer[1:5], "big")
            if self.buffer[0] or size > MAX_FRAME:
                raise ProtocolError("compressed_or_oversized_frame")
            if len(self.buffer) < size + 5:
                break
            out.append(bytes(self.buffer[5:5 + size]))
            del self.buffer[:5 + size]
        return out

    def finish(self):
        if self.buffer:
            raise ProtocolError("truncated_grpc_message")


def messages(data: bytes) -> list[bytes]:
    reader = FrameReader()
    result = reader.feed(data)
    reader.finish()
    return result


def struct_value(value: Any, depth=0) -> bytes:
    if depth > 64:
        raise ProtocolError("struct_too_deep")
    if value is None:
        return b"\x08\x00"
    if isinstance(value, bool):
        return b"\x20" + bytes([int(value)])
    if isinstance(value, (int, float)):
        if not math.isfinite(value) or (float(value).is_integer() and abs(value) > 2**53 - 1):
            raise ProtocolError("unsafe_struct_number")
        return b"\x11" + struct.pack("<d", value)
    if isinstance(value, str):
        return pb(3, value.encode())
    if isinstance(value, dict):
        return pb(5, struct_obj(value, depth + 1))
    if isinstance(value, list):
        return pb(6, b"".join(pb(1, struct_value(v, depth + 1)) for v in value))
    raise ProtocolError("unsupported_struct_value")


def struct_obj(value: dict, depth=0) -> bytes:
    if depth > 64 or not all(isinstance(k, str) for k in value):
        raise ProtocolError("invalid_struct_object")
    return b"".join(pb(1, pb(1, k.encode()) + pb(2, struct_value(v, depth + 1)))
                    for k, v in value.items())


def decode_value(data: bytes, depth=0):
    fs = fields(data)
    if depth > 64 or len(fs) != 1:
        raise ProtocolError("invalid_struct_value")
    n, w, v, _ = fs[0]
    if n == 1 and w == 0 and v == 0:
        return None
    if n == 2 and w == 1:
        number = struct.unpack("<d", v)[0]
        if not math.isfinite(number) or (number.is_integer() and abs(number) > 2**53 - 1):
            raise ProtocolError("unsafe_struct_number")
        return int(number) if number.is_integer() else number
    if n == 3 and w == 2:
        return v.decode()
    if n == 4 and w == 0 and v in (0, 1):
        return bool(v)
    if n == 5 and w == 2:
        return decode_struct(v, depth + 1)
    if n == 6 and w == 2:
        out = []
        for k, wire, item, _ in fields(v):
            if k != 1 or wire != 2:
                raise ProtocolError("invalid_struct_list")
            out.append(decode_value(item, depth + 1))
        return out
    raise ProtocolError("unknown_struct_value")


def decode_struct(data: bytes, depth=0) -> dict:
    if depth > 64:
        raise ProtocolError("struct_too_deep")
    out = {}
    for n, w, item, _ in fields(data):
        if n != 1 or w != 2:
            raise ProtocolError("invalid_struct_entry")
        key = one(item, 1).decode()
        if key in out:
            raise ProtocolError("duplicate_struct_key")
        out[key] = decode_value(one(item, 2), depth + 1)
    return out


def validate_task_template(template: bytes) -> list[bytes]:
    parts = messages(template)
    if len(parts) != 4 or [[n for n, _, _, _ in fields(m)] for m in parts] != [[1000], [1008], [1007], [1007]]:
        raise ProtocolError("unsupported_task_template")
    initial = one(parts[0], 1000)
    generate = one(one(initial, 1001), 1)
    if (one(generate, 26) != 41 or one(generate, 49) != 1 or one(generate, 47) != 8
            or one(one(initial, 1), 16) != MODE_ID.encode()
            or any(one(one(generate, 4), n) for n in (1, 2, 3))):
        raise ProtocolError("template_must_be_fresh_argon_task")
    if one(one(generate, 1), 1) != one(one(parts[2], 1007), 1):
        raise ProtocolError("template_prompt_copies_differ")
    old_id = one(initial, 2)
    if len(old_id) != 38:
        raise ProtocolError("invalid_template_request_id")
    uuid.UUID(old_id[2:].decode())
    return parts


def build_task_request(template: bytes, prompt: str) -> bytes:
    parts = validate_task_template(template)
    old_id = one(one(parts[0], 1000), 2)
    new_id = old_id[:2] + str(uuid.uuid4()).encode()
    parts = [p.replace(old_id, new_id) for p in parts]
    parts[0] = replace(parts[0], [1000, 1001, 1, 1, 1], prompt.encode())
    parts[2] = replace(parts[2], [1007, 1], prompt.encode())
    return b"".join(frame(p) for p in parts)


def validate_headers(headers: list, expected_path: str):
    if not isinstance(headers, list) or not all(isinstance(h, list) and len(h) == 2
            and all(isinstance(v, str) and '\r' not in v and '\n' not in v for v in h) for h in headers):
        raise ProtocolError("invalid_headers")
    h = dict(headers)
    if len(h) != len(headers) or (h.get(":authority"), h.get(":scheme"), h.get(":method"), h.get(":path"),
                                 h.get("content-type")) != (HOST + ":443", "https", "POST", expected_path, "application/grpc"):
        raise ProtocolError("unexpected_rpc_target")
    if expected_path == TASK_RPC and not h.get("x-server-token"):
        raise ProtocolError("missing_server_token")


def turn_request(template: bytes, conversation: bytes) -> bytes:
    parts = messages(template)
    if len(parts) != 1 or not one(parts[0], 1).startswith(b"c_") or one(parts[0], 2) != 100:
        raise ProtocolError("unsupported_turn_template")
    if not conversation.startswith(b"c_") or len(conversation) > 100:
        raise ProtocolError("invalid_conversation")
    return frame(replace(replace(parts[0], [1], conversation), [2], 1))


def tool_reply(function: bytes, context: bytes, payload: dict) -> bytes:
    return pb(2, pb(1, pb(1, function) + pb(2, context) + pb(3, struct_obj(payload))))


@dataclass
class TaskOutput:
    conversation: bytes | None = None
    request: bytes | None = None
    text: str = ""
    completeness: int | None = None
    mode_id: str | None = None
    attribution: str | None = None
    downgrade: int = 0

    def feed(self, message: bytes):
        for n, w, value, _ in fields(message):
            if n == 1014 and w == 2:
                candidate = one(one(value, 1), 1)
                if not candidate.startswith(b"c_") or len(candidate) > 100:
                    raise ProtocolError("invalid_conversation")
                if self.conversation is not None and self.conversation != candidate:
                    raise ProtocolError("conversation_changed")
                self.conversation = candidate
            if n != 1003 or w != 2:
                continue
            for kind, wire, response, _ in fields(value):
                if kind != 1 or wire != 2:
                    continue
                ids = optional(response, 2)
                if ids is not None:
                    c, r = one(ids, 1), one(ids, 2)
                    if c and r:
                        if self.conversation not in (None, c) or self.request not in (None, r):
                            raise ProtocolError("response_identifiers_changed")
                        self.conversation, self.request = c, r
                for field, attr in [(25, "mode_id"), (30, "attribution"), (31, "downgrade")]:
                    v = optional(response, field)
                    if v is not None:
                        setattr(self, attr, v.decode() if isinstance(v, bytes) else v)
                model = optional(response, 1)
                if model is not None:
                    self._model(model)

    def _model(self, model: bytes):
        # Never combine an earlier partial text with a later empty terminal
        # message. A usable terminal snapshot must supply both in one model.
        self.completeness = optional(model, 19)
        self.text = ""
        display = optional(model, 2)
        if display is not None:
            text = optional(display, 1)
            if text is not None:
                self.text = text.decode()

    def feed_saved(self, data: bytes) -> bool:
        if not self.conversation or not self.request:
            raise ProtocolError("missing_response_identifiers")
        found = False
        for message in messages(data):
            for n, w, turn, _ in fields(message):
                if n != 1 or w != 2:
                    continue
                ids = one(turn, 1)
                if (one(ids, 1), one(ids, 2)) != (self.conversation, self.request):
                    continue
                if found:
                    raise ProtocolError("duplicate_saved_turn")
                found = True
                assistant = one(turn, 4)
                self._model(one(assistant, 1))
        return found

    def check_route(self, final=False):
        if self.downgrade or self.mode_id not in (None, MODE_ID):
            raise ProtocolError("upstream_model_changed")
        if final and self.mode_id != MODE_ID:
            raise ProtocolError("upstream_model_unverified")

    @property
    def complete(self) -> bool:
        return self.completeness == 2 and bool(self.text.strip())
