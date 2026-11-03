import os
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Settings:
    data_dir: Path
    provider: str = "mock"  # mock | muse
    embedder: str = "auto"  # bge-small (fastembed); "hash" for tests and scripts
    # Cross-encoder reranker, always on this computer: auto | local | none | a fastembed model name.
    # "none" by default here (tests, scripts); from_env() defaults to "auto" so the app uses it.
    reranker: str = "none"
    api_token: str = ""  # set by Electron per launch; empty disables the check
    parent_pid: int = 0  # set by Electron; the backend exits when that process does
    muse_api_base: str = "https://api.meta.ai/v1"
    muse_api_key: str = ""
    muse_model: str = "muse-spark-1.3"
    muse_reasoning_effort: str = "low"  # minimal | low | medium | high | xhigh
    contact_email: str = ""  # sent to OpenAlex, Semantic Scholar and Crossref when finding cited papers (polite pool)
    core_api_key: str = ""  # CORE (core.ac.uk) is searched for free copies only with the user's own key
    # The search models shipped with the installer (scripts/fetch_models.py), read-only. A model
    # found there loads from it; otherwise it downloads into <data dir>/models on first use.
    models_dir: Path | None = None

    @property
    def db_path(self) -> Path:
        return self.data_dir / "library.db"

    @classmethod
    def from_env(cls) -> "Settings":
        """Settings from environment variables, falling back to `<data dir>/.env`. The key
        lives there, in the user's data folder, so it never sits inside the repository."""
        data_dir = Path(os.environ.get("RC_DATA_DIR") or Path.home() / ".research-companion")
        file_vars = read_env_file(data_dir / ".env")

        def env(name: str, default: str = "") -> str:
            return os.environ.get(name) or file_vars.get(name) or default

        return cls(
            data_dir=data_dir,
            provider=env("RC_PROVIDER", "mock").lower(),
            embedder=env("RC_EMBEDDER", "auto").lower(),
            reranker=env("RC_RERANKER", "auto"),
            api_token=env("RC_API_TOKEN"),
            parent_pid=int(env("RC_PARENT_PID") or 0),
            muse_api_base=env("MUSE_API_BASE", cls.muse_api_base),
            # MODEL_API_KEY is the name Meta's docs use.
            muse_api_key=env("MUSE_API_KEY") or env("MODEL_API_KEY"),
            muse_model=env("MUSE_MODEL", cls.muse_model),
            muse_reasoning_effort=env("MUSE_REASONING_EFFORT", cls.muse_reasoning_effort),
            contact_email=env("RC_CONTACT_EMAIL"),
            core_api_key=env("CORE_API_KEY"),
            models_dir=Path(os.environ["RC_MODELS_DIR"]) if os.environ.get("RC_MODELS_DIR") else None,
        )


def write_env_file(path: Path, updates: dict[str, str]) -> None:
    """Set KEY=value lines in a .env file, keeping its other lines and comments as they are."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        lines = []
    left = dict(updates)
    out = []
    for line in lines:
        key = line.split("=", 1)[0].strip() if "=" in line and not line.lstrip().startswith("#") else None
        out.append(f"{key}={left.pop(key)}" if key in left else line)
    out += [f"{k}={v}" for k, v in left.items()]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(out) + "\n", encoding="utf-8")


def read_env_file(path: Path) -> dict[str, str]:
    """KEY=value lines; blank lines and # comments skipped, surrounding quotes removed."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return {}
    out = {}
    for line in lines:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            out[key.strip()] = value.strip().strip("'\"")
    return out
