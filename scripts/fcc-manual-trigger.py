#!/usr/bin/env python3
"""One approved trigger; never prints credentials or response bodies.

This program is not an authorization to run a production sync. It deliberately
does not retry: an unsuccessful or ambiguous response requires reconciliation.
"""
import json
import os
import signal
import sys
from urllib.request import HTTPRedirectHandler, Request, build_opener

URL = "https://klyrasrqgxijwrxuoevj.supabase.co/functions/v1/fetch-furry-events"
MAX_RESPONSE = 65536
TIMEOUT_SECONDS = 120


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def valid_receipt(value):
    if not isinstance(value, dict):
        return False
    fetched = value.get("fetched")
    upserted = value.get("upserted")
    deactivated = value.get("deactivated")
    return (
        value.get("success") is True
        and value.get("source") == "fcc"
        and ("empty" not in value or value["empty"] is False)
        and type(fetched) is int and 0 < fetched <= 10000
        and type(upserted) is int and upserted == fetched
        and type(deactivated) is int and deactivated >= 0
        and value.get("errors") == []
    )


def _deadline_expired(_signum, _frame):
    raise TimeoutError("trigger deadline exceeded")


def run():
    jwt = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    secret = os.environ.get("FUNCTION_SECRET", "")
    if not jwt or not secret or any(c in jwt or c in secret for c in "\r\n"):
        print("所需进程凭据缺失或无效；未发送请求。", file=sys.stderr)
        return 2

    trigger = "scheduled" if os.environ.get("GITHUB_EVENT_NAME") == "schedule" else "manual"

    req = Request(
        URL,
        data=b'{"allow_empty":false}',
        headers={
            "Authorization": "Bearer " + jwt,
            "x-function-secret": secret,
            "Content-Type": "application/json",
            "x-sync-trigger": trigger,
        },
        method="POST",
    )
    # The operator runs this as a standalone process on Linux. The wall-clock
    # deadline complements urllib's socket timeout, including slow responses.
    old_handler = signal.signal(signal.SIGALRM, _deadline_expired)
    signal.setitimer(signal.ITIMER_REAL, TIMEOUT_SECONDS)
    try:
        # The default HTTPS context keeps certificate verification enabled. The
        # redirect handler rejects all redirects, including same-origin ones.
        opener = build_opener(NoRedirect())
        with opener.open(req, timeout=TIMEOUT_SECONDS) as response:
            if response.status != 200:
                raise ValueError("invalid status")
            body = response.read(MAX_RESPONSE + 1)
            if len(body) > MAX_RESPONSE:
                raise ValueError("oversized receipt")
        receipt = json.loads(body.decode("utf-8"))
        if not valid_receipt(receipt):
            raise ValueError("invalid receipt")
    except Exception:
        # Do not print exception text: it may contain headers, URLs or bodies.
        print("未确认同步结果；请先核对数据库提交状态，禁止盲目重试。", file=sys.stderr)
        return 1
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old_handler)
    print(f"收到有效同步回执：fetched={receipt['fetched']} upserted={receipt['upserted']} deactivated={receipt['deactivated']}；仍须核对数据库来源、数量和唯一 UUID。")
    return 0


if __name__ == "__main__":
    sys.exit(run())
