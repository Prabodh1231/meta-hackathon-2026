import sqlite3
from pathlib import Path

FINDINGS_TABLE = """
-- What a matrix produced, kept for the draft: each gap Find gaps names, each passage Write from
-- this matrix writes, and each research proposal written from gaps. `snapshot` holds the matrix
-- rows it was based on ([{doc_id, label, title, values: [{key, label, value, quote}]}]), so its
-- citations can be checked against the matrix as it was, and the app can tell when the matrix
-- has changed since, or was deleted. A proposal can draw on several matrices (`matrix_ids`);
-- `matrix_id` is then the first of them.
CREATE TABLE IF NOT EXISTS matrix_findings (
  id INTEGER PRIMARY KEY,
  matrix_id INTEGER REFERENCES matrices(id) ON DELETE SET NULL,
  matrix_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('gap', 'synthesis', 'proposal')),
  title TEXT NOT NULL DEFAULT '', -- a gap's title; the instruction a passage was written to; a proposal's title
  text TEXT NOT NULL DEFAULT '', -- a gap's detail; a passage's sentences; a proposal's research questions
  sentences TEXT NOT NULL DEFAULT '[]', -- a passage's sentences with their citations, as written
  columns TEXT NOT NULL DEFAULT '[]', -- the column keys the snapshot holds
  snapshot TEXT NOT NULL DEFAULT '[]',
  matrix_ids TEXT NOT NULL DEFAULT '[]', -- a proposal's matrices
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS matrix_findings_matrix ON matrix_findings(matrix_id);
"""

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  user_named INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  authors TEXT NOT NULL DEFAULT '[]',
  year INTEGER,
  venue TEXT NOT NULL DEFAULT '',
  doi TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  page_count INTEGER NOT NULL DEFAULT 1,
  page_numbering TEXT NOT NULL DEFAULT 'index',
  edited_fields TEXT NOT NULL DEFAULT '[]', -- metadata the user corrected; re-ingest keeps these
  keywords TEXT NOT NULL DEFAULT '[]', -- author-printed keywords, read from the first pages
  jel_codes TEXT NOT NULL DEFAULT '[]', -- author-printed JEL classification codes
  topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Full text per page: the source viewer shows it and citation offsets point into it.
CREATE TABLE IF NOT EXISTS pages (
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  text TEXT NOT NULL,
  label TEXT, -- printed page number; NULL when unknown
  PRIMARY KEY (doc_id, page)
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id);
-- Keyword index over chunk text (BM25), kept in sync with chunks by triggers. Porter
-- stemming lets "bleached" match "bleaching"; identifiers like P-17 still match exactly.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, content='chunks', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_fts_update AFTER UPDATE OF text ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TABLE IF NOT EXISTS tags (
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (doc_id, tag)
);
-- Virtual folders: subjects the user defines, which a document can match many of. A row in
-- doc_folders points at the document, never copies it. `state` records who decided: the
-- similarity score reaching the folder's threshold ('auto'), the user adding it ('user'),
-- or the user removing a wrong match ('rejected', which keeps rescoring from putting it back).
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  similarity INTEGER NOT NULL DEFAULT 50 -- percent a document must match to be filed here
);
-- How well each document fits each folder, 0-100. Kept for every pair so moving a folder's
-- threshold re-files instantly, without asking the model again.
CREATE TABLE IF NOT EXISTS folder_scores (
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  PRIMARY KEY (doc_id, folder_id)
);
CREATE TABLE IF NOT EXISTS doc_folders (
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('auto', 'user', 'rejected')),
  PRIMARY KEY (doc_id, folder_id)
);
-- Each paper's reference list as parsed from its own text. Which library paper an entry points at
-- is worked out when the graph is built, so it follows later corrections and new papers.
CREATE TABLE IF NOT EXISTS doc_refs (
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  raw TEXT NOT NULL,
  number INTEGER,
  year INTEGER,
  doi TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  first_author TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (doc_id, idx)
);
-- The same paper's reference list as OpenAlex has it, with a DOI for most entries. Merged with
-- doc_refs when the graph is built (see Library._reference_lists); kept apart so re-reading the
-- PDF, which replaces doc_refs, doesn't lose it.
CREATE TABLE IF NOT EXISTS index_refs (
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  raw TEXT NOT NULL,
  year INTEGER,
  doi TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  first_author TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (doc_id, idx)
);
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Untitled',
  content TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Snapshots of a draft. 'milestone' versions are saved and named by the user; 'auto' ones are
