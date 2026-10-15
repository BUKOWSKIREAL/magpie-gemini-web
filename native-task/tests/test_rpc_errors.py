import unittest
from gemini_native_bridge.transport import grpc_failure

class RpcErrors(unittest.TestCase):
    def test_observed_quota_error_is_explicit_and_nonretryable(self):
        for message in ["com.google.assistant.boq.bard.application.utils.BardStatusException: Remy quota exhausted", "BardStatusException%3A%20Remy%20quota%20exhausted"]:
            error = grpc_failure("8", message)
            self.assertEqual((error.code, error.status), ("native_quota_exhausted", 409))
            self.assertNotIn("BardStatusException", error.message)
    def test_unrelated_errors_do_not_become_quota_or_leak_text(self):
        for status, message in [("8", "private upstream diagnostic"), ("16", "BardStatusException: Remy quota exhausted")]:
            error = grpc_failure(status, message)
            self.assertEqual((error.code, error.status), ("grpc_error", 409))
            self.assertNotIn(message, error.message)
