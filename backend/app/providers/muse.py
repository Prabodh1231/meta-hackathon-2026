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
import random
import time

import httpx

from . import activity, prompts
from .base import LLMProvider

REASONING_HEADROOM = 4096
RETRY_STATUS = {429, 500, 502, 503, 504}


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

    def chat(self, messages, *, schema=None, max_tokens=1024, temperature=0.2) -> str:
        # temperature is not sent: Meta's docs say Muse Spark does best at its default.
        payload: dict = {
            "model": self.model,
            "messages": messages,
            "max_completion_tokens": max_tokens + REASONING_HEADROOM,
        }
        if self.reasoning_effort:
            payload["reasoning_effort"] = self.reasoning_effort
        if schema is not None:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "result", "schema": schema, "strict": True},
            }
        choice = self._post(payload)["choices"][0]
        content = choice["message"].get("content") or ""
        if choice.get("finish_reason") == "length":
            raise MuseError("Muse hit its output limit before finishing the answer")
        if not content.strip():
            raise MuseError(choice["message"].get("refusal") or "Muse returned an empty answer")
        return content

    def _post(self, payload: dict) -> dict:
        for attempt in range(self.retries + 1):
            try:
                resp = self.client.post("/chat/completions", json=payload)
            except httpx.TransportError:
                if attempt == self.retries:
                    raise
                why = "didn't answer"
            else:
                if resp.status_code not in RETRY_STATUS or attempt == self.retries:
                    if resp.is_error:
                        raise MuseError(f"Muse API error {resp.status_code}: {resp.text[:300]}")
                    return resp.json()
                why = "is busy (rate limit)" if resp.status_code == 429 else f"had a server error ({resp.status_code})"
            wait = min(2 ** attempt, 8) + random.random()  # backoff with jitter
            activity.note("retry", f"Muse {why}; trying again in {wait:.0f} s (attempt {attempt + 2} of {self.retries + 1}).")
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
