from __future__ import annotations


class JobFailure(Exception):
    """A failure with a stable code and a message that is safe to show to users.

    `retryable` failures (infrastructure hiccups) are re-queued with backoff while attempts remain;
    everything else ends the job immediately. Internal details belong in logs, never in `user_message`.
    """

    def __init__(self, code: str, user_message: str, *, retryable: bool = False, reject_video: bool = False):
        super().__init__(f"{code}: {user_message}")
        self.code = code
        self.user_message = user_message
        self.retryable = retryable
        # The input itself is unacceptable; mark the video rejected so it is not re-analysed.
        self.reject_video = reject_video


class JobCancelled(Exception):
    """The user asked to cancel; stop at the next safe point."""


class LeaseLost(Exception):
    """Another worker owns this job now; stop without writing anything."""
