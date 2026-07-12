-- PicaLibre — migration 001 : schéma initial
-- Voir docs/ARCHITECTURE.md §7 pour les notes de conception

CREATE TABLE scan_roots (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  mode          TEXT NOT NULL DEFAULT 'watch'
                CHECK (mode IN ('watch','once','excluded')),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE folders (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  parent_id     INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  scan_root_id  INTEGER REFERENCES scan_roots(id) ON DELETE CASCADE,
  is_hidden     INTEGER NOT NULL DEFAULT 0,
  last_scanned  INTEGER
);
CREATE INDEX idx_folders_parent ON folders(parent_id);

CREATE TABLE photos (
  id             INTEGER PRIMARY KEY,
  folder_id      INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  filename       TEXT NOT NULL,
  filepath       TEXT NOT NULL UNIQUE,
  media_type     TEXT NOT NULL DEFAULT 'image'
                 CHECK (media_type IN ('image','video')),
  hash_xxh3      TEXT NOT NULL,
  hash_sha256    TEXT,
  file_size      INTEGER NOT NULL,
  file_mtime     INTEGER NOT NULL,
  width          INTEGER,
  height         INTEGER,
  duration_ms    INTEGER,
  taken_at       INTEGER,
  camera_make    TEXT,
  camera_model   TEXT,
  lens           TEXT,
  iso            INTEGER,
  f_number       REAL,
  exposure_time  TEXT,
  focal_length   REAL,
  gps_lat        REAL,
  gps_lon        REAL,
  gps_alt        REAL,
  gps_manual     INTEGER NOT NULL DEFAULT 0,
  orientation    INTEGER DEFAULT 1,
  rating         INTEGER NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
  is_favorite    INTEGER NOT NULL DEFAULT 0,
  is_hidden      INTEGER NOT NULL DEFAULT 0,
  caption        TEXT,
  color_label    TEXT,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','missing','trashed')),
  imported_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_photos_folder ON photos(folder_id);
CREATE INDEX idx_photos_hash   ON photos(hash_xxh3);
CREATE INDEX idx_photos_taken  ON photos(taken_at);
CREATE INDEX idx_photos_gps    ON photos(gps_lat, gps_lon) WHERE gps_lat IS NOT NULL;
CREATE INDEX idx_photos_rating ON photos(rating) WHERE rating > 0;

CREATE VIRTUAL TABLE photos_fts USING fts5(
  caption, filename, tags, persons,
  content='', tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE albums (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT,
  cover_photo_id INTEGER REFERENCES photos(id) ON DELETE SET NULL,
  kind           TEXT NOT NULL DEFAULT 'manual'
                 CHECK (kind IN ('manual','person','smart')),
  smart_query    TEXT,
  person_id      INTEGER,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE album_items (
  album_id   INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  photo_id   INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,
  added_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (album_id, photo_id)
);
CREATE INDEX idx_album_items_photo ON album_items(photo_id);

CREATE TABLE tags (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT
);

CREATE TABLE photo_tags (
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (photo_id, tag_id)
);
CREATE INDEX idx_photo_tags_tag ON photo_tags(tag_id);

CREATE TABLE persons (
  id         INTEGER PRIMARY KEY,
  name       TEXT,
  centroid   BLOB,
  face_count INTEGER NOT NULL DEFAULT 0,
  is_ignored INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE faces (
  id          INTEGER PRIMARY KEY,
  photo_id    INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  person_id   INTEGER REFERENCES persons(id) ON DELETE SET NULL,
  bbox_x REAL NOT NULL, bbox_y REAL NOT NULL,
  bbox_w REAL NOT NULL, bbox_h REAL NOT NULL,
  embedding   BLOB NOT NULL,
  confidence  REAL NOT NULL,
  assignment  TEXT NOT NULL DEFAULT 'auto'
              CHECK (assignment IN ('auto','suggested','confirmed','rejected'))
);
CREATE INDEX idx_faces_photo  ON faces(photo_id);
CREATE INDEX idx_faces_person ON faces(person_id);

CREATE TABLE edits (
  photo_id           INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  current_stack      TEXT NOT NULL DEFAULT '{"version":1,"ops":[]}',
  current_history_id INTEGER,
  stack_hash         TEXT,
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE edit_history (
  id         INTEGER PRIMARY KEY,
  photo_id   INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  stack      TEXT NOT NULL,
  action     TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_edit_history_photo ON edit_history(photo_id, id);

CREATE TABLE thumbnails (
  photo_id     INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  size         INTEGER NOT NULL,
  cache_path   TEXT NOT NULL,
  generated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (photo_id, size)
);

CREATE TABLE duplicate_groups (
  id        INTEGER PRIMARY KEY,
  hash_xxh3 TEXT NOT NULL,
  resolved  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE duplicate_members (
  group_id INTEGER NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  is_kept  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, photo_id)
);

CREATE TABLE jobs (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','running','done','failed')),
  priority   INTEGER NOT NULL DEFAULT 5,
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_jobs_status ON jobs(status, priority, id);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
