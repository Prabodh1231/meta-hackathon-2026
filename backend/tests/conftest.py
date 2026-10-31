import httpx
import pytest

from app.openaccess import OpenAccess


def _offline(req: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("Tests never reach the scholarly indexes", request=req)


@pytest.fixture(autouse=True)
def no_scholarly_indexes(monkeypatch):
    """Imports look papers up in OpenAlex and Crossref. A client made without a test transport
    behaves as if offline, so no test reaches the real services."""
    original = OpenAccess.__init__

    def offline(self, *args, transport=None, **kwargs):
        original(self, *args, transport=transport or httpx.MockTransport(_offline), **kwargs)

    monkeypatch.setattr(OpenAccess, "__init__", offline)
