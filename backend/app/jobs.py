"""Adding files in the background, so the app can show each file's progress instead of one
request that blocks until a whole folder is done.

A job is a list of paths. It lists the files they contain, reads several at once (the same
worker count as Library.ingest_paths) and records each file's state as it goes: queued,
working (reading / analysing / filing), done, failed or skipped (cancelled). Model calls that
failed during the job get one more try at the end. Jobs run one after another and are kept in
memory only: the files they added are in the library either way.
"""

import copy
import itertools
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

log = logging.getLogger(__name__)

KEEP_FINISHED = 20  # finished jobs remembered for the app to show


class IngestJobs:
    def __init__(self, library, workers: int):
        self.lib = library
        self.workers = workers
        self.lock = threading.Lock()
        self.jobs: dict[int, dict] = {}
        self._ids = itertools.count(1)
        # One job at a time; each job reads several files at once.
        self._runner = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ingest-job")

    def start(self, paths: list[str]) -> dict:
        job = {
            "id": next(self._ids), "state": "queued", "paths": list(paths), "files": [],
            "total": 0, "done": 0, "failed": 0, "skipped": 0, "incomplete": 0, "cancelled": False,
            "error": None, "started_at": time.time(), "finished_at": None,
        }
        with self.lock:
            self.jobs[job["id"]] = job
            finished = [j["id"] for j in self.jobs.values() if j["finished_at"]]
            for old in finished[:-KEEP_FINISHED]:
                del self.jobs[old]
        self._runner.submit(self._run, job["id"])
        return self.get(job["id"])

    def get(self, job_id: int) -> dict:
        with self.lock:
            if job_id not in self.jobs:
                raise LookupError(f"No import job {job_id}")
            return copy.deepcopy(self.jobs[job_id])

    def list(self) -> list[dict]:
        """Newest first."""
        with self.lock:
            return [copy.deepcopy(j) for j in sorted(self.jobs.values(), key=lambda j: -j["id"])]

    def cancel(self, job_id: int) -> dict:
        """Files already being read finish; the ones still waiting are skipped."""
        with self.lock:
            if job_id not in self.jobs:
                raise LookupError(f"No import job {job_id}")
            self.jobs[job_id]["cancelled"] = True
        return self.get(job_id)

    def _run(self, job_id: int) -> None:
        job = self.jobs[job_id]
        try:
            with self.lock:
                job["state"] = "listing"
            files, missing = self.lib.expand_paths(job["paths"])
            with self.lock:
                job["files"] = [
                    {"source": str(f), "name": f.name, "state": "queued", "stage": "", "error": None,
                     "document_id": None, "title": None, "missing": []}
                    for f in files
                ] + [
                    {"source": m["source"], "name": Path(m["source"]).name or m["source"], "state": "failed",
                     "stage": "", "error": m["error"], "document_id": None, "title": None, "missing": []}
                    for m in missing
                ]
                job["total"] = len(job["files"])
                job["failed"] = len(missing)
                job["state"] = "running"

            def one(entry: dict) -> None:
                with self.lock:
                    if job["cancelled"]:
                        entry["state"] = "skipped"
                        job["skipped"] += 1
                        return
                    entry["state"] = "working"

                def stage(name: str) -> None:
                    with self.lock:
                        entry["stage"] = name

                result = self.lib.ingest_file(Path(entry["source"]), on_stage=stage)
                with self.lock:
                    entry["stage"] = ""
                    if result["ok"]:
                        doc = result["document"]
                        entry.update(state="done", document_id=doc["id"], title=doc["title"], missing=doc["missing"])
                        job["done"] += 1
                    else:
                        entry.update(state="failed", error=result["error"])
                        job["failed"] += 1

            queued = [e for e in job["files"] if e["state"] == "queued"]
            if queued:
                with ThreadPoolExecutor(max_workers=min(self.workers, len(queued))) as pool:
                    list(pool.map(one, queued))

            # Model calls that failed in the rush (often rate limits) get one more try now.
            owed = [e["document_id"] for e in job["files"] if e["state"] == "done" and e["missing"]]
            if owed and not job["cancelled"]:
                with self.lock:
                    job["state"] = "retrying"
                self.lib.fill_missing(owed)
                still = {}
                for doc_id in owed:
                    try:
                        still[doc_id] = self.lib.get_document(doc_id)["missing"]
                    except LookupError:  # removed while the job ran
                        still[doc_id] = []
                with self.lock:
                    for e in job["files"]:
                        if e["document_id"] in still:
                            e["missing"] = still[e["document_id"]]
            with self.lock:
                job["incomplete"] = sum(1 for e in job["files"] if e["state"] == "done" and e["missing"])
                job["state"] = "cancelled" if job["cancelled"] else "done"
        except Exception as exc:  # listing the folder failed, or something unexpected
            log.exception("Import job %s failed", job_id)
            with self.lock:
                job["state"] = "failed"
                job["error"] = str(exc)
        finally:
            with self.lock:
                job["finished_at"] = time.time()
