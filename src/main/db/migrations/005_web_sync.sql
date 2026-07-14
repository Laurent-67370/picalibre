-- Suivi de la synchronisation vers PicaLibre Web (miroir VPS).
-- synced_hash = hash déjà envoyé -> permet de ne renvoyer que le nécessaire
-- (photo nouvelle, ré-éditée, ou métadonnées changées).
CREATE TABLE IF NOT EXISTS web_sync (
  photo_id     INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  synced_hash  TEXT NOT NULL,
  synced_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
