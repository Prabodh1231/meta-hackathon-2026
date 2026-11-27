import os
from dataclasses import dataclass
from pathlib import Path


def legacy_data_dir() -> Path:
    """Where the library lived before the app was renamed."""
    return Path.home() / ".research-companion"


def default_data_dir() -> Path:
    """~/.groundwork. A library from before the rename, in ~/.research-companion, is used where
    it is until the desktop app moves it on its next start."""
    new, legacy = Path.home() / ".groundwork", legacy_data_dir()
    return legacy if not new.exists() and legacy.exists() else new


@dataclass
class Settings:
    data_dir: Path
    provider: str = "mock"  # mock | muse
    api_token: str = ""  # set by Electron per launch; a server started without one refuses to run (see main.create_app)
    allow_no_token: bool = False  # RC_ALLOW_NO_TOKEN=1: run with no token check, for the UI in a plain browser
    parent_pid: int = 0  # set by Electron; the backend exits when that process does
    muse_api_base: str = "https://api.meta.ai/v1"
    muse_api_key: str = ""
    muse_model: str = "muse-spark-1.3"
    muse_search_model: str = "muse-ember-1.0"  # expands and ranks searches; empty uses muse_model
    muse_reasoning_effort: str = "low"  # minimal | low | medium | high | xhigh
    contact_email: str = ""  # sent to OpenAlex, Semantic Scholar and Crossref when finding cited papers (polite pool)
    search_model: str = ""  # "bge-small" adds dense search on this computer (GPU when there is one); "" is keyword only
    reranker: str = ""  # "ms-marco" adds a local cross-encoder over the fused candidates; "" is none
    core_api_key: str = ""  # CORE (core.ac.uk) is searched for free copies only with the user's own key

    @property
    def db_path(self) -> Path:
        return self.data_dir / "library.db"

    @classmethod
    def from_env(cls) -> "Settings":
        """Settings from environment variables, falling back to `<data dir>/.env`. The key
        lives there, in the user's data folder, so it never sits inside the repository."""
        data_dir = Path(os.environ.get("RC_DATA_DIR") or default_data_dir())
        file_vars = read_env_file(data_dir / ".env")

        def env(name: str, default: str = "") -> str:
            return os.environ.get(name) or file_vars.get(name) or default

        return cls(
            data_dir=data_dir,
            provider=env("RC_PROVIDER", "mock").lower(),
            api_token=env("RC_API_TOKEN"),
            # Only from the real environment, never from the data folder's .env: a file the app writes
            # must not be able to switch the token check off.
            allow_no_token=os.environ.get("RC_ALLOW_NO_TOKEN", "").lower() in ("1", "true", "yes"),
            parent_pid=int(env("RC_PARENT_PID") or 0),
            muse_api_base=env("MUSE_API_BASE", cls.muse_api_base),
            # MODEL_API_KEY is the name Meta's docs use.
            muse_api_key=env("MUSE_API_KEY") or env("MODEL_API_KEY"),
            muse_model=env("MUSE_MODEL", cls.muse_model),
            muse_search_model=env("MUSE_SEARCH_MODEL", cls.muse_search_model),
            muse_reasoning_effort=env("MUSE_REASONING_EFFORT", cls.muse_reasoning_effort),
            contact_email=env("RC_CONTACT_EMAIL"),
            core_api_key=env("CORE_API_KEY"),
            reranker="" if env("RC_RERANKER", "ms-marco").lower() in ("off", "none", "0") else "ms-marco",
            search_model="" if env("RC_SEARCH_MODEL", "bge-small").lower() in ("off", "none", "0") else "bge-small",
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
