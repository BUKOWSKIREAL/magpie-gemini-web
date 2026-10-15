"""Existing-login credential primitives; fixed Google endpoints, no secret logging."""
from __future__ import annotations

import base64
import hashlib
import http.client
import json
import struct
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from .contract import BridgeError
from .protocol import BINARY_SHA256, fields, one

TOKEN_URL = "https://www.googleapis.com/oauth2/v4/token"
TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo"


@dataclass(frozen=True)
class Credential:
    subject: str
    email: str
    refresh_token: str
    audience: str


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _json_request(url: str, data: bytes | None = None):
    if url != TOKEN_URL and not url.startswith(TOKENINFO_URL + "?"):
        raise BridgeError("unexpected_auth_endpoint", "Authentication endpoint is not allowed.")
    request = urllib.request.Request(url, data=data, headers={
        "Content-Type": "application/x-www-form-urlencoded"} if data is not None else {})
    opener = urllib.request.build_opener(NoRedirect)
    for attempt in range(2):
        try:
            with opener.open(request, timeout=15) as response:
                raw = response.read(65537)
                if len(raw) > 65536:
                    raise BridgeError("invalid_auth_response", "Authentication response exceeds the allowed size.")
                body = json.loads(raw)
                if not isinstance(body, dict):
                    raise ValueError()
                return response.status, body
        except urllib.error.HTTPError as error:
            try:
                body = json.loads(error.read(65536))
                reason = body.get("error") if isinstance(body, dict) else None
            except (ValueError, OSError, http.client.HTTPException):
                reason = None
            return error.code, {"error": reason if reason in {"invalid_grant", "invalid_token", "invalid_client"} else "rejected"}
        except (http.client.HTTPException, urllib.error.URLError, OSError):
            if attempt:
                raise BridgeError("auth_transport_failed", "Cannot reach the Google authentication service.") from None
        except (ValueError, UnicodeError):
            raise BridgeError("invalid_auth_response", "Google returned an invalid authentication response.") from None
    raise AssertionError("unreachable")


def token_info(token: str):
    return _json_request(TOKENINFO_URL + "?" + urllib.parse.urlencode({"access_token": token}))


def extract_client(binary: Path) -> tuple[str, str]:
    data = binary.read_bytes()
    if hashlib.sha256(data).hexdigest() != BINARY_SHA256:
        raise BridgeError("unsupported_app_version", "This bridge requires the validated Gemini macOS 1.128.14.1166 binary.")
    if struct.unpack_from("<I", data)[0] != 0xfeedfacf:
        raise BridgeError("unsupported_app_binary", "Expected the validated arm64 Mach-O binary.")
    segments = []
    p = 32
    for _ in range(struct.unpack_from("<I", data, 16)[0]):
        cmd, size = struct.unpack_from("<II", data, p)
        if cmd == 0x19:
            vmaddr, vmsize, offset, length = struct.unpack_from("<QQQQ", data, p + 24)
            segments.append((vmaddr, offset, length))
        p += size

    def address(va, length):
        offsets = [off + va - vm for vm, off, size in segments if vm <= va and va + length <= vm + size]
        if len(offsets) != 1:
            raise BridgeError("invalid_client_config", "OAuth client configuration is outside the validated segment.")
        return data[offsets[0]:offsets[0] + length]

    client_id = address(0x109e17220, 72).decode()
    client_secret = bytes(v ^ 0x5a for v in address(0x10aa4b380, 35)).decode()
    if not client_id.endswith(".apps.googleusercontent.com") or not client_secret.startswith("GOCSPX-"):
        raise BridgeError("invalid_client_config", "The installed OAuth client configuration is not recognized.")
    return client_id, client_secret


def read_credential(auth_file: Path, work_dir: Path) -> Credential:
    helper = Path(__file__).with_name("native_auth_keychain.swift")
    try:
        with tempfile.TemporaryDirectory(prefix="credential-", dir=work_dir) as directory:
            output = Path(directory) / "plain.bin"
            result = subprocess.run(["swift", str(helper), str(auth_file), str(output)],
                                    capture_output=True, timeout=45)
            if result.returncode:
                raise BridgeError("keychain_unavailable", "Cannot read this Gemini login through the noninteractive Keychain API.")
            data = output.read_bytes()
            subject = one(data, 1).decode()
            email = one(data, 2).decode()
            refresh = one(data, 4).decode()
            encoded = one(data, 8).split(b".")[1]
            claims = json.loads(base64.urlsafe_b64decode(encoded + b"=" * (-len(encoded) % 4)))
            if not subject or claims.get("sub") != subject or not refresh.startswith("1//"):
                raise ValueError()
            audience = claims.get("aud")
            if not isinstance(audience, str) or not audience.endswith(".apps.googleusercontent.com"):
                raise ValueError()
            return Credential(subject, email, refresh, audience)
    except BridgeError:
        raise
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        raise BridgeError("credential_unavailable", "The selected local Gemini login could not be decoded.") from None


def refresh_access(client: tuple[str, str], credential: Credential, rotated_refresh: str | None = None) -> dict:
    client_id, client_secret = client
    if client_id != credential.audience:
        raise BridgeError("oauth_client_mismatch", "The local login belongs to a different OAuth client.")
    refresh = rotated_refresh or credential.refresh_token
    form = urllib.parse.urlencode({"grant_type": "refresh_token", "client_id": client_id,
        "client_secret": client_secret, "refresh_token": refresh}).encode()
    status, body = _json_request(TOKEN_URL, form)
    if status != 200 or not isinstance(body.get("access_token"), str) or body.get("token_type", "").lower() != "bearer":
        raise BridgeError("login_refresh_failed", "The Gemini login cannot be refreshed; sign in through the app again if it has expired.")
    token = body["access_token"]
    status, info = token_info(token)
    subject = str(info.get("sub", info.get("user_id", "")))
    if status != 200 or subject != credential.subject:
        raise BridgeError("account_mismatch", "The renewed token does not match the configured account.")
    try:
        expires = min(float(info["exp"]), time.time() + int(body["expires_in"]))
        if not time.time() + 60 < expires <= time.time() + 86400:
            raise ValueError()
    except (KeyError, ValueError, TypeError, OverflowError):
        raise BridgeError("invalid_token_lifetime", "The renewed token has an invalid expiry.") from None
    rotation = body.get("refresh_token")
    if rotation is not None and (not isinstance(rotation, str) or not rotation.startswith("1//")):
        raise BridgeError("invalid_refresh_rotation", "Google returned an unsupported refresh-token rotation.")
    return {"access_token": token, "expires_at": expires,
            "subject_sha256": hashlib.sha256(subject.encode()).hexdigest(),
            "rotated_refresh_token": rotation or rotated_refresh}
