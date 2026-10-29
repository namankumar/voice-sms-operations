#!/usr/bin/env python3
"""Offline replay of a few request-resolution controls.

All inputs are synthetic. This module has no network, telephony, model, or
provider dependencies; it is deliberately smaller than the runtime patterns
that informed it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class Request:
    request_id: str
    state: str = "capturing_message"
    message: str | None = None
    callback_window: str | None = None
    handoff_owner: str | None = None
    handoff_deadline: str | None = None
    events: list[str] = field(default_factory=lambda: ["request.received"])


@dataclass(frozen=True)
class Receipt:
    status: str
    request_id: str
    state: str
    events: tuple[str, ...]
    replayed: bool = False
    detail: str | None = None


class OfflineRequestReplay:
    """A synthetic in-memory reducer with strict idempotency-key semantics."""

    def __init__(self, request_id: str = "synthetic-request-001") -> None:
        self.request = Request(request_id=request_id)
        self._idempotency: dict[str, tuple[str, Receipt]] = {}

    def confirm_callback(
        self, *, idempotency_key: str, message: str, callback_window: str
    ) -> Receipt:
        payload = {"action": "confirm_callback", "message": message, "callback_window": callback_window}
        prior = self._replay_or_conflict(idempotency_key, payload)
        if prior is not None:
            return prior
        if self.request.state != "capturing_message":
            return self._store(idempotency_key, payload, self._receipt("blocked", "confirmation_not_available"))
        if not message.strip() or not callback_window.strip():
            return self._store(idempotency_key, payload, self._receipt("blocked", "message_and_callback_window_required"))

        self.request.message = message
        self.request.callback_window = callback_window
        self.request.state = "needs_callback"
        self.request.events.append("callback.confirmed")
        return self._store(idempotency_key, payload, self._receipt("saved"))

    def request_handoff(self, *, idempotency_key: str, reason: str) -> Receipt:
        payload = {"action": "request_handoff", "reason": reason}
        prior = self._replay_or_conflict(idempotency_key, payload)
        if prior is not None:
            return prior
        if self.request.state not in {"capturing_message", "needs_callback", "handoff_pending"}:
            return self._store(idempotency_key, payload, self._receipt("blocked", "handoff_not_available"))
        if not reason.strip():
            return self._store(idempotency_key, payload, self._receipt("blocked", "handoff_reason_required"))

        if self.request.state == "handoff_pending":
            return self._store(idempotency_key, payload, self._receipt("handoff_pending"))
        self.request.state = "handoff_pending"
        self.request.events.append("handoff.requested")
        return self._store(idempotency_key, payload, self._receipt("handoff_pending"))

    def accept_handoff(
        self, *, idempotency_key: str, owner: str, deadline: str
    ) -> Receipt:
        payload = {"action": "accept_handoff", "owner": owner, "deadline": deadline}
        prior = self._replay_or_conflict(idempotency_key, payload)
        if prior is not None:
            return prior
        if self.request.state != "handoff_pending":
            return self._store(idempotency_key, payload, self._receipt("blocked", "pending_handoff_required"))
        if not owner.strip() or not deadline.strip():
            return self._store(idempotency_key, payload, self._receipt("blocked", "owner_and_deadline_required"))

        self.request.handoff_owner = owner
        self.request.handoff_deadline = deadline
        self.request.state = "callback_owned"
        self.request.events.append("handoff.accepted")
        return self._store(idempotency_key, payload, self._receipt("callback_owned"))

    def snapshot(self) -> dict[str, Any]:
        return asdict(self.request)

    def _receipt(self, status: str, detail: str | None = None) -> Receipt:
        return Receipt(status, self.request.request_id, self.request.state, tuple(self.request.events), detail=detail)

    def _replay_or_conflict(self, key: str, payload: dict[str, str]) -> Receipt | None:
        if not key.strip():
            return self._receipt("blocked", "idempotency_key_required")
        previous = self._idempotency.get(key)
        if previous is None:
            return None
        fingerprint, receipt = previous
        if fingerprint != _fingerprint(payload):
            return self._receipt("conflict", "idempotency_key_reused_with_different_input")
        return Receipt(**{**asdict(receipt), "replayed": True})

    def _store(self, key: str, payload: dict[str, str], receipt: Receipt) -> Receipt:
        if key.strip():
            self._idempotency[key] = (_fingerprint(payload), receipt)
        return receipt


def _fingerprint(payload: dict[str, str]) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def confirmation_scenario() -> dict[str, Any]:
    replay = OfflineRequestReplay()
    first = replay.confirm_callback(
        idempotency_key="synthetic-confirm-v1",
        message="Please return my call about an upcoming visit.",
        callback_window="weekday afternoon",
    )
    exact_replay = replay.confirm_callback(
        idempotency_key="synthetic-confirm-v1",
        message="Please return my call about an upcoming visit.",
        callback_window="weekday afternoon",
    )
    changed_replay = replay.confirm_callback(
        idempotency_key="synthetic-confirm-v1",
        message="Different synthetic message.",
        callback_window="weekday afternoon",
    )
    return {"first": asdict(first), "exact_replay": asdict(exact_replay), "changed_replay": asdict(changed_replay), "snapshot": replay.snapshot()}


def handoff_scenario() -> dict[str, Any]:
    replay = OfflineRequestReplay()
    pending = replay.request_handoff(idempotency_key="synthetic-handoff-v1", reason="caller_requested_person")
    accepted = replay.accept_handoff(
        idempotency_key="synthetic-handoff-accept-v1",
        owner="synthetic-queue",
        deadline="within one business day",
    )
    return {"pending": asdict(pending), "accepted": asdict(accepted), "snapshot": replay.snapshot()}


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a synthetic offline request-state replay.")
    parser.add_argument("--scenario", choices=("confirmation", "handoff"), default="confirmation")
    args = parser.parse_args()
    result = confirmation_scenario() if args.scenario == "confirmation" else handoff_scenario()
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
