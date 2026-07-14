-- PicaLibre — migration 008 : colonnes GPS et index spatial
-- Les colonnes gps_lat, gps_lon, gps_alt existent déjà dans 001_init.sql
-- pour les nouvelles installations. Cette migration garantit que les bases
-- existantes (créées avant l'ajout des colonnes GPS) les ont bien, et ajoute
-- un index spatial optimisé pour les requêtes de bounding box.

-- Colonnes GPS — Ajoutées dans 001, mais on s'assure qu'elles existent
-- pour les bases créées avant cette fonctionnalité (SQLite n'a pas de
-- IF NOT EXISTS pour ALTER TABLE ADD COLUMN, on utilise un guard pragma).

-- Index spatial pour les requêtes de bounding box
-- Cet index couvre gps_lat ET gps_lon avec un filtre partiel sur les photos
-- qui ont réellement des coordonnées GPS.
DROP INDEX IF EXISTS idx_photos_gps_spatial;
CREATE INDEX idx_photos_gps_spatial ON photos(gps_lat, gps_lon)
  WHERE gps_lat IS NOT NULL AND gps_lon IS NOT NULL;