-- Migration 007 : ajout de la colonne 'folder' à l'index FTS5
-- Permet la recherche par nom de dossier (ex: "vacances 2023" trouve les
-- photos dans /Photos/Vacances 2023/).
--
-- FTS5 ne supporte pas ALTER TABLE ADD COLUMN sur une table virtuelle.
-- Il faut donc reconstruire toute la structure FTS :
-- 1. Supprimer les anciens triggers et tables
-- 2. Recréer photos_search_content avec la colonne 'folder'
-- 3. Recréer photos_fts avec 'folder'
-- 4. Recréer les triggers de synchronisation
-- 5. Repeupler avec les données existantes

-- 1. Supprimer les anciens triggers
DROP TRIGGER IF EXISTS fts_data_ai;
DROP TRIGGER IF EXISTS fts_data_bd;
DROP TRIGGER IF EXISTS fts_data_bu;
DROP TRIGGER IF EXISTS fts_data_au;
DROP TRIGGER IF EXISTS photos_fts_ai;
DROP TRIGGER IF EXISTS photos_fts_au;
DROP TRIGGER IF EXISTS photos_fts_ad;
DROP TRIGGER IF EXISTS photo_tags_fts_ai;
DROP TRIGGER IF EXISTS photo_tags_fts_ad;
DROP TRIGGER IF EXISTS tags_fts_au;
DROP TRIGGER IF EXISTS faces_fts_ai;
DROP TRIGGER IF EXISTS faces_fts_ad;
DROP TRIGGER IF EXISTS faces_fts_au;
DROP TRIGGER IF EXISTS persons_fts_au;

-- 2. Supprimer l'ancienne table FTS et la table de contenu externe
DROP TABLE IF EXISTS photos_fts;
DROP TABLE IF EXISTS photos_fts_data;
DROP TABLE IF EXISTS photos_fts_idx;
DROP TABLE IF EXISTS photos_fts_config;
DROP TABLE IF EXISTS photos_fts_content;
DROP TABLE IF EXISTS photos_search_content;

-- 3. Table de contenu externe pour FTS5 (avec 'folder')
CREATE TABLE photos_search_content (
  rowid    INTEGER PRIMARY KEY,  -- = photos.id
  caption  TEXT,
  filename TEXT,
  tags     TEXT,   -- GROUP_CONCAT des noms de tags
  persons  TEXT,   -- GROUP_CONCAT des noms de personnes
  folder   TEXT    -- chemin du dossier (folders.path via folder_id)
);

