import subprocess
import sys
import time

import pytest


@pytest.mark.skipif(sys.platform != "win32", reason="watches an arbitrary pid only on Windows")
def test_backend_exits_when_parent_process_dies():
    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    child = subprocess.Popen(
        [sys.executable, "-c",
         f"import time; from app.parent_watch import exit_with_parent; exit_with_parent({parent.pid}); time.sleep(60)"],
    )
    try:
        time.sleep(1.5)
        assert child.poll() is None  # still running while the parent lives
        parent.kill()
        assert child.wait(timeout=10) == 0
    finally:
        for p in (parent, child):
            if p.poll() is None:
                p.kill()


def test_watch_is_off_without_parent_pid():
    from app.settings import Settings

    assert Settings.from_env().parent_pid == 0
