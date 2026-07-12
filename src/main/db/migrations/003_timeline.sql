-- Timeline de montage : pistes vidéo/audio, clips non destructifs, transitions
CREATE TABLE timelines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE tracks (
  id TEXT PRIMARY KEY,
  timeline_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('video', 'audio')),
  order_index INTEGER NOT NULL,
  gain REAL DEFAULT 1.0,
  muted INTEGER DEFAULT 0,
  visible INTEGER DEFAULT 1,
  FOREIGN KEY (timeline_id) REFERENCES timelines(id) ON DELETE CASCADE
);

CREATE TABLE clips (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('photo', 'video', 'audio')),
  source_path TEXT NOT NULL,
  start_time REAL NOT NULL,
  duration REAL NOT NULL,
  source_in_offset REAL DEFAULT 0,
  source_out_offset REAL NOT NULL,
  transition_in_id TEXT,
  transition_out_id TEXT,
  volume REAL DEFAULT 1.0,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

CREATE TABLE transitions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('crossfade', 'wipe', 'slide')),
  duration REAL NOT NULL,
  direction TEXT
);

CREATE INDEX idx_clips_track ON clips(track_id);
CREATE INDEX idx_tracks_timeline ON tracks(timeline_id);
