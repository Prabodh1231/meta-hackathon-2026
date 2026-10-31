import os
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Settings:
    data_dir: Path
    provider: str = "mock"  # mock | muse
    embedder: str = "auto"  # auto (BGE-M3 on CUDA, else fastembed) | bge-m3 | fastembed | hash
    # Cross-encoder reranker: auto | none | a fastembed model name. "none" by default here
    # (tests, scripts); from_env() defaults to "auto" so the app uses it.
    reranker: str = "none"
    api_token: str = ""  # set by Electron per launch; empty disables the check
    parent_pid: int = 0  # set by Electron; the backend exits when that process does
    muse_api_base: str = "https://api.meta.ai/v1"
    muse_api_key: str = ""
    muse_model: str = "muse-spark-1.3"
    muse_reasoning_effort: str = "low"  # minimal | low | medium | high | xhigh
    contact_email: str = ""  # sent to OpenAlex and Semantic Scholar when finding cited papers (polite pool)
    # Muse Spark is also served by Baseten's Model APIs. "baseten-first" sends each request there
    # and to Meta's API if Baseten fails; "meta" and "baseten" use one only. Empty: Baseten first
    # when a Baseten key is set, else Meta.
    muse_route: str = ""
    baseten_muse_base: str = "https://inference.baseten.co/v1"
    baseten_muse_model: str = "meta-models/muse-spark-open-1026"
    # Baseten deployments for machines without a CUDA GPU (see make_embedder): model ID or URL.
    baseten_api_key: str = ""
    baseten_embed_model: str = ""
    baseten_rerank_model: str = ""

    @property
    def route(self) -> str:
        """Where Muse requests go: muse_route, or its default."""
        if self.muse_route in ("baseten-first", "meta", "baseten"):
            return self.muse_route
        return "baseten-first" if self.baseten_api_key else "meta"

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
            muse_route=env("MUSE_ROUTE").lower(),
            baseten_muse_base=env("BASETEN_MUSE_BASE", cls.baseten_muse_base),
            baseten_muse_model=env("BASETEN_MUSE_MODEL", cls.baseten_muse_model),
            baseten_api_key=env("BASETEN_API_KEY"),
            baseten_embed_model=env("BASETEN_EMBED_MODEL"),
            baseten_rerank_model=env("BASETEN_RERANK_MODEL"),
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
