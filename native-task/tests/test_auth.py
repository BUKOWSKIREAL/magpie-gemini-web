"""Test authentication lifecycle, token cache, concurrent renewal, and header injection."""
import hashlib
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from gemini_native_bridge.auth import AuthManager
from gemini_native_bridge.config import RuntimeConfig
from gemini_native_bridge.contract import BridgeError
from gemini_native_bridge.oauth import Credential
from gemini_native_bridge.protocol import TASK_RPC, TOOLS_RPC


class TestAuth(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp_dir.name)
        self.source_dir = self.data_dir / "source"
        self.source_dir.mkdir(parents=True, mode=0o700)

        # Write template headers
        task_headers = [
            [":authority", "robinfrontend-pa.googleapis.com:443"],
            [":scheme", "https"],
            [":method", "POST"],
            [":path", TASK_RPC],
            ["content-type", "application/grpc"],
            ["x-server-token", "dummy_server_token"],
            ["grpc-encoding", "gzip"],
        ]
        (self.source_dir / "task-headers.json").write_text(json.dumps({"out_headers": task_headers}))

        tool_headers = [
            [":authority", "robinfrontend-pa.googleapis.com:443"],
            [":scheme", "https"],
            [":method", "POST"],
            [":path", TOOLS_RPC],
            ["content-type", "application/grpc"],
        ]
        (self.source_dir / "tool-headers.json").write_text(json.dumps({"out_headers": tool_headers}))

        self.subject = "user_12345"
        self.subject_hash = hashlib.sha256(self.subject.encode()).hexdigest()
        self.config = RuntimeConfig(
            data_dir=self.data_dir,
            api_key="test_api_key_32_characters_minimum__",
            instance_id="inst_12345",
            auth_file=self.data_dir / "auth.bin",
            binary=self.data_dir / "Gemini",
            subject_sha256=self.subject_hash,
            account_label="Account1",
            task_timeout=120,
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    @patch("gemini_native_bridge.auth.read_credential")
    @patch("gemini_native_bridge.auth.extract_client")
    @patch("gemini_native_bridge.auth.refresh_access")
    def test_cache_reuse_and_expiry_margin(self, mock_refresh, mock_extract, mock_read):
        mock_read.return_value = Credential(self.subject, "user@example.com", "1//refresh_token", "aud.apps.googleusercontent.com")
        mock_extract.return_value = ("client_id", "client_secret")
        mock_refresh.return_value = {
            "access_token": "fresh_token_1",
            "expires_at": time.time() + 1000,
            "subject_sha256": self.subject_hash,
            "rotated_refresh_token": "1//rotated_token_1",
        }

        manager = AuthManager(self.config)
        token_data1 = manager.get_token_data()
        self.assertEqual(token_data1["access_token"], "fresh_token_1")
        self.assertEqual(mock_refresh.call_count, 1)

        # Reused without refresh call
        token_data2 = manager.get_token_data()
        self.assertEqual(token_data2["access_token"], "fresh_token_1")
        self.assertEqual(mock_refresh.call_count, 1)

        # Expiry margin test (expires in 200s < 300s margin)
        cache_path = self.data_dir / "token-cache.json"
        cached = json.loads(cache_path.read_text())
        cached["expires_at"] = time.time() + 200
        cache_path.write_text(json.dumps(cached))

        mock_refresh.return_value = {
            "access_token": "fresh_token_2",
            "expires_at": time.time() + 2000,
            "subject_sha256": self.subject_hash,
            "rotated_refresh_token": "1//rotated_token_2",
        }

        token_data3 = manager.get_token_data()
        self.assertEqual(token_data3["access_token"], "fresh_token_2")
        self.assertEqual(mock_refresh.call_count, 2)

    @patch("gemini_native_bridge.auth.read_credential")
    @patch("gemini_native_bridge.auth.extract_client")
    @patch("gemini_native_bridge.auth.refresh_access")
    def test_invalid_expiry_types_fail_cache_validity(self, mock_refresh, mock_extract, mock_read):
        mock_read.return_value = Credential(self.subject, "user@example.com", "1//refresh_token", "aud.apps.googleusercontent.com")
        mock_extract.return_value = ("client_id", "client_secret")
        mock_refresh.return_value = {
            "access_token": "fresh_token_renewed",
            "expires_at": time.time() + 2000,
            "subject_sha256": self.subject_hash,
            "rotated_refresh_token": None,
        }

        cache_path = self.data_dir / "token-cache.json"
        for invalid_exp in ["never_expires", float("nan"), float("inf"), True, None]:
            cache_path.write_text(json.dumps({
                "access_token": "stale_token",
                "expires_at": invalid_exp,
                "subject_sha256": self.subject_hash,
                "rotated_refresh_token": None,
            }))
            manager = AuthManager(self.config)
            data = manager.get_token_data()
            self.assertEqual(data["access_token"], "fresh_token_renewed")

    @patch("gemini_native_bridge.auth.read_credential")
    @patch("gemini_native_bridge.auth.extract_client")
    @patch("gemini_native_bridge.auth.refresh_access")
    def test_foreign_cache_identity_causes_zero_refresh_calls(self, mock_refresh, mock_extract, mock_read):
        foreign_hash = hashlib.sha256(b"foreign_subject").hexdigest()
        cache_path = self.data_dir / "token-cache.json"
        cache_path.write_text(json.dumps({
            "access_token": "foreign_token",
            "expires_at": time.time() + 2000,
            "subject_sha256": foreign_hash,
            "rotated_refresh_token": "1//foreign_rot",
        }))

        manager = AuthManager(self.config)
        with self.assertRaises(BridgeError) as ctx:
            manager.get_token_data()
        self.assertEqual(ctx.exception.code, "account_mismatch")
        self.assertEqual(mock_read.call_count, 0)
        self.assertEqual(mock_refresh.call_count, 0)

    @patch("gemini_native_bridge.auth.read_credential")
    @patch("gemini_native_bridge.auth.extract_client")
    @patch("gemini_native_bridge.auth.refresh_access")
    def test_rotated_refresh_token_used_on_next_renewal(self, mock_refresh, mock_extract, mock_read):
        mock_read.return_value = Credential(self.subject, "user@example.com", "1//initial_refresh", "aud.apps.googleusercontent.com")
        mock_extract.return_value = ("client_id", "client_secret")
        mock_refresh.return_value = {
            "access_token": "token_1",
            "expires_at": time.time() + 100,
            "subject_sha256": self.subject_hash,
            "rotated_refresh_token": "1//rotated_token_xyz",
        }

        manager = AuthManager(self.config)
        manager.get_token_data()
        self.assertEqual(mock_refresh.call_args[0][2], None)

        mock_refresh.return_value = {
            "access_token": "token_2",
            "expires_at": time.time() + 2000,
            "subject_sha256": self.subject_hash,
            "rotated_refresh_token": "1//rotated_token_xyz",
        }

        manager.get_token_data()
        self.assertEqual(mock_refresh.call_args[0][2], "1//rotated_token_xyz")

    @patch("gemini_native_bridge.auth.read_credential")
    def test_identity_mismatch_in_read_credential_rejected(self, mock_read):
        different_subject = "user_99999"
        mock_read.return_value = Credential(different_subject, "other@example.com", "1//ref", "aud")

        manager = AuthManager(self.config)
        with self.assertRaises(BridgeError) as ctx:
            manager.get_token_data()
        self.assertEqual(ctx.exception.code, "account_mismatch")

    @patch("gemini_native_bridge.auth.read_credential")
    @patch("gemini_native_bridge.auth.extract_client")
    @patch("gemini_native_bridge.auth.refresh_access")
    def test_simultaneous_get_token_data_coalesces_to_one_renewal(self, mock_refresh, mock_extract, mock_read):
        mock_read.return_value = Credential(self.subject, "user@example.com", "1//ref", "aud")
        mock_extract.return_value = ("client_id", "client_secret")

        def slow_refresh(*args, **kwargs):
            time.sleep(0.05)
            return {
                "access_token": "coalesced_token",
                "expires_at": time.time() + 2000,
                "subject_sha256": self.subject_hash,
                "rotated_refresh_token": None,
            }

        mock_refresh.side_effect = slow_refresh
        manager = AuthManager(self.config)

        results = []
        threads = []
        for _ in range(5):
            t = threading.Thread(target=lambda: results.append(manager.get_token_data()["access_token"]))
            threads.append(t)
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(len(results), 5)
        self.assertTrue(all(r == "coalesced_token" for r in results))
        self.assertEqual(mock_refresh.call_count, 1)

    @patch("gemini_native_bridge.auth.read_credential")
    @patch("gemini_native_bridge.auth.extract_client")
    @patch("gemini_native_bridge.auth.refresh_access")
    def test_header_injection(self, mock_refresh, mock_extract, mock_read):
        mock_read.return_value = Credential(self.subject, "user@example.com", "1//ref", "aud")
        mock_extract.return_value = ("client_id", "client_secret")
        mock_refresh.return_value = {
            "access_token": "my_test_bearer_token",
            "expires_at": time.time() + 2000,
            "subject_sha256": self.subject_hash,
            "rotated_refresh_token": None,
        }

        manager = AuthManager(self.config)
        task_h, tool_h = manager.headers()

        self.assertTrue(task_h[0][0].startswith(":"))
        self.assertTrue(tool_h[0][0].startswith(":"))

        task_dict = dict(task_h)
        tool_dict = dict(tool_h)

        self.assertEqual(task_dict["authorization"], "Bearer my_test_bearer_token")
        self.assertEqual(tool_dict["authorization"], "Bearer my_test_bearer_token")
        self.assertEqual(task_dict["grpc-timeout"], "120000m")
        self.assertEqual(tool_dict["grpc-timeout"], "120000m")
        self.assertEqual(task_dict["grpc-accept-encoding"], "identity")
        self.assertEqual(tool_dict["grpc-accept-encoding"], "identity")
        self.assertNotIn("grpc-encoding", task_dict)
        self.assertNotIn("grpc-encoding", tool_dict)


if __name__ == "__main__":
    unittest.main()
