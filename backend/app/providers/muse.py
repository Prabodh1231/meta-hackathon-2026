"""Meta Muse provider (Meta Model API, OpenAI-compatible Chat Completions).

Checked against https://dev.meta.ai/docs/protocols/chat-completions and live calls to
muse-spark-1.3: Bearer auth, POST {base}/chat/completions, `response_format` json_schema,
text at choices[0].message.content.

Muse reasons before it answers, and those tokens count against `max_completion_tokens`:
a one-line JSON verdict used ~500 of them. Each call therefore gets the caller's answer
budget plus REASONING_HEADROOM, and a reply cut off by the limit raises instead of
returning half a JSON object.
"""

import base64
import json
import random
import re
import time

import httpx

from . import activity, prompts
from .base import LLMProvider

REASONING_HEADROOM = 4096
RETRY_STATUS = {429, 500, 502, 503, 504}
# Search help is one small call behind an interactive search, so it gets a much shorter
# wait than the 180 s a long drafting or proposal call may need.
SEARCH_TIMEOUT = 20.0
# Ranking 20 short passages at "minimal" effort took 9 s against 17 s at "low" (5 Nov).
SEARCH_EFFORT = "minimal"
# A support check is one short verdict, and its time is its reasoning: on 24 claim and
# passage pairs from a real library (14 Nov) a check took 7.8 s at "medium", 4.6 s at "low"
# and 2.2 s at "minimal". "low" gave medium's verdict on 22 of 24, which is as often as
# medium agrees with itself (7 of 8 on a second run); "minimal" on 20 of 24. So checks run
# at "low" whatever effort is chosen for writing.
CHECK_EFFORT = "low"


class MuseError(RuntimeError):
    pass


class MuseProvider(LLMProvider):
    name = "muse"

    def __init__(self, api_base: str, api_key: str, model: str, reasoning_effort: str = "low",
                 timeout: float = 180.0, retries: int = 3, transport: httpx.BaseTransport | None = None):
        if not api_base or not api_key:
            raise ValueError("MUSE_API_BASE and MUSE_API_KEY must be set to use the Muse provider")
        self.model = model
        self.reasoning_effort = reasoning_effort
        self.retries = retries
        self.client = httpx.Client(
            base_url=api_base.rstrip("/"),
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout,
            transport=transport,
        )

    def chat(self, messages, *, schema=None, max_tokens=1024, temperature=0.2,
             reasoning_effort: str | None = None, timeout: float | None = None, retries: int | None = None) -> str:
        # temperature is not sent: Meta's docs say Muse Spark does best at its default.
        payload: dict = {
            "model": self.model,
            "messages": messages,
            "max_completion_tokens": max_tokens + REASONING_HEADROOM,
        }
        effort = self.reasoning_effort if reasoning_effort is None else reasoning_effort
        if effort:
            payload["reasoning_effort"] = effort
        if schema is not None:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "result", "schema": schema, "strict": True},
            }
        choice = self._post(payload, timeout=timeout, retries=retries)["choices"][0]
        content = choice["message"].get("content") or ""
        if choice.get("finish_reason") == "length":
            raise MuseError("Muse hit its output limit before finishing the answer")
        if not content.strip():
            raise MuseError(choice["message"].get("refusal") or "Muse returned an empty answer")
        return content

    def _post(self, payload: dict, timeout: float | None = None, retries: int | None = None) -> dict:
        retries = self.retries if retries is None else retries
        for attempt in range(retries + 1):
            try:
                resp = (self.client.post("/chat/completions", json=payload, timeout=timeout)
                        if timeout is not None else self.client.post("/chat/completions", json=payload))
            except httpx.TransportError:
                if attempt == retries:
                    raise
                why = "didn't answer"
            else:
                if resp.status_code not in RETRY_STATUS or attempt == retries:
                    if resp.is_error:
                        raise MuseError(f"Muse API error {resp.status_code}: {resp.text[:300]}")
                    return resp.json()
                why = "is busy (rate limit)" if resp.status_code == 429 else f"had a server error ({resp.status_code})"
            wait = min(2 ** attempt, 8) + random.random()  # backoff with jitter
            activity.note("retry", f"Muse {why}; trying again in {wait:.0f} s (attempt {attempt + 2} of {retries + 1}).")
            time.sleep(wait)
        raise AssertionError("unreachable")

    def transcribe_image(self, data: bytes, mime: str) -> str:
        url = f"data:{mime};base64,{base64.b64encode(data).decode()}"
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompts.OCR_PROMPT},
                    {"type": "image_url", "image_url": {"url": url}},
                ],
            }
        ]
        return self.chat(messages, max_tokens=4096, temperature=0.0)

    def _check_json(self, system: str, user: str, schema: dict, max_tokens: int) -> dict:
        # The usual timeout and retries: a verdict is worth waiting for, unlike search help.
        raw = self.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            schema=schema,
            max_tokens=max_tokens,
            reasoning_effort=CHECK_EFFORT,
        )
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip())
        return json.loads(raw)

    def _search_json(self, system: str, user: str, schema: dict, max_tokens: int) -> dict:
        # Minimal effort, a short timeout and no retries: search should fall back to keyword
        # order rather than stall (a retry after a timeout turned one slow call into a
        # minute). The base task methods turn any error here into that fallback.
        raw = self.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            schema=schema,
            max_tokens=max_tokens,
            reasoning_effort=SEARCH_EFFORT,
            timeout=SEARCH_TIMEOUT,
            retries=0,
        )
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip())
        return json.loads(raw)
