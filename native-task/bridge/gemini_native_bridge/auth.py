"""Authentication management, credential renewal, and header injection."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import threading
import time
from pathlib import Path

from .config import RuntimeConfig, atomic_write_file
from .contract import BridgeError
from .oauth import extract_client, read_credential, refresh_access
from .protocol import TASK_RPC, TOOLS_RPC, validate_headers


class AuthManager:
    def __init__(self, config: RuntimeConfig):
        self.config = config
        self._lock = threading.Lock()
        self.source_dir = self.config.data_dir / "source"
        self.cache_file = self.config.data_dir / "token-cache.json"

    def _read_cache(self) -> dict | None:
        if not self.cache_file.exists():
            return None
        try:
            data = json.loads(self.cache_file.read_text(encoding="utf-8"))
        except Exception as e:
            raise BridgeError("corrupt_cache", "Token cache cannot be decoded.", 409) from e

        if not isinstance(data, dict):
            raise BridgeError("corrupt_cache", "Token cache is corrupt.", 409)

        # Well-formed cache with wrong or missing identity is a terminal account_mismatch before read_credential
        if data.get("subject_sha256") != self.config.subject_sha256:
            raise BridgeError("account_mismatch", "Token cache account binding is missing or mismatched.", 409)

        expires_at_raw = data.get("expires_at")
        if not isinstance(expires_at_raw, (int, float)) or isinstance(expires_at_raw, bool) or not math.isfinite(expires_at_raw):
            return None

        expires_at = float(expires_at_raw)
        if expires_at <= time.time() + 300:
            return None

        if not isinstance(data.get("access_token"), str) or not data["access_token"]:
            return None

        return data

    def _read_prior_rotation(self) -> str | None:
        if not self.cache_file.exists():
            return None
        try:
            data = json.loads(self.cache_file.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                return None
            if data.get("subject_sha256") != self.config.subject_sha256:
                raise BridgeError("account_mismatch", "Token cache account binding is missing or mismatched.", 409)
            rot = data.get("rotated_refresh_token")
            if isinstance(rot, str) and rot.startswith("1//"):
                return rot
        except BridgeError:
            raise
        except Exception:
            return None
        return None

    def get_token_data(self) -> dict:
        with self._lock:
            cached = self._read_cache()
            if cached is not None:
                return cached

            # Only load prior rotation from a validated cache of this configured account
            rotated_refresh = self._read_prior_rotation()

            cred = read_credential(self.config.auth_file, self.config.data_dir)
            subject_hash = hashlib.sha256(cred.subject.encode()).hexdigest()
            if subject_hash != self.config.subject_sha256:
                raise BridgeError("account_mismatch", "The local login account does not match the configured subject.", 409)

            client = extract_client(self.config.binary)
            token_data = refresh_access(client, cred, rotated_refresh)
            if token_data.get("subject_sha256") != self.config.subject_sha256:
                raise BridgeError("account_mismatch", "Renewed token subject does not match configured account.", 409)

            atomic_write_file(self.cache_file, json.dumps(token_data, indent=2).encode(), mode=0o600)
            return token_data

    def _load_base_headers(self, filename: str) -> list[list[str]]:
        path = self.source_dir / filename
        if not path.exists():
            raise BridgeError("missing_source_headers", f"Missing template headers file: {path}")
        try:
            content = json.loads(path.read_text(encoding="utf-8"))
            raw = content.get("out_headers") if isinstance(content, dict) else content
            if not isinstance(raw, list):
                raise ValueError()
            return [[str(k), str(v)] for k, v in raw]
        except Exception as e:
            raise BridgeError("corrupt_source_headers", "Header template cannot be decoded.") from e

    def _inject_headers(self, base_headers: list[list[str]], access_token: str, expected_path: str) -> list[list[str]]:
        pseudo = []
        regular = []
        grpc_timeout_set = False

        for k, v in base_headers:
            k_lower = k.lower()
            if k_lower in ("authorization", "grpc-encoding", "grpc-accept-encoding"):
                continue
            if k_lower == "grpc-timeout":
                regular.append(["grpc-timeout", f"{self.config.task_timeout * 1000}m"])
                grpc_timeout_set = True
                continue
            if k.startswith(":"):
                pseudo.append([k, v])
            else:
                regular.append([k, v])

        if not grpc_timeout_set:
            regular.append(["grpc-timeout", f"{self.config.task_timeout * 1000}m"])

        regular.insert(0, ["authorization", f"Bearer {access_token}"])
        regular.append(["grpc-accept-encoding", "identity"])

        combined = pseudo + regular
        validate_headers(combined, expected_path)
        return combined

    def headers(self) -> tuple[list[list[str]], list[list[str]]]:
        token_data = self.get_token_data()
        access_token = token_data["access_token"]

        task_base = self._load_base_headers("task-headers.json")
        tool_base = self._load_base_headers("tool-headers.json")

        task_h = self._inject_headers(task_base, access_token, TASK_RPC)
        tool_h = self._inject_headers(tool_base, access_token, TOOLS_RPC)
        return copy.deepcopy(task_h), copy.deepcopy(tool_h)
