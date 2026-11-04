"""Removed: the app no longer runs a local embedding model.

Search is SQLite FTS5/BM25 keyword search plus Muse ranking through the provider
layer (see library.py and retrieval.py). This stub is left only because the editing
process cannot remove a file; nothing should import this module.
"""

# The implementation was removed in phase 3.


# No embedder classes remain.


# No local model wrapper remains.


# No background model loader remains: nothing loads before search can run.


# No vector helpers remain: chunks store text only, indexed by chunks_fts.
