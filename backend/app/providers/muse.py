"""Meta Muse (Meta Model API) provider.

ASSUMPTION: the request/response shape below is OpenAI-style chat completions. It has not
been checked against Meta's Model API docs (no access yet). When access lands, confirm the
endpoint path, auth header, JSON-schema parameter, image input format and model id; only
`chat` and `transcribe_image` should need to change.
"""

import base64

import httpx

from .base import LLMProvider
from . import prompts


class MuseProvider(LLMProvider):
    name = "muse"

    def __init__(self, api_base: str, api_key: str, model: str, timeout: float = 120.0):
        if not api_base or not api_key:
            raise ValueError("MUSE_API_BASE and MUSE_API_KEY must be set to use the Muse provider")
        self.model = model
        self.client = httpx.Client(
            base_url=api_base.rstrip("/"),
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout,
        )

    def chat(self, messages, *, schema=None, max_tokens=1024, temperature=0.2) -> str:
        payload: dict = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if schema is not None:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "result", "schema": schema},
            }
        resp = self.client.post("/chat/completions", json=payload)
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]

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