-- 4. Table FTS5 pointant vers la table de contenu externe
CREATE VIRTUAL TABLE photos_fts USING fts5(
  caption, filename, tags, persons, folder,
  content='photos_search_content', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- 5. Triggers de synchronisation photos_search_content → photos_fts

-- INSERT dans photos_search_content → INSERT dans photos_fts
CREATE TRIGGER fts_data_ai AFTER INSERT ON photos_search_content BEGIN
  INSERT INTO photos_fts(rowid, caption, filename, tags, persons, folder)
  VALUES (new.rowid, new.caption, new.filename, new.tags, new.persons, new.folder);
END;

-- BEFORE DELETE : supprime l'ancienne entrée FTS
CREATE TRIGGER fts_data_bd BEFORE DELETE ON photos_search_content BEGIN
  INSERT INTO photos_fts(photos_fts, rowid) VALUES('delete', old.rowid);
END;

-- BEFORE UPDATE : supprime l'ancienne entrée FTS (anciennes valeurs)
CREATE TRIGGER fts_data_bu BEFORE UPDATE ON photos_search_content BEGIN
  INSERT INTO photos_fts(photos_fts, rowid) VALUES('delete', old.rowid);
END;

-- AFTER UPDATE : insère la nouvelle entrée FTS
CREATE TRIGGER fts_data_au AFTER UPDATE ON photos_search_content BEGIN
  INSERT INTO photos_fts(rowid, caption, filename, tags, persons, folder)
  VALUES (new.rowid, new.caption, new.filename, new.tags, new.persons, new.folder);
END;

-- 6. Triggers sur photos → photos_search_content

-- INSERT
CREATE TRIGGER photos_fts_ai AFTER INSERT ON photos BEGIN
  INSERT INTO photos_search_content (rowid, caption, filename, tags, persons, folder)
  SELECT
    new.id, new.caption, new.filename,
    (SELECT GROUP_CONCAT(t.name, ' ') FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.photo_id = new.id),
    (SELECT GROUP_CONCAT(pe.name, ' ') FROM faces f JOIN persons pe ON pe.id = f.person_id WHERE f.photo_id = new.id),
    (SELECT f.path FROM folders f WHERE f.id = new.folder_id)
  ;
END;

-- UPDATE (filename, caption, ou folder_id)
CREATE TRIGGER photos_fts_au AFTER UPDATE OF filename, caption, folder_id ON photos BEGIN
  UPDATE photos_search_content
  SET caption = new.caption,
      filename = new.filename,
      folder = (SELECT f.path FROM folders f WHERE f.id = new.folder_id)
  WHERE rowid = new.id;
END;

-- DELETE
CREATE TRIGGER photos_fts_ad AFTER DELETE ON photos BEGIN
  DELETE FROM photos_search_content WHERE rowid = old.id;
END;

-- 7. Triggers sur photo_tags → met à jour la colonne tags

-- INSERT
CREATE TRIGGER photo_tags_fts_ai AFTER INSERT ON photo_tags BEGIN
  UPDATE photos_search_content SET tags = (
    SELECT GROUP_CONCAT(t.name, ' ') FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.photo_id = new.photo_id
  ) WHERE rowid = new.photo_id;
END;

-- DELETE
CREATE TRIGGER photo_tags_fts_ad AFTER DELETE ON photo_tags BEGIN
  UPDATE photos_search_content SET tags = (
    SELECT GROUP_CONCAT(t.name, ' ') FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.photo_id = old.photo_id
  ) WHERE rowid = old.photo_id;
END;

-- 8. Trigger sur tags (renommage) → met à jour la colonne tags
CREATE TRIGGER tags_fts_au AFTER UPDATE OF name ON tags BEGIN
  UPDATE photos_search_content SET tags = (
    SELECT GROUP_CONCAT(t.name, ' ') FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.photo_id = photos_search_content.rowid
  ) WHERE rowid IN (SELECT photo_id FROM photo_tags WHERE tag_id = new.id);
END;

-- 9. Triggers sur faces → met à jour la colonne persons

-- INSERT
CREATE TRIGGER faces_fts_ai AFTER INSERT ON faces BEGIN
  UPDATE photos_search_content SET persons = (
    SELECT GROUP_CONCAT(pe.name, ' ') FROM faces f JOIN persons pe ON pe.id = f.person_id WHERE f.photo_id = new.photo_id
  ) WHERE rowid = new.photo_id;
END;

-- DELETE
CREATE TRIGGER faces_fts_ad AFTER DELETE ON faces BEGIN
  UPDATE photos_search_content SET persons = (
    SELECT GROUP_CONCAT(pe.name, ' ') FROM faces f JOIN persons pe ON pe.id = f.person_id WHERE f.photo_id = old.photo_id
  ) WHERE rowid = old.photo_id;
END;

-- UPDATE (changement de person_id)
CREATE TRIGGER faces_fts_au AFTER UPDATE OF person_id ON faces BEGIN
  -- Mettre à jour l'ancienne photo
  UPDATE photos_search_content SET persons = (
    SELECT GROUP_CONCAT(pe.name, ' ') FROM faces f JOIN persons pe ON pe.id = f.person_id WHERE f.photo_id = old.photo_id
  ) WHERE rowid = old.photo_id;
  -- Mettre à jour la nouvelle photo
  UPDATE photos_search_content SET persons = (
    SELECT GROUP_CONCAT(pe.name, ' ') FROM faces f JOIN persons pe ON pe.id = f.person_id WHERE f.photo_id = new.photo_id
  ) WHERE rowid = new.photo_id;
END;

-- 10. Trigger sur persons (renommage) → met à jour la colonne persons
CREATE TRIGGER persons_fts_au AFTER UPDATE OF name ON persons BEGIN
  UPDATE photos_search_content SET persons = (
    SELECT GROUP_CONCAT(pe.name, ' ') FROM faces f JOIN persons pe ON pe.id = f.person_id WHERE f.photo_id = photos_search_content.rowid
  ) WHERE rowid IN (SELECT DISTINCT f.photo_id FROM faces f WHERE f.person_id = new.id);
END;

-- 11. Trigger sur folders (renommage de dossier) → met à jour la colonne folder
CREATE TRIGGER folders_fts_au AFTER UPDATE OF path ON folders BEGIN
  UPDATE photos_search_content SET folder = new.path
  WHERE rowid IN (SELECT id FROM photos WHERE folder_id = new.id);
END;

-- 12. Peuplement initial : remplir photos_search_content avec les données existantes
INSERT INTO photos_search_content (rowid, caption, filename, tags, persons, folder)
SELECT
  p.id, p.caption, p.filename,
  (SELECT GROUP_CONCAT(t.name, ' ') FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.photo_id = p.id),
  (SELECT GROUP_CONCAT(pe.name, ' ') FROM faces f JOIN persons pe ON pe.id = f.person_id WHERE f.photo_id = p.id),
  (SELECT f.path FROM folders f WHERE f.id = p.folder_id)
FROM photos p;