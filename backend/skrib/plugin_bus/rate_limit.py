"""Token bucket rate limiter for plugin bus connections."""
from __future__ import annotations

import time


class TokenBucket:
    """Simple token bucket rate limiter.

    Args:
        rate: tokens added per second
        burst: maximum tokens (bucket capacity)
    """

    def __init__(self, rate: float = 100.0, burst: float = 200.0):
        self.rate = rate
        self.burst = burst
        self._tokens = burst
        self._last_refill = time.monotonic()

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self._last_refill
        self._tokens = min(self.burst, self._tokens + elapsed * self.rate)
        self._last_refill = now

    def consume(self, tokens: float = 1.0) -> bool:
        """Try to consume tokens. Returns True if allowed, False if rate limited."""
        self._refill()
        if self._tokens >= tokens:
            self._tokens -= tokens
            return True
        return False
