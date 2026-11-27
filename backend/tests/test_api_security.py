"""Who may call the backend: a server never runs without a token unless told to, and only the app's
own page (app://groundwork) or a loopback page gets CORS access, never the "null" origin."""

import pytest
from fastapi.testclient import TestClient

from app.library import Library
from app.main import APP_ORIGIN, create_app, require_token
from app.providers import MockProvider
from app.settings import Settings


@pytest.fixture
def no_token_env(tmp_path, monkeypatch):
    monkeypatch.setenv("RC_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("RC_API_TOKEN", raising=False)
    monkeypatch.delenv("RC_ALLOW_NO_TOKEN", raising=False)
    return tmp_path / "data"


def test_server_refuses_to_start_without_a_token(no_token_env):
    with pytest.raises(RuntimeError, match="RC_API_TOKEN"):
        create_app()  # what `uvicorn app.main:app` and the packaged backend call


def test_data_folder_env_file_cannot_switch_the_check_off(no_token_env):
    # The app writes that file itself (keys, provider), so it must not be able to turn the check off.
    no_token_env.mkdir(parents=True)
    (no_token_env / ".env").write_text("RC_ALLOW_NO_TOKEN=1\n", encoding="utf-8")
    assert Settings.from_env().allow_no_token is False
    with pytest.raises(RuntimeError):
        create_app()


def test_opting_out_needs_the_real_environment(no_token_env, monkeypatch):
    monkeypatch.setenv("RC_ALLOW_NO_TOKEN", "1")
    settings = Settings.from_env()
    assert settings.allow_no_token is True
    require_token(settings)  # no error: the person running it asked for no check


def test_a_token_is_enough(tmp_path):
    require_token(Settings(data_dir=tmp_path, api_token="secret"))
    with pytest.raises(RuntimeError):
        require_token(Settings(data_dir=tmp_path))


@pytest.fixture
def client(tmp_path):
    settings = Settings(data_dir=tmp_path / "d", api_token="secret")
    return TestClient(create_app(settings, Library(settings, provider=MockProvider())))


@pytest.mark.parametrize("token", [None, "", "secreT", "secret2", "secre"])
def test_wrong_token_is_refused(client, token):
    headers = {} if token is None else {"x-rc-token": token}
    assert client.get("/documents", headers=headers).status_code == 401


def preflight(client, origin):
    return client.options("/documents", headers={
        "Origin": origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-rc-token"})


@pytest.mark.parametrize("origin", [APP_ORIGIN, "http://127.0.0.1:5173", "http://localhost:8790"])
def test_app_and_loopback_pages_get_cors(client, origin):
    res = preflight(client, origin)
    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] == origin
    got = client.get("/documents", headers={"Origin": origin, "x-rc-token": "secret"})
    assert got.headers["access-control-allow-origin"] == origin


@pytest.mark.parametrize("origin", ["null", "https://example.com", "http://127.0.0.1.example.com",
                                    "app://groundwork.example.com", "file://"])
def test_other_origins_get_no_cors(client, origin):
    assert "access-control-allow-origin" not in preflight(client, origin).headers
    got = client.get("/documents", headers={"Origin": origin, "x-rc-token": "secret"})
    assert "access-control-allow-origin" not in got.headers
