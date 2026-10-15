"""CLI entrypoint for bootstrap and daemon serving."""
from __future__ import annotations

import argparse
import hashlib
import json
import secrets
import signal
import sys
import threading
from pathlib import Path

from .config import (
    RuntimeConfig,
    acquire_bootstrap_lock,
    acquire_daemon_lock,
    atomic_write_file,
    ensure_data_dir,
    get_default_data_dir,
    load_config,
    require_macos,
    save_config,
    validate_config_values,
)
from .contract import BridgeError
from .oauth import extract_client, read_credential, refresh_access
from .protocol import (
    TASK_RPC,
    TOOLS_RPC,
    TURN_RPC,
    fields,
    messages,
    one,
    turn_request,
    validate_headers,
    validate_task_template,
)
from .server import BridgeServer
from .state import Manager
from .transport import unary


def sanitize_headers(raw_headers: list) -> list[list[str]]:
    out = []
    for item in raw_headers:
        if isinstance(item, list) and len(item) == 2:
            k, v = str(item[0]), str(item[1])
            if k.lower() not in ("authorization", "grpc-encoding", "grpc-accept-encoding"):
                out.append([k, v])
    out.append(["grpc-accept-encoding", "identity"])
    return out


def cmd_bootstrap(args: argparse.Namespace):
    require_macos()
    data_dir = Path(args.data_dir).expanduser().resolve()
    ensure_data_dir(data_dir, create=True)

    # Acquire bootstrap lock before checking or creating configuration
    boot_lock = acquire_bootstrap_lock(data_dir)
    try:
        cfg_file = data_dir / "config.json"
        if cfg_file.exists():
            raise BridgeError("config_exists", f"Configuration already exists at {data_dir}. Preserve config or use a new directory.", 409)

        # Validate numeric options before live refresh
        validate_config_values(
            api_key="a" * 32,
            instance_id="init",
            subject_sha256="0" * 64,
            port=args.port,
            task_timeout=args.task_timeout,
            tool_timeout=args.tool_timeout,
            max_tool_calls=args.max_tool_calls,
        )

        source_dir = data_dir / "source"
        source_dir.mkdir(parents=True, mode=0o700, exist_ok=True)

        auth_file = Path(args.auth_file).expanduser().resolve()
        if not auth_file.exists():
            raise BridgeError("file_not_found", f"Auth file {auth_file} does not exist.", 409)

        binary = Path(args.binary).expanduser().resolve()
        if not binary.exists():
            raise BridgeError("file_not_found", f"App binary {binary} does not exist.", 409)

        task_h_path = Path(args.task_headers).expanduser().resolve()
        task_raw = json.loads(task_h_path.read_text(encoding="utf-8"))
        task_entries = task_raw.get("out_headers") if isinstance(task_raw, dict) else task_raw
        task_clean = sanitize_headers(task_entries)
        validate_headers(task_clean, TASK_RPC)
        atomic_write_file(source_dir / "task-headers.json", json.dumps({"out_headers": task_clean}, indent=2).encode(), mode=0o600)

        tool_h_path = Path(args.tool_headers).expanduser().resolve()
        tool_raw = json.loads(tool_h_path.read_text(encoding="utf-8"))
        tool_entries = tool_raw.get("out_headers") if isinstance(tool_raw, dict) else tool_raw
        tool_clean = sanitize_headers(tool_entries)
        validate_headers(tool_clean, TOOLS_RPC)
        atomic_write_file(source_dir / "tool-headers.json", json.dumps({"out_headers": tool_clean}, indent=2).encode(), mode=0o600)

        task_tmpl_path = Path(args.task_template).expanduser().resolve()
        task_tmpl_bytes = task_tmpl_path.read_bytes()
        validate_task_template(task_tmpl_bytes)
        atomic_write_file(source_dir / "task-template.bin", task_tmpl_bytes, mode=0o600)

        turn_tmpl_path = Path(args.turn_template).expanduser().resolve()
        turn_tmpl_bytes = turn_tmpl_path.read_bytes()
        initial_conv = one(messages(turn_tmpl_bytes)[0], 1)
        turn_req = turn_request(turn_tmpl_bytes, initial_conv)
        atomic_write_file(source_dir / "turn-template.bin", turn_tmpl_bytes, mode=0o600)

        cred = read_credential(auth_file, data_dir)
        subject_hash = hashlib.sha256(cred.subject.encode()).hexdigest()
        account_label = auth_file.parent.name
        client = extract_client(binary)
        token_data = refresh_access(client, cred)

        atomic_write_file(data_dir / "token-cache.json", json.dumps(token_data, indent=2).encode(), mode=0o600)

        pseudo = []
        regular = []
        for k, v in task_clean:
            k_lower = k.lower()
            if k == ":path":
                pseudo.append([":path", TURN_RPC])
            elif k.startswith(":"):
                pseudo.append([k, v])
            elif k_lower in ("grpc-encoding", "grpc-accept-encoding"):
                continue
            elif k_lower == "grpc-timeout":
                regular.append([k, f"{args.task_timeout * 1000}m"])
            else:
                regular.append([k, v])
        regular.insert(0, ["authorization", f"Bearer {token_data['access_token']}"])
        regular.append(["grpc-accept-encoding", "identity"])
        verify_headers = pseudo + regular
        validate_headers(verify_headers, TURN_RPC)

        _, resp_data = unary(verify_headers, turn_req, rpc_path=TURN_RPC, timeout=15.0)
        matched = False
        for msg in messages(resp_data):
            for n, w, turn, _ in fields(msg):
                if n == 1 and w == 2:
                    turn_ids = one(turn, 1)
                    if one(turn_ids, 1) == initial_conv:
                        matched = True
                        break
        if not matched:
            raise BridgeError("turn_verification_failed", "Turn verification failed for configured account.", 409)

        api_key = secrets.token_urlsafe(32)
        instance_id = secrets.token_hex(16)
        config = RuntimeConfig(
            data_dir=data_dir,
            api_key=api_key,
            instance_id=instance_id,
            auth_file=auth_file,
            binary=binary,
            subject_sha256=subject_hash,
            account_label=account_label,
            port=args.port,
            task_timeout=args.task_timeout,
            tool_timeout=args.tool_timeout,
            max_tool_calls=args.max_tool_calls,
        )
        save_config(config)

        print(json.dumps({
            "configured": True,
            "port": config.port,
            "account_label": config.account_label,
            "instance_id": config.instance_id,
        }))
    finally:
        boot_lock.close()


