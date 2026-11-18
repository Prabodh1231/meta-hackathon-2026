"""Removed: the installer no longer ships local search models.

bge-small and the reranker (app/embeddings.py) download themselves on first start, so
there is nothing to fetch. This stub is left only because the editing process cannot
remove a file.
"""

# Nothing is fetched: the installer ships no local search models.


if __name__ == "__main__":
    print(__doc__)
