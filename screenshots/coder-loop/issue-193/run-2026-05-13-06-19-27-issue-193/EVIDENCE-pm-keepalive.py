#!/usr/bin/env python3
"""PM mailbox heartbeat-keepalive poller for #193 retry #8.

- Registers pm-issue193/main with the exchange (re-register on tombstone)
- Every POLL_INTERVAL seconds posts a heartbeat.ping to advance last_seen
  AND drains its own inbox; appends every non-empty inbox to NDJSON
  evidence file with a wall-clock timestamp.
- Writes a single 'snapshot' JSON file on each poll for review.
- Designed to outlive PM heartbeat timeout (90s) by polling every 15s.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

EXCHANGE_URL = os.environ.get("EXCHANGE_URL", "http://127.0.0.1:18787")
PM_ID = os.environ.get("PM_ID", "pm-issue193/main")
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL", "15"))
SENDER_HEADER = "x-agent-channel-sender"
SCHEMA_VERSION = "0.1.0"

EVIDIR = os.environ["EVIDIR"]
os.makedirs(EVIDIR, exist_ok=True)
INBOX_NDJSON = os.path.join(EVIDIR, "pm-keepalive-inbox.ndjson")
RUN_LOG = os.path.join(EVIDIR, "pm-keepalive-run.log")
LATEST = os.path.join(EVIDIR, "pm-keepalive-latest.json")


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
        f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"


def ulid() -> str:
    # not real ULID but good enough as a uuid-shaped msg_id for ping
    return "PING-" + uuid.uuid4().hex.upper()[:20]


def post_json(path: str, body: dict, sender: str | None = None) -> tuple[int, dict | str]:
    req = urllib.request.Request(
        EXCHANGE_URL + path,
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    if sender is not None:
        req.add_header(SENDER_HEADER, sender)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(payload)
            except json.JSONDecodeError:
                return resp.status, payload
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")


def log(msg: str) -> None:
    line = f"[{now_iso()}] {msg}"
    print(line, flush=True)
    with open(RUN_LOG, "a") as f:
        f.write(line + "\n")


def register() -> None:
    env = {
        "msg_id": ulid(),
        "from": PM_ID,
        "to": "exchange/system",
        "ts": now_iso(),
        "schema_version": SCHEMA_VERSION,
        "body": {
            "kind": "register.request",
            "payload": {
                "schema_version": SCHEMA_VERSION,
                "identity": {
                    "agent_kind": "pm-agent",
                    "instance_label": PM_ID,
                },
                "desired_channel_id": PM_ID,
                "capabilities": ["channel.send", "channel.receive", "discovery.list"],
            },
        },
    }
    status, body = post_json("/v1/register", env)
    log(f"register: {status} body_keys={list(body.keys()) if isinstance(body, dict) else 'str'}")


def ping_and_drain() -> dict:
    env = {
        "msg_id": ulid(),
        "from": PM_ID,
        "to": "exchange/system",
        "ts": now_iso(),
        "schema_version": SCHEMA_VERSION,
        "body": {"kind": "heartbeat.ping", "payload": {}},
    }
    status, body = post_json("/v1/envelope", env, sender=PM_ID)
    return {"status": status, "response_body": body}


def main() -> None:
    log(f"start EXCHANGE_URL={EXCHANGE_URL} PM_ID={PM_ID} POLL_INTERVAL={POLL_INTERVAL}s")
    log(f"evidence file: {INBOX_NDJSON}")
    # Try register; if already registered (409), keep going.
    register()
    seen_msg_ids: set[str] = set()
    poll_count = 0
    try:
        while True:
            poll_count += 1
            try:
                result = ping_and_drain()
            except Exception as e:  # noqa: BLE001
                log(f"poll#{poll_count} EXCEPTION {type(e).__name__}: {e}")
                # try re-register and continue
                try:
                    register()
                except Exception as ee:  # noqa: BLE001
                    log(f"re-register EXCEPTION: {ee}")
                time.sleep(POLL_INTERVAL)
                continue
            status = result["status"]
            resp_body = result["response_body"]
            inbox = resp_body.get("inbox", []) if isinstance(resp_body, dict) else []
            log(f"poll#{poll_count} status={status} inbox_count={len(inbox)}")
            # Write snapshot every poll.
            snapshot = {
                "polled_at": now_iso(),
                "poll_count": poll_count,
                "status": status,
                "inbox_count": len(inbox),
                "inbox": inbox,
            }
            with open(LATEST, "w") as f:
                json.dump(snapshot, f, indent=2)
            # Append any new envelopes to NDJSON.
            for env in inbox:
                if not isinstance(env, dict):
                    continue
                mid = env.get("msg_id")
                if isinstance(mid, str) and mid not in seen_msg_ids:
                    seen_msg_ids.add(mid)
                    with open(INBOX_NDJSON, "a") as f:
                        f.write(json.dumps({"observed_at": now_iso(), "envelope": env}) + "\n")
                    log(f"NEW envelope msg_id={mid} from={env.get('from')} body.kind={env.get('body', {}).get('kind') if isinstance(env.get('body'), dict) else None}")
            # If response indicates we got deregistered, re-register.
            response_env = resp_body.get("response") if isinstance(resp_body, dict) else None
            if isinstance(response_env, dict):
                body = response_env.get("body", {})
                if isinstance(body, dict) and body.get("kind") == "deliver.error":
                    payload = body.get("payload", {})
                    if isinstance(payload, dict) and payload.get("error") == "mailbox_deregistered":
                        log("got mailbox_deregistered, re-registering...")
                        register()
            time.sleep(POLL_INTERVAL)
    except KeyboardInterrupt:
        log("KeyboardInterrupt, exiting")
        sys.exit(0)


if __name__ == "__main__":
    main()
