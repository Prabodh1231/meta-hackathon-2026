"""What the model is doing behind a slow answer: retries after a rate limit or an error, and
switching from one route to the next. The UI polls it while it waits (GET /model/activity), so a
long wait says why instead of showing only a disabled button. Shared by every request in flight;
a note is short-lived context, not a log (that's backend.log)."""

import threading
import time
from collections import deque

_events: deque[dict] = deque(maxlen=50)
_lock = threading.Lock()


def note(kind: str, text: str) -> None:
    """kind: "retry" (the same route again after a pause), "switch" (the next route) or "stage"
    (which step of a long job is running, e.g. writing a proposal)."""
    with _lock:
        _events.append({"at": time.time(), "kind": kind, "text": text})


def since(t: float) -> list[dict]:
    """Notes from `t` on (seconds since the epoch), oldest first. Inclusive: Windows' clock can give
    a note the same time as the request that asked for notes since then."""
    with _lock:
        return [e for e in _events if e["at"] >= t]
