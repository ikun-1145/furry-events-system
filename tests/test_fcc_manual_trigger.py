"""Offline tests. The HTTP opener is always mocked; no request is sent."""
import contextlib
import importlib.util
import io
import json
import pathlib
import time
import unittest
from unittest.mock import patch

path = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "fcc-manual-trigger.py"
spec = importlib.util.spec_from_file_location("fcc_manual_trigger", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Response:
    status = 200

    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, maximum):
        return self.body[:maximum]


class OfflineTests(unittest.TestCase):
    def setUp(self):
        self.receipt = {"success": True, "source": "fcc", "fetched": 516,
                        "upserted": 516, "deactivated": 0, "errors": []}
        self.env = {"SUPABASE_SERVICE_ROLE_KEY": "fixture-private-jwt",
                    "FUNCTION_SECRET": "fixture-private-secret"}

    def invoke(self, payload=None, error=None, env=None):
        calls = []

        class Opener:
            def open(self, req, timeout):
                calls.append((req, timeout))
                if error:
                    raise error
                return Response(payload)

        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.dict(module.os.environ, env if env is not None else self.env, clear=True), \
             patch.object(module, "build_opener", return_value=Opener()), \
             contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = module.run()
        output = stdout.getvalue() + stderr.getvalue()
        self.assertNotIn("fixture-private", output)
        return result, calls, output

    def test_success_makes_one_bounded_call_to_fixed_url(self):
        result, calls, _ = self.invoke(json.dumps(self.receipt).encode())
        self.assertEqual(result, 0)
        self.assertEqual(len(calls), 1)
        request, timeout = calls[0]
        self.assertEqual(request.full_url, module.URL)
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.data, b'{"allow_empty":false}')
        self.assertEqual(timeout, 120)

    def test_complete_snapshot_can_deactivate_missing_fcc_records(self):
        result, calls, _ = self.invoke(json.dumps({**self.receipt, "deactivated": 2}).encode())
        self.assertEqual(result, 0)
        self.assertEqual(len(calls), 1)

    def test_scheduled_trigger_keeps_classification_without_exposing_secrets(self):
        result, calls, output = self.invoke(json.dumps(self.receipt).encode(),
                                             env={**self.env, "GITHUB_EVENT_NAME": "schedule"})
        self.assertEqual(result, 0)
        self.assertEqual(calls[0][0].get_header("X-sync-trigger"), "scheduled")
        self.assertIn("fetched=516 upserted=516 deactivated=0", output)

    def test_bad_receipts_fail_closed_without_retry(self):
        for changes in ({"fetched": 0, "upserted": 0}, {"upserted": 515},
                        {"fetched": True, "upserted": True}, {"fetched": 1.5},
                        {"empty": True}, {"deactivated": False}, {"deactivated": -1},
                        {"deactivated": 1.5}, {"errors": ["x"]}):
            with self.subTest(changes=changes):
                receipt = {**self.receipt, **changes}
                result, calls, output = self.invoke(json.dumps(receipt).encode())
                self.assertEqual(result, 1)
                self.assertEqual(len(calls), 1)
                self.assertIn("禁止盲目重试", output)

    def test_bad_response_and_exception_do_not_leak(self):
        for payload in (b"{", b"x" * (module.MAX_RESPONSE + 1)):
            result, calls, _ = self.invoke(payload)
            self.assertEqual(result, 1)
            self.assertEqual(len(calls), 1)
        result, calls, output = self.invoke(error=RuntimeError("fixture-private-jwt"))
        self.assertEqual(result, 1)
        self.assertEqual(len(calls), 1)
        self.assertNotIn("fixture-private", output)

    def test_missing_or_header_injection_credentials_never_call_network(self):
        for env in ({}, {**self.env, "FUNCTION_SECRET": "x\r\ny"}):
            result, calls, _ = self.invoke(env=env)
            self.assertEqual(result, 2)
            self.assertEqual(calls, [])

    def test_redirect_handler_refuses_all_redirects(self):
        self.assertIsNone(module.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.invalid"))

    def test_wall_clock_deadline_is_fail_closed(self):
        class SlowOpener:
            def open(self, req, timeout):
                time.sleep(0.2)
                raise AssertionError("deadline did not fire")

        with patch.dict(module.os.environ, self.env, clear=True), \
             patch.object(module, "TIMEOUT_SECONDS", 0.02), \
             patch.object(module, "build_opener", return_value=SlowOpener()), \
             contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(module.run(), 1)


if __name__ == "__main__":
    unittest.main()