-- taken while writing (every so often, and before a large edit or a restore) and the oldest
-- are pruned. `text` and `change` (percent changed since the version before) make listing cheap.
CREATE TABLE IF NOT EXISTS draft_versions (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('milestone', 'auto')),
  label TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  words INTEGER NOT NULL DEFAULT 0,
  change INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS draft_versions_draft ON draft_versions(draft_id, id);
-- SHA-256 of library files for the duplicate finder, reused while a file's size and
-- modification time are unchanged so a re-scan doesn't read every file again.
CREATE TABLE IF NOT EXISTS file_hashes (
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime REAL NOT NULL,
  sha256 TEXT NOT NULL
);
-- What a removed document was, so the library's history survives it: the timeline can show the
-- library as it was on a past date, a removed paper added again is recognised, and one whose file
-- is still there can be restored under its old id (ids are never reused, so drafts citing it work
-- again). Metadata only: the text and vectors go with the document.
CREATE TABLE IF NOT EXISTS removed_documents (
  id INTEGER PRIMARY KEY, -- the document's own id
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  authors TEXT NOT NULL DEFAULT '[]',
  year INTEGER,
  venue TEXT NOT NULL DEFAULT '',
  doi TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  published TEXT NOT NULL DEFAULT '',
  sha256 TEXT NOT NULL DEFAULT '',
  file_date TEXT,
  edited_fields TEXT NOT NULL DEFAULT '{}', -- the user's corrections, with their values, restored with it
  folders TEXT NOT NULL DEFAULT '[]', -- names of folders the user filed it in by hand
  added_at TEXT NOT NULL,
  removed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reason TEXT NOT NULL DEFAULT 'removed' CHECK (reason IN ('removed', 'duplicate')),
  duplicate_of INTEGER, -- the copy kept, for a duplicate
  duplicate_of_title TEXT NOT NULL DEFAULT '',
  file_trashed INTEGER NOT NULL DEFAULT 0 -- the file went to the Recycle Bin too
);
-- Literature review matrices: one row per paper, one column per question (`columns` is JSON:
-- [{key, label, instruction, query}]). Each cell is a short answer and the verbatim quote it rests
-- on, located in the paper (chunk, page, offsets), or 'not_reported'.
CREATE TABLE IF NOT EXISTS matrices (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  columns TEXT NOT NULL DEFAULT '[]',
  gaps TEXT NOT NULL DEFAULT '', -- JSON list of {title, detail}, '' until asked for
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS matrix_rows (
  matrix_id INTEGER NOT NULL REFERENCES matrices(id) ON DELETE CASCADE,
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (matrix_id, doc_id)
);
CREATE TABLE IF NOT EXISTS matrix_cells (
  matrix_id INTEGER NOT NULL REFERENCES matrices(id) ON DELETE CASCADE,
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  col TEXT NOT NULL,
  -- pending | found (quote located) | unverified (quote not in the paper) | not_reported | error
  status TEXT NOT NULL DEFAULT 'pending',
  answer TEXT NOT NULL DEFAULT '',
  quote TEXT NOT NULL DEFAULT '',
  chunk_id INTEGER,
  page INTEGER,
  start INTEGER,
  "end" INTEGER,
  label TEXT NOT NULL DEFAULT '',
  edited INTEGER NOT NULL DEFAULT 0, -- the answer was written or changed by the user
  error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (matrix_id, doc_id, col)
);
""" + FINDINGS_TABLE


def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    had_fts = conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'chunks_fts'").fetchone()
    conn.executescript(SCHEMA)
    _migrate(conn)
    if not had_fts:  # library from before keyword search: index the chunks it already has
        conn.execute("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')")
        conn.commit()
    return conn


# Columns added after the first release: (table, column, definition).
_ADDED_COLUMNS = [
    ("documents", "page_numbering", "TEXT NOT NULL DEFAULT 'index'"),
    ("pages", "label", "TEXT"),
    ("documents", "edited_fields", "TEXT NOT NULL DEFAULT '[]'"),
    ("folders", "similarity", "INTEGER NOT NULL DEFAULT 50"),
    ("documents", "keywords", "TEXT NOT NULL DEFAULT '[]'"),
    ("documents", "jel_codes", "TEXT NOT NULL DEFAULT '[]'"),
    ("documents", "refs_parsed", "INTEGER NOT NULL DEFAULT 0"),  # 1 once doc_refs holds its reference list
    # Model work that failed when the document was added ("metadata", "title", "summary", "tags"),
    # to be retried; the document is stored and searchable meanwhile.
    ("documents", "missing", "TEXT NOT NULL DEFAULT '[]'"),
    # When the file reached this computer: the earlier of its creation and modification times
    # (a copy keeps the second, a download sets both). NULL for web pages. "YYYY-MM-DD HH:MM:SS", UTC.
    ("documents", "file_date", "TEXT"),
    ("documents", "sha256", "TEXT NOT NULL DEFAULT ''"),  # of the file when it was read
    # Full publication date from OpenAlex ("YYYY-MM-DD" or "YYYY-MM"); `year` alone when empty.
    ("documents", "published", "TEXT NOT NULL DEFAULT ''"),
    ("documents", "published_checked", "INTEGER NOT NULL DEFAULT 0"),  # 1 once OpenAlex was asked
    # What the scholarly indexes know about the paper (Library.enrich_documents).
    ("documents", "abstract", "TEXT NOT NULL DEFAULT ''"),  # the authors' own
    ("documents", "volume", "TEXT NOT NULL DEFAULT ''"),
    ("documents", "issue", "TEXT NOT NULL DEFAULT ''"),
    ("documents", "page_span", "TEXT NOT NULL DEFAULT ''"),  # "341–355", the publisher's pages
    ("documents", "publisher", "TEXT NOT NULL DEFAULT ''"),
    ("documents", "openalex_id", "TEXT NOT NULL DEFAULT ''"),
    ("documents", "cited_by_count", "INTEGER"),  # citations worldwide; NULL when not looked up
    # '' not looked up | found | not_found | mismatch (the paper's DOI is another work's)
    ("documents", "enriched", "TEXT NOT NULL DEFAULT ''"),
    ("documents", "enriched_at", "TEXT"),
    ("documents", "index_title", "TEXT NOT NULL DEFAULT ''"),  # the other work's title, for a mismatch
]


def _migrate(conn: sqlite3.Connection) -> None:
    # Findings from before proposals: the table's CHECK allowed only gaps and passages, and a CHECK
    # can't be altered, so the table is rebuilt with its rows.
    sql = conn.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'matrix_findings'").fetchone()
    if sql and "'proposal'" not in sql["sql"]:
        cols = "id, matrix_id, matrix_name, kind, title, text, sentences, columns, snapshot, created_at"
        conn.executescript(
            "BEGIN; ALTER TABLE matrix_findings RENAME TO matrix_findings_old; DROP INDEX IF EXISTS matrix_findings_matrix;"
            + FINDINGS_TABLE
            + f"INSERT INTO matrix_findings ({cols}) SELECT {cols} FROM matrix_findings_old; DROP TABLE matrix_findings_old; COMMIT;")
    for table, column, definition in _ADDED_COLUMNS:
        if column not in {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
    conn.commit()


def get_meta(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
