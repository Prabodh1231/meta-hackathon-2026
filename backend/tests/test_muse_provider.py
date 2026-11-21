import json

import httpx
import pytest

from app.providers import make_provider
from app.providers.muse import CHECK_EFFORT, REASONING_HEADROOM, SEARCH_EFFORT, SEARCH_MODEL, MuseError, MuseProvider
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


@pytest.mark.parametrize("name", ["METADATA", "TAGS", "TOPIC", "DRAFT", "JUDGE", "EXPAND_QUERY", "RANK_PASSAGES"])
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


def test_expand_query_is_one_search_effort_call():
    seen = []

    def handler(request):
        seen.append(json.loads(request.content))
        return reply('{"queries": ["sleep spindle memory", "targeted memory reactivation"]}')

    muse = provider(handler, reasoning_effort="high")
    assert muse.expand_query("how does sleep help memory") == ["sleep spindle memory", "targeted memory reactivation"]
    assert len(seen) == 1 and seen[0]["reasoning_effort"] == SEARCH_EFFORT
    assert seen[0]["response_format"]["json_schema"]["strict"] is True
    assert seen[0]["response_format"]["json_schema"]["schema"]["additionalProperties"] is False


def test_search_calls_are_not_retried_after_a_timeout():
    # A retry after a timeout once turned one slow ranking call into a minute-long search;
    # search help gives up at once and the caller keeps the keyword order.
    calls = []

    def handler(request):
        calls.append(1)
        raise httpx.ReadTimeout("slow", request=request)

    muse = provider(handler)
    assert muse.expand_query("how does sleep help memory") == []
    assert muse.rank_passages("sleep", [(7, "a passage")]) is None
    assert len(calls) == 2  # one attempt each, no retries


def test_rank_passages_scores_in_input_order_from_one_trimmed_call():
    seen = []

    def handler(request):
        seen.append(json.loads(request.content))
        return reply('{"scores": [{"id": 9, "score": 0.2}, {"id": 7, "score": 0.9}]}')

    muse = provider(handler, reasoning_effort="high")
    assert muse.rank_passages("sleep", [(7, "x" * 800), (9, "short passage")]) == [0.9, 0.2]
    assert len(seen) == 1 and seen[0]["reasoning_effort"] == SEARCH_EFFORT
    user = seen[0]["messages"][1]["content"]
    assert "x" * 700 in user and "x" * 701 not in user


def test_search_calls_fall_back_on_a_bad_answer():
    muse = provider(lambda request: reply("not json"))
    assert muse.expand_query("sleep memory") == []
    assert muse.rank_passages("sleep memory", [(1, "A passage about sleep.")]) is None


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


def test_support_checks_keep_their_own_effort_whatever_writing_uses():
    seen = []

    def handler(request):
        seen.append(json.loads(request.content))
        return reply('{"verdict": "partial", "reason": "close"}')

    muse = provider(handler, reasoning_effort="high")
    assert muse.judge_support("Water boils at 100 C.", "Water boils near 100 degrees.")["verdict"] == "partial"
    muse.chat([{"role": "user", "content": "Write a paragraph."}])
    assert [body["reasoning_effort"] for body in seen] == [CHECK_EFFORT, "high"]


def test_search_help_runs_on_the_search_model_and_everything_else_on_the_main_one():
    seen = []

    def handler(request):
        body = json.loads(request.content)
        seen.append(body["model"])
        if "expand" in body["messages"][0]["content"]:
            return reply('{"queries": ["sleep spindle memory"]}')
        if "score passages" in body["messages"][0]["content"]:
            return reply('{"scores": [{"id": 7, "score": 0.9}]}')
        return reply('{"verdict": "supported", "reason": "matches"}')

    muse = provider(handler, search_model=SEARCH_MODEL)
    muse.expand_query("how does sleep help memory")
    muse.rank_passages("sleep", [(7, "a passage")])
    muse.judge_support("Water boils at 100 C.", "Water boils at 100 degrees Celsius.")
    assert seen == [SEARCH_MODEL, SEARCH_MODEL, "muse-spark-1.3"]
    assert make_provider(Settings(data_dir=None, provider="muse", muse_api_key="k")).search_model == SEARCH_MODEL


def test_a_key_without_the_search_model_uses_the_main_model_for_search_from_then_on():
    seen = []

    def handler(request):
        model = json.loads(request.content)["model"]
        seen.append(model)
        if model == SEARCH_MODEL:
            return httpx.Response(404, json={"error": {"code": "model_not_found", "message": "The requested model was not found."}})
        return reply('{"queries": ["sleep spindle memory"]}')

    muse = provider(handler, search_model=SEARCH_MODEL)
    assert muse.expand_query("how does sleep help memory") == ["sleep spindle memory"]
    assert muse.expand_query("why do corals bleach") == ["sleep spindle memory"]
    assert seen == [SEARCH_MODEL, "muse-spark-1.3", "muse-spark-1.3"]  # asked once, then not again


