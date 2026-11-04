"""Start the backend as the packaged app does: `groundwork-backend --port 8765`.

PyInstaller freezes this file into groundwork-backend.exe, which the installed app runs in place of
`python -m uvicorn app.main:app`. The app is imported here rather than named as a string, so the
freezer sees it and bundles it.
"""

import argparse

import uvicorn

from app.main import app


def main() -> None:
    ap = argparse.ArgumentParser(description="Groundwork backend")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
