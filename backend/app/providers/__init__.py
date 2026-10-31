from ..settings import Settings
from .base import LLMProvider, Passage
from .mock import MockProvider

__all__ = ["LLMProvider", "Passage", "MockProvider", "make_provider"]


def make_provider(settings: Settings) -> LLMProvider:
    if settings.provider == "mock":
        return MockProvider()
    if settings.provider == "muse":
        from .failover import FailoverProvider
        from .muse import MuseProvider

        effort = settings.muse_reasoning_effort
        route = settings.route
        # With a backup, each route retries once and then hands over, instead of backing off for
        # about 15 seconds first; alone, a route keeps its full retries.
        retries = 1 if route == "baseten-first" and settings.muse_api_key and settings.baseten_api_key else 3
        routes = []
        if route in ("baseten-first", "baseten"):
            if not settings.baseten_api_key:
                raise ValueError("Add a Baseten API key to use Muse on Baseten")
            routes.append(("baseten", MuseProvider(settings.baseten_muse_base, settings.baseten_api_key,
                                                   settings.baseten_muse_model, reasoning_effort=effort, retries=retries)))
        if route in ("baseten-first", "meta") and settings.muse_api_key:
            routes.append(("meta", MuseProvider(settings.muse_api_base, settings.muse_api_key, settings.muse_model,
                                                reasoning_effort=effort, retries=retries)))
        if not routes:
            # Raised by MuseProvider itself with the message the app shows for a missing key.
            MuseProvider(settings.muse_api_base, settings.muse_api_key, settings.muse_model)
        if len(routes) == 1:  # nothing to fail over to
            label, provider = routes[0]
            provider.route = [label]
            return provider
        return FailoverProvider(routes)
    raise ValueError(f"Unknown RC_PROVIDER {settings.provider!r} (expected 'mock' or 'muse')")
