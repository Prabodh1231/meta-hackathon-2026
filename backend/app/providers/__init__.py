from ..settings import Settings
from .base import LLMProvider, Passage
from .mock import MockProvider

__all__ = ["LLMProvider", "Passage", "MockProvider", "make_provider"]


def make_provider(settings: Settings) -> LLMProvider:
    if settings.provider == "mock":
        return MockProvider()
    if settings.provider == "muse":
        from .muse import MuseProvider

        # Muse Spark through Meta's Model API; a missing key raises the message the app shows.
        return MuseProvider(settings.muse_api_base, settings.muse_api_key, settings.muse_model,
                            reasoning_effort=settings.muse_reasoning_effort)
    raise ValueError(f"Unknown RC_PROVIDER {settings.provider!r} (expected 'mock' or 'muse')")