def cmd_serve(args: argparse.Namespace):
    data_dir = Path(args.data_dir).expanduser().resolve()
    config = load_config(data_dir)
    lock = acquire_daemon_lock(data_dir)
    manager = Manager(config)
    server = BridgeServer(config, manager)

    def trigger_shutdown(*_):
        threading.Thread(target=server.stop, daemon=True).start()

    signal.signal(signal.SIGINT, trigger_shutdown)
    signal.signal(signal.SIGTERM, trigger_shutdown)

    try:
        server.serve_forever()
    finally:
        manager.close()
        server.server_close()
        lock.close()


def main():
    parser = argparse.ArgumentParser(description="Gemini Native Task Bridge")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_boot = subparsers.add_parser("bootstrap", help="Bootstrap configuration")
    p_boot.add_argument("--data-dir", required=True)
    p_boot.add_argument("--auth-file", required=True)
    p_boot.add_argument("--task-headers", required=True)
    p_boot.add_argument("--tool-headers", required=True)
    p_boot.add_argument("--task-template", required=True)
    p_boot.add_argument("--turn-template", required=True)
    p_boot.add_argument("--binary", default="/Applications/Gemini.app/Contents/MacOS/Gemini")
    p_boot.add_argument("--port", type=int, default=8084)
    p_boot.add_argument("--task-timeout", type=int, default=240)
    p_boot.add_argument("--tool-timeout", type=int, default=50)
    p_boot.add_argument("--max-tool-calls", type=int, default=32)

    p_serve = subparsers.add_parser("serve", help="Run HTTP server")
    p_serve.add_argument("--data-dir", default=str(get_default_data_dir()))

    args = parser.parse_args()
    try:
        if args.command == "bootstrap":
            cmd_bootstrap(args)
        elif args.command == "serve":
            cmd_serve(args)
    except BridgeError as be:
        sys.stderr.write(f"Error ({be.code}): {be.message}\n")
        sys.exit(1)
    except Exception:
        sys.stderr.write("Error (internal_failure): Unexpected error during command execution.\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
