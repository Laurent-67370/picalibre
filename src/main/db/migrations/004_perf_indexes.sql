-- Index partiels ciblant les requêtes de grille (photos visibles uniquement).
-- Partiels = plus petits, tenus en cache, et SQLite les choisit directement.
CREATE INDEX IF NOT EXISTS idx_photos_grid_folder
  ON photos(folder_id, taken_at DESC)
  WHERE status = 'active' AND is_hidden = 0;

CREATE INDEX IF NOT EXISTS idx_photos_grid_timeline
  ON photos(taken_at DESC, file_mtime DESC)
  WHERE status = 'active' AND is_hidden = 0;

CREATE INDEX IF NOT EXISTS idx_thumbnails_lookup
  ON thumbnails(photo_id, size, cache_path);
