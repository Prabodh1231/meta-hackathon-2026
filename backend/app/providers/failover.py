"""Muse through more than one service: each request goes to the first that answers.

Muse Spark is reachable through Meta's Model API and, with the hackathon's access, through
Baseten's Model APIs, which measured about twice as fast (folder scoring 4.1 s against 7.8 s).
The first route takes every request; when it fails (an error after its own retry, a rate limit,
an outage) the request goes to the next, and the failed route is skipped for a while so later
requests don't each wait for it to fail again.
"""

import logging
import threading
import time

from . import activity
from .base import LLMProvider

log = logging.getLogger(__name__)

COOLDOWN = 60.0  # seconds a route that just failed is passed over
ROUTE_NAMES = {"baseten": "Baseten", "meta": "Meta's API"}  # for the UI's activity notes


class FailoverProvider(LLMProvider):
    name = "muse"

    def __init__(self, routes: list[tuple[str, LLMProvider]], cooldown: float = COOLDOWN):
        if not routes:
            raise ValueError("FailoverProvider needs at least one route")
        self.routes = routes  # (label, provider), in the order to try them
        self.cooldown = cooldown
        self._down_until: dict[str, float] = {}
        self._lock = threading.Lock()

    @property
    def route(self) -> list[str]:
        return [label for label, _ in self.routes]

    def _order(self) -> list[tuple[str, LLMProvider]]:
        # Routes resting after a failure go last, not out: if every route failed lately, still try them.
        now = time.monotonic()
        with self._lock:
            resting = {label for label, until in self._down_until.items() if until > now}
        return [r for r in self.routes if r[0] not in resting] + [r for r in self.routes if r[0] in resting]

    def _call(self, method: str, *args, **kwargs):
        error: Exception | None = None
        order = self._order()
        for i, (label, provider) in enumerate(order):
            try:
                result = getattr(provider, method)(*args, **kwargs)
            except Exception as exc:  # the next route may answer what this one couldn't
                log.warning("Muse via %s failed (%s); trying the next route", label, str(exc)[:200])
                if i + 1 < len(order):
                    activity.note("switch", f"Muse via {ROUTE_NAMES.get(label, label)} didn't answer; asking it via {ROUTE_NAMES.get(order[i + 1][0], order[i + 1][0])} instead.")
                with self._lock:
                    self._down_until[label] = time.monotonic() + self.cooldown
                error = exc
                continue
            with self._lock:
                self._down_until.pop(label, None)
            return result
        raise error  # type: ignore[misc]  # every route failed: the last error explains it

    def chat(self, messages, *, schema=None, max_tokens=1024, temperature=0.2) -> str:
        return self._call("chat", messages, schema=schema, max_tokens=max_tokens, temperature=temperature)

    def transcribe_image(self, data: bytes, mime: str) -> str:
        return self._call("transcribe_image", data, mime)
