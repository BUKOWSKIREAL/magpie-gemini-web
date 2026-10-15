"""Runtime configuration, directory safety, atomic writes, and daemon locks."""
from __future__ import annotations

import fcntl
import json
import os
import re
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .contract import BridgeError

HEX64 = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class RuntimeConfig:
    data_dir: Path
    api_key: str
    instance_id: str
    auth_file: Path
    binary: Path
    subject_sha256: str
    account_label: str
    port: int = 8084
    task_timeout: int = 240
    tool_timeout: int = 50
    max_tool_calls: int = 32

    def __post_init__(self):
        if not isinstance(self.data_dir, Path):
            object.__setattr__(self, "data_dir", Path(self.data_dir))
        if not isinstance(self.auth_file, Path):
            object.__setattr__(self, "auth_file", Path(self.auth_file))
        if not isinstance(self.binary, Path):
            object.__setattr__(self, "binary", Path(self.binary))
        validate_config_values(
            api_key=self.api_key,
            instance_id=self.instance_id,
            subject_sha256=self.subject_sha256,
            port=self.port,
            task_timeout=self.task_timeout,
            tool_timeout=self.tool_timeout,
            max_tool_calls=self.max_tool_calls,
        )


def validate_config_values(
    api_key: str,
    instance_id: str,
    subject_sha256: str,
    port: int,
    task_timeout: int,
    tool_timeout: int,
    max_tool_calls: int,
):
    if not isinstance(api_key, str) or len(api_key) < 16:
        raise BridgeError("invalid_config", "api_key must be a string of length >= 16.")
    if not isinstance(instance_id, str) or not (1 <= len(instance_id) <= 128):
        raise BridgeError("invalid_config", "instance_id must be a string of length 1..128.")
    if not isinstance(subject_sha256, str) or not HEX64.fullmatch(subject_sha256):
        raise BridgeError("invalid_config", "subject_sha256 must be 64 lowercase hex characters.")
    if not isinstance(port, int) or isinstance(port, bool) or not (1024 <= port <= 65535):
        raise BridgeError("invalid_config", "Port must be an integer between 1024 and 65535.")
    if not isinstance(task_timeout, int) or isinstance(task_timeout, bool) or not (60 <= task_timeout <= 300):
        raise BridgeError("invalid_config", "task_timeout must be an integer between 60 and 300 seconds.")
    if not isinstance(tool_timeout, int) or isinstance(tool_timeout, bool) or not (1 <= tool_timeout <= 50):
        raise BridgeError("invalid_config", "tool_timeout must be an integer between 1 and 50 seconds.")
    if not isinstance(max_tool_calls, int) or isinstance(max_tool_calls, bool) or not (1 <= max_tool_calls <= 32):
        raise BridgeError("invalid_config", "max_tool_calls must be an integer between 1 and 32.")


def require_macos():
    if sys.platform != "darwin":
        raise BridgeError("unsupported_platform", "Gemini Native Task bridge requires macOS.")