@pytest.mark.parametrize("effort, extra", [("minimal", 4096), ("low", 4096), ("medium", 8192),
                                           ("high", 12288), ("xhigh", 16384), ("", 12288)])
def test_reasoning_headroom_grows_with_effort(effort, extra):
    seen = []

    def handler(request):
        seen.append(json.loads(request.content))
        return reply("ok")

    provider(handler, reasoning_effort=effort).chat([{"role": "user", "content": "hi"}], max_tokens=5000)
    assert seen[0]["max_completion_tokens"] == 5000 + extra
    assert ("reasoning_effort" in seen[0]) == bool(effort)


def test_a_rate_limit_waits_as_long_as_the_api_asks_within_reason(monkeypatch):
    waits = []
    monkeypatch.setattr("app.providers.muse.time.sleep", waits.append)
    monkeypatch.setattr("app.providers.muse.random.random", lambda: 0.0)
    calls = iter([httpx.Response(429, headers={"Retry-After": "12"}), httpx.Response(429, headers={"Retry-After": "600"}),
                  httpx.Response(429, headers={"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}), reply("ok")])
    assert provider(lambda r: next(calls)).chat([{"role": "user", "content": "hi"}]) == "ok"
    assert waits == [12.0, 30.0, 4.0]  # as asked; capped at 30 s; a date means the usual backoff


@pytest.mark.parametrize("status, body", [(403, {"error": {"code": "permission_denied", "message": "no"}}),
                                          (404, {"error": "not found"})])
def test_search_falls_back_to_the_main_model_on_other_no_access_answers(status, body):
    seen = []

    def handler(request):
        model = json.loads(request.content)["model"]
        seen.append(model)
        return httpx.Response(status, json=body) if model == SEARCH_MODEL else reply('{"queries": ["sleep spindle memory"]}')

    muse = provider(handler, search_model=SEARCH_MODEL)
    assert muse.expand_query("how does sleep help memory") == ["sleep spindle memory"]
    assert seen == [SEARCH_MODEL, "muse-spark-1.3"]


def test_failed_search_help_is_logged(caplog):
    muse = provider(lambda request: httpx.Response(400, json={"error": {"code": "bad_request", "message": "no"}}))
    with caplog.at_level("WARNING"):
        assert muse.expand_query("sleep memory") == []
        assert muse.rank_passages("sleep memory", [(1, "A passage about sleep.")]) is None
    assert "Query expansion failed" in caplog.text and "Ranking passages failed" in caplog.text


def test_long_matrix_text_is_cut_at_a_whole_line_and_says_so():
    from app.providers.base import fit

    table = "\n".join(f"Study {i} (T): Sample: {'x' * 50}" for i in range(2000))
    out = fit(table, 1000)
    lines = out.splitlines()
    assert all(line.startswith("Study ") and line.endswith("x" * 50) for line in lines[:-1])
    assert lines[-1] == f"(… {2000 - (len(lines) - 1)} more lines left out: too long to send in full.)"
    assert fit("short", 1000) == "short"


def test_repairs_go_in_batches_that_fit_and_stay_lined_up():
    calls = []

    def handler(request):
        user = json.loads(request.content)["messages"][1]["content"]
        calls.append(user)
        n = user.count("\nSentence: ")
        first = int(user.split("Sentence: claim ", 1)[1].split("\n", 1)[0])
        return reply(json.dumps({"rewrites": [f"fixed {first + i}" for i in range(n)]}))

    items = [{"claim": f"claim {i}", "reason": "not backed", "rows": "r" * 20000} for i in range(5)]
    out = provider(handler).repair_claims(items)
    assert out == [f"fixed {i}" for i in range(5)]
    assert len(calls) == 3 and all(len(c) <= 60000 for c in calls)


def test_a_short_batch_of_repairs_stops_the_rest():
    def handler(request):
        return reply(json.dumps({"rewrites": ["only one"]}))

    items = [{"claim": f"claim {i}", "reason": "r", "rows": "r" * 25000} for i in range(4)]
    assert provider(handler).repair_claims(items) == ["only one"]  # never a later batch's rewrite for the wrong item


def test_tags_are_unique_and_folder_scores_round():
    replies = iter([reply('{"tags": ["AI", "ai ", "Sleep"]}'),
                    reply('{"scores": [{"folder": "Sleep", "score": 79.6}, {"folder": "Memory", "score": 12.4}]}')])
    muse = provider(lambda r: next(replies))
    assert muse.tag_document("T", "text") == ["ai", "sleep"]
    assert muse.score_folders("T", "", "text", ["Sleep", "Memory"]) == {"Sleep": 80, "Memory": 12}
