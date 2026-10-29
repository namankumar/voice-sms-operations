import unittest

from replay import OfflineRequestReplay


class OfflineRequestReplayTests(unittest.TestCase):
    def test_exact_confirmation_replay_returns_original_receipt(self) -> None:
        replay = OfflineRequestReplay()
        first = replay.confirm_callback(idempotency_key="confirm-1", message="Synthetic request", callback_window="tomorrow")
        retried = replay.confirm_callback(idempotency_key="confirm-1", message="Synthetic request", callback_window="tomorrow")
        self.assertEqual(first.status, "saved")
        self.assertTrue(retried.replayed)
        self.assertEqual(replay.snapshot()["events"], ["request.received", "callback.confirmed"])

    def test_changed_replay_is_rejected_without_mutation(self) -> None:
        replay = OfflineRequestReplay()
        replay.confirm_callback(idempotency_key="confirm-1", message="First message", callback_window="tomorrow")
        conflict = replay.confirm_callback(idempotency_key="confirm-1", message="Changed message", callback_window="tomorrow")
        self.assertEqual(conflict.status, "conflict")
        self.assertEqual(replay.snapshot()["message"], "First message")

    def test_handoff_is_not_owned_until_acceptance_has_owner_and_deadline(self) -> None:
        replay = OfflineRequestReplay()
        pending = replay.request_handoff(idempotency_key="handoff-1", reason="caller_requested_person")
        blocked = replay.accept_handoff(idempotency_key="handoff-accept-1", owner="", deadline="tomorrow")
        accepted = replay.accept_handoff(idempotency_key="handoff-accept-2", owner="synthetic-queue", deadline="tomorrow")
        self.assertEqual(pending.status, "handoff_pending")
        self.assertEqual(blocked.status, "blocked")
        self.assertEqual(accepted.status, "callback_owned")
        self.assertEqual(replay.snapshot()["state"], "callback_owned")

    def test_new_handoff_request_cannot_replace_an_owned_callback(self) -> None:
        replay = OfflineRequestReplay()
        replay.request_handoff(idempotency_key="handoff-1", reason="caller_requested_person")
        replay.accept_handoff(idempotency_key="handoff-accept-1", owner="synthetic-queue", deadline="tomorrow")
        before = replay.snapshot()

        blocked = replay.request_handoff(idempotency_key="handoff-2", reason="new_reason")

        self.assertEqual(blocked.status, "blocked")
        self.assertEqual(blocked.detail, "handoff_not_available")
        self.assertEqual(replay.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