def get_default_data_dir() -> Path:
    override = os.environ.get("GEMINI_NATIVE_TASK_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    return (Path.home() / ".local" / "share" / "gemini-native-task").resolve()


def ensure_data_dir(data_dir: Path, create: bool = True) -> Path:
    data_dir = data_dir.expanduser().resolve()
    if data_dir.exists():
        if not data_dir.is_dir():
            raise BridgeError("insecure_data_directory", f"{data_dir} is not a directory.")
        st = data_dir.stat()
        if hasattr(os, "getuid") and st.st_uid != os.getuid():
            raise BridgeError("insecure_data_directory", "Data directory must be owned by the current user.")
        if (st.st_mode & 0o077) != 0:
            raise BridgeError("insecure_data_directory", "Data directory has insecure permissions; must not be accessible by group or others.")
    else:
        if not create:
            raise BridgeError("missing_data_directory", f"Data directory {data_dir} does not exist.")
        data_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
        try:
            os.chmod(data_dir, 0o700)
        except OSError:
            pass
    return data_dir


def atomic_write_file(path: Path, data: bytes, mode: int = 0o600):
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    tmp_path = None
    with tempfile.NamedTemporaryFile(dir=parent, delete=False) as tmp:
        tmp_path = Path(tmp.name)
        try:
            tmp.write(data)
            tmp.flush()
            os.fsync(tmp.fileno())
            os.chmod(tmp_path, mode)
        except Exception:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise

    try:
        tmp_path.replace(path)
        # fsync containing directory so rename journal is durable on disk
        dir_fd = os.open(str(parent), os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except Exception:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def save_config(config: RuntimeConfig):
    ensure_data_dir(config.data_dir, create=True)
    payload = {
        "version": 1,
        "api_key": config.api_key,
        "instance_id": config.instance_id,
        "auth_file": str(config.auth_file),
        "binary": str(config.binary),
        "subject_sha256": config.subject_sha256,
        "account_label": config.account_label,
        "port": config.port,
        "task_timeout": config.task_timeout,
        "tool_timeout": config.tool_timeout,
        "max_tool_calls": config.max_tool_calls,
    }
    encoded = json.dumps(payload, indent=2).encode()
    atomic_write_file(config.data_dir / "config.json", encoded, mode=0o600)


def load_config(data_dir: Path) -> RuntimeConfig:
    data_dir = ensure_data_dir(data_dir, create=False)
    cfg_file = data_dir / "config.json"
    if not cfg_file.exists():
        raise BridgeError("missing_config", f"Configuration file not found in {data_dir}. Run setup first.")

    st = cfg_file.stat()
    if hasattr(os, "getuid") and st.st_uid != os.getuid():
        raise BridgeError("insecure_config", "config.json must be owned by the current user.")
    if (st.st_mode & 0o077) != 0:
        raise BridgeError("insecure_config", "config.json has insecure permissions; must be 0600 or stricter.")

    try:
        raw = json.loads(cfg_file.read_text(encoding="utf-8"))
    except Exception as e:
        raise BridgeError("corrupt_config", "Configuration cannot be decoded.") from e

    if not isinstance(raw, dict) or raw.get("version") != 1:
        raise BridgeError("invalid_config", "Unsupported config schema version.")

    required_keys = ["api_key", "instance_id", "auth_file", "binary", "subject_sha256", "account_label"]
    for k in required_keys:
        if not isinstance(raw.get(k), str) or not raw[k]:
            raise BridgeError("invalid_config", f"Config missing required field: {k}")

    return RuntimeConfig(
        data_dir=data_dir,
        api_key=raw["api_key"],
        instance_id=raw["instance_id"],
        auth_file=Path(raw["auth_file"]),
        binary=Path(raw["binary"]),
        subject_sha256=raw["subject_sha256"],
        account_label=raw["account_label"],
        port=raw.get("port", 8084),
        task_timeout=raw.get("task_timeout", 240),
        tool_timeout=raw.get("tool_timeout", 50),
        max_tool_calls=raw.get("max_tool_calls", 32),
    )


def acquire_file_lock(lock_file: Path, error_code: str, error_message: str):
    f = open(lock_file, "a+")
    try:
        os.chmod(lock_file, 0o600)
    except OSError:
        pass
    try:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (BlockingIOError, OSError) as e:
        f.close()
        raise BridgeError(error_code, error_message) from e
    return f


def acquire_daemon_lock(data_dir: Path):
    ensure_data_dir(data_dir, create=True)
    return acquire_file_lock(data_dir / "daemon.lock", "daemon_running", "Another daemon instance is already running.")


def acquire_bootstrap_lock(data_dir: Path):
    ensure_data_dir(data_dir, create=True)
    return acquire_file_lock(data_dir / "bootstrap.lock", "bootstrap_running", "Another bootstrap process is running.")
