import json

import httpx
import pytest

from app.providers import make_provider
from app.providers.muse import REASONING_HEADROOM, MuseError, MuseProvider
from app.settings import Settings


def reply(content, finish="stop"):
    return httpx.Response(200, json={"choices": [{"finish_reason": finish, "message": {"role": "assistant", "content": content}}]})


def provider(handler, **kw):
    return MuseProvider("https://api.example/v1", "test-key", "muse-spark-1.3", transport=httpx.MockTransport(handler), **kw)


def test_request_shape_and_json_task():
    seen = []

    def handler(request):
        seen.append((request.url.path, request.headers["authorization"], json.loads(request.content)))
        return reply('{"verdict": "supported", "reason": "matches"}')

    out = provider(handler).judge_support("Water boils at 100 C.", "Water boils at 100 degrees Celsius.")
    assert out["verdict"] == "supported"
    path, auth, body = seen[0]
    assert path == "/v1/chat/completions" and auth == "Bearer test-key"
    assert body["model"] == "muse-spark-1.3" and body["reasoning_effort"] == "low"
    # Reasoning tokens count against the limit, so the answer budget gets headroom on top.
    assert body["max_completion_tokens"] == 200 + REASONING_HEADROOM
    assert "max_tokens" not in body and "temperature" not in body
    assert body["response_format"]["json_schema"]["strict"] is True


@pytest.mark.parametrize("name", ["METADATA", "TAGS", "TOPIC", "DRAFT", "JUDGE"])
def test_schemas_meet_strict_mode(name):
    # Muse's strict json_schema rejects (HTTP 400) any object that isn't closed with
    # additionalProperties: false; strict mode also needs every property required.
    from app.providers import prompts

    def walk(schema):
        if schema.get("type") == "object":
            assert schema.get("additionalProperties") is False
            assert set(schema["required"]) == set(schema["properties"])
            for sub in schema["properties"].values():
                walk(sub)
        elif schema.get("type") == "array":
            walk(schema["items"])

    walk(getattr(prompts, f"{name}_SCHEMA"))


def test_retries_rate_limits_then_succeeds(monkeypatch):
    monkeypatch.setattr("app.providers.muse.time.sleep", lambda s: None)
    calls = iter([httpx.Response(429, json={"error": "slow down"}), httpx.Response(504), reply("ok")])
    assert provider(lambda r: next(calls)).chat([{"role": "user", "content": "hi"}]) == "ok"


def test_cut_off_or_failed_answers_raise(monkeypatch):
    monkeypatch.setattr("app.providers.muse.time.sleep", lambda s: None)
    with pytest.raises(MuseError, match="output limit"):
        provider(lambda r: reply('{"verdict": "supp', finish="length")).chat([])
    with pytest.raises(MuseError, match="401"):
        provider(lambda r: httpx.Response(401, json={"error": "invalid_api_key"})).chat([])


def test_key_file_in_data_dir(tmp_path, monkeypatch):
    for name in ("RC_PROVIDER", "MUSE_API_KEY", "MODEL_API_KEY", "MUSE_MODEL", "MUSE_API_BASE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("RC_DATA_DIR", str(tmp_path))
    (tmp_path / ".env").write_text("# secrets\nRC_PROVIDER=muse\nMODEL_API_KEY='file-key'\n", encoding="utf-8")
    s = Settings.from_env()
    assert (s.provider, s.muse_api_key, s.muse_model) == ("muse", "file-key", "muse-spark-1.3")
    assert s.muse_api_base == "https://api.meta.ai/v1"
    assert isinstance(make_provider(s), MuseProvider)
    monkeypatch.setenv("RC_PROVIDER", "mock")  # real environment variables win
    assert Settings.from_env().provider == "mock"
