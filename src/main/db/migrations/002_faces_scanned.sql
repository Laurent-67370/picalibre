-- Marqueur "photo déjà passée en détection de visages" (même sans visage trouvé)
ALTER TABLE photos ADD COLUMN faces_scanned INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_photos_faces_scanned ON photos(faces_scanned) WHERE faces_scanned = 0;
