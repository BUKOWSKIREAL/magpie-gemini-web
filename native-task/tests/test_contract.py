"""Test client contract normalization, schema validation, and prompt rendering."""
import unittest

from gemini_native_bridge.contract import (
    BridgeError,
    Catalog,
    CompletionRequest,
    canonical,
    parse_request,
    render_prompt,
)
from gemini_native_bridge.protocol import MODEL_ID


class TestContract(unittest.TestCase):
    def test_message_normalization(self):
        body = {
            "model": MODEL_ID,
            "messages": [
                {"role": "user", "content": "one"},
                {"role": "assistant", "content": None},
                {"role": "user", "content": [{"type": "text", "text": "two"}]},
            ],
        }
        req = parse_request(body)
        self.assertEqual(req.messages[0], {"role": "user", "content": "one"})
        self.assertEqual(req.messages[1], {"role": "assistant", "content": ""})
        self.assertEqual(req.messages[2], {"role": "user", "content": "two"})

    def test_argument_json_ordering(self):
        body = {
            "model": MODEL_ID,
            "messages": [
                {"role": "user", "content": "one"},
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": "call_123",
                        "type": "function",
                        "function": {"name": "test_fn", "arguments": '{"z": 1, "a": 2}'},
                    }],
                },
                {"role": "tool", "tool_call_id": "call_123", "content": "res"},
            ],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "test_fn",
                    "description": "A test tool",
                    "parameters": {"type": "object", "properties": {"a": {"type": "number"}, "z": {"type": "number"}}},
                },
            }],
        }
        req = parse_request(body)
        tc = req.messages[1]["tool_calls"][0]
        self.assertEqual(tc["function"]["arguments"], '{"a":2,"z":1}')

    def test_schema_nested_enums_and_validation(self):
        tools = [{
            "type": "function",
            "function": {
                "name": "read_fixture",
                "description": "Read fixture",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "value": {"type": "string", "enum": ["allowed1", "allowed2"]},
                        "nested": {
                            "type": "object",
                            "properties": {"num": {"type": "integer"}},
                            "required": ["num"],
                            "additionalProperties": False,
                        },
                    },
                    "required": ["value"],
                    "additionalProperties": False,
                },
            },
        }]
        cat = Catalog(tools)
        # Valid argument
        cat.validate("read_fixture", {"value": "allowed1", "nested": {"num": 42}})
        # Invalid enum
        with self.assertRaises(BridgeError):
            cat.validate("read_fixture", {"value": "disallowed"})
        # Invalid additionalProperties in nested
        with self.assertRaises(BridgeError):
            cat.validate("read_fixture", {"value": "allowed1", "nested": {"num": 1, "extra": True}})

    def test_reject_external_references(self):
        body = {
            "model": MODEL_ID,
            "messages": [{"role": "user", "content": "one"}],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "ref_tool",
                    "description": "Uses external ref",
                    "parameters": {
                        "type": "object",
                        "properties": {"item": {"$ref": "https://example.com/schema.json"}},
                    },
                },
            }],
        }
        with self.assertRaises(BridgeError) as ctx:
            parse_request(body)
        self.assertEqual(ctx.exception.code, "external_schema_reference")

    def test_reject_invalid_dialect(self):
        body = {
            "model": MODEL_ID,
            "messages": [{"role": "user", "content": "one"}],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "old_tool",
                    "description": "Uses draft-04",
                    "parameters": {
                        "$schema": "http://json-schema.org/draft-04/schema#",
                        "type": "object",
                    },
                },
            }],
        }
        with self.assertRaises(BridgeError) as ctx:
            parse_request(body)
        self.assertEqual(ctx.exception.code, "unsupported_schema_dialect")

    def test_reject_duplicate_tool_names(self):
        body = {
            "model": MODEL_ID,
            "messages": [{"role": "user", "content": "one"}],
            "tools": [
                {"type": "function", "function": {"name": "same_name", "description": "1", "parameters": {"type": "object"}}},
                {"type": "function", "function": {"name": "same_name", "description": "2", "parameters": {"type": "object"}}},
            ],
        }
        with self.assertRaises(BridgeError) as ctx:
            parse_request(body)
        self.assertEqual(ctx.exception.code, "invalid_tool_name")

    def test_reject_images(self):
        body = {
            "model": MODEL_ID,
            "messages": [
                {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "https://example.com/1.png"}}]}
            ],
        }
        with self.assertRaises(BridgeError) as ctx:
            parse_request(body)
        self.assertEqual(ctx.exception.code, "text_only")

    def test_reject_unknown_options(self):
        body = {
            "model": MODEL_ID,
            "messages": [{"role": "user", "content": "one"}],
            "temperature": 0.7,
        }
        with self.assertRaises(BridgeError) as ctx:
            parse_request(body)
        self.assertEqual(ctx.exception.code, "unsupported_parameter")

    def test_reject_store_false(self):
        body = {
            "model": MODEL_ID,
            "messages": [{"role": "user", "content": "one"}],
            "store": False,
        }
        with self.assertRaises(BridgeError) as ctx:
            parse_request(body)
        self.assertEqual(ctx.exception.code, "storage_not_optional")

    def test_max_tokens_hint_in_prompt(self):
        body = {
            "model": MODEL_ID,
            "messages": [{"role": "user", "content": "one"}],
            "max_tokens": 1024,
        }
        req = parse_request(body)
        prompt = render_prompt(req)
        self.assertIn("The client requests a final-answer budget of 1024 tokens.", prompt)

    def test_tool_advertisement_schema_fidelity(self):
        tools = [{
            "type": "function",
            "function": {
                "name": "write_fixture",
                "description": "Writes fixture value",
                "parameters": {
                    "type": "object",
                    "properties": {"value": {"type": "string"}},
                    "required": ["value"],
                    "additionalProperties": False,
                },
            },
        }]
        cat = Catalog(tools)
        ad = cat.advertisement()
        server = ad["servers"][0]
        self.assertEqual(server["name"], "agent_bridge")
        tool_ad = server["tools"][0]
        self.assertEqual(tool_ad["name"], "write_fixture")
        self.assertIn("Input JSON Schema: ", tool_ad["description"])
        self.assertIn('"additionalProperties":false', tool_ad["description"])
        # Does not falsely claim harmless
        self.assertNotIn("harmless", tool_ad["description"].lower())


if __name__ == "__main__":
    unittest.main()
