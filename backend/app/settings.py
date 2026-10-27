import os
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Settings:
    data_dir: Path
    provider: str = "mock"  # mock | muse
    embedder: str = "auto"  # auto | fastembed | hash
    # Cross-encoder reranker: auto | none | a fastembed model name. "none" by default here
    # (tests, scripts); from_env() defaults to "auto" so the app uses it.
    reranker: str = "none"
    api_token: str = ""  # set by Electron per launch; empty disables the check
    parent_pid: int = 0  # set by Electron; the backend exits when that process does
    muse_api_base: str = ""
    muse_api_key: str = ""
    muse_model: str = "muse-spark"  # confirm the exact model id in Meta's docs

    @property
    def db_path(self) -> Path:
        return self.data_dir / "library.db"

    @classmethod
    def from_env(cls) -> "Settings":
        env = os.environ.get
        return cls(
            data_dir=Path(env("RC_DATA_DIR") or Path.home() / ".research-companion"),
            provider=env("RC_PROVIDER", "mock").lower(),
            embedder=env("RC_EMBEDDER", "auto").lower(),
            reranker=env("RC_RERANKER", "auto"),
            api_token=env("RC_API_TOKEN", ""),
            parent_pid=int(env("RC_PARENT_PID") or 0),
            muse_api_base=env("MUSE_API_BASE", ""),
            muse_api_key=env("MUSE_API_KEY", ""),
            muse_model=env("MUSE_MODEL", "muse-spark"),
        )
