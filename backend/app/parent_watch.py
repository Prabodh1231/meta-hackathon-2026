"""Exit when the Electron app that started the backend is gone.

Electron starts the backend detached (its own console) so a Ctrl+C in the launching
terminal can't kill it. The flip side is that a crashed Electron no longer takes the
backend with it, so the backend watches its parent and leaves on its own.
"""

import ctypes
import logging
import os
import sys
import threading
import time

log = logging.getLogger(__name__)

_SYNCHRONIZE = 0x00100000
_INFINITE = 0xFFFFFFFF


def exit_with_parent(pid: int) -> None:
    def wait() -> None:
        if sys.platform == "win32":
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(_SYNCHRONIZE, False, pid)
            if handle:  # no handle: the parent is already gone
                kernel32.WaitForSingleObject(handle, _INFINITE)
                kernel32.CloseHandle(handle)
        else:
            while os.getppid() == pid:
                time.sleep(2)
        log.info("App process %s has exited; shutting the backend down", pid)
        os._exit(0)

    threading.Thread(target=wait, name="parent-watch", daemon=True).start()
