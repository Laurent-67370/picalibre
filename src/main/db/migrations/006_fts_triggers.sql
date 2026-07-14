-- Migration 006 : activation de la recherche plein texte (FTS5)
-- La table photos_fts a été créée dans la migration 001 avec content='',
-- mais n'était jamais alimentée ni interrogée. On passe à un schéma
-- content='photos_fts_data' avec triggers de synchronisation automatique.

-- 1. Supprimer l'ancienne table FTS (vide, jamais utilisée)
--    FTS5 crée des shadow tables (photos_fts_data, photos_fts_idx, photos_fts_config, etc.)
--    Il faut aussi nettoyer ces tables pour éviter "table already exists"
DROP TABLE IF EXISTS photos_fts;
DROP TABLE IF EXISTS photos_fts_data;
DROP TABLE IF EXISTS photos_fts_idx;
DROP TABLE IF EXISTS photos_fts_config;
DROP TABLE IF EXISTS photos_fts_content;

-- 2. Table de contenu externe pour FTS5
--    Stocke les valeurs indexées pour chaque photo ; FTS5 lit
--    automatiquement les anciennes valeurs lors d'une suppression.
CREATE TABLE photos_fts_data (
  rowid    INTEGER PRIMARY KEY,  -- = photos.id
  caption  TEXT,
  filename TEXT,
  tags     TEXT,   -- GROUP_CONCAT des noms de tags
  persons  TEXT    -- GROUP_CONCAT des noms de personnes
);

-- 3. Table FTS5 pointant vers la table de contenu externe
CREATE VIRTUAL TABLE photos_fts USING fts5(
  caption, filename, tags, persons,
  content='photos_fts_data', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- 4. Triggers de synchronisation photos_fts_data → photos_fts
--    Ces triggers se déclenchent sur toute modification de
--    photos_fts_data et mettent à jour l'index FTS en conséquence.

-- INSERT dans photos_fts_data → INSERT dans photos_fts
CREATE TRIGGER fts_data_ai AFTER INSERT ON photos_fts_data BEGIN
  INSERT INTO photos_fts(rowid, caption, filename, tags, persons)
  VALUES (new.rowid, new.caption, new.filename, new.tags, new.persons);
END;

-- BEFORE DELETE : supprime l'ancienne entrée FTS (la ligne existe encore)
CREATE TRIGGER fts_data_bd BEFORE DELETE ON photos_fts_data BEGIN
  INSERT INTO photos_fts(photos_fts, rowid) VALUES('delete', old.rowid);
END;

-- BEFORE UPDATE : supprime l'ancienne entrée FTS (anciennes valeurs)
CREATE TRIGGER fts_data_bu BEFORE UPDATE ON photos_fts_data BEGIN
  INSERT INTO photos_fts(photos_fts, rowid) VALUES('delete', old.rowid);
END;

-- AFTER UPDATE : insère la nouvelle entrée FTS
CREATE TRIGGER fts_data_au AFTER UPDATE ON photos_fts_data BEGIN
  INSERT INTO photos_fts(rowid, caption, filename, tags, persons)
  VALUES (new.rowid, new.caption, new.filename, new.tags, new.persons);
END;

-- 5. Triggers sur photos → photos_fts_data

-- INSERT
CREATE TRIGGER photos_fts_ai AFTER INSERT ON photos BEGIN
  INSERT INTO photos_fts_data (rowid, caption, filename, tags, persons)
  SELECT
    new.id, new.caption, new.filename,
    (SELECT GROUP_CONCAT(t.name, ' ') FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.photo_id = new.id),
    (SELECT GROUP_CONCAT(pe.name, ' ') FROM faces f JOIN persons pe ON pe.id = f.person_id WHERE f.photo_id = new.id)
  ;
END;

-- UPDATE (filename ou caption)
CREATE TRIGGER photos_fts_au AFTER UPDATE OF filename, caption ON photos BEGIN
  UPDATE photos_fts_data SET caption = new.caption, filename = new.filename WHERE rowid = new.id;
END;

-- DELETE
CREATE TRIGGER photos_fts_ad AFTER DELETE ON photos BEGIN
  DELETE FROM photos_fts_data WHERE rowid = old.id;
END;

-- 6. Triggers sur photo_tags → met à jour la colonne tags

-- INSERT
CREATE TRIGGER photo_tags_fts_ai AFTER INSERT ON photo_tags BEGIN
  UPDATE photos_fts_data SET tags = (
    SELECT GROUP_CONCAT(t.name, ' ') FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.photo_id = new.photo_id
  ) WHERE rowid = new.photo_id;
END;

-- DELETE
CREATE TRIGGER photo_tags_fts_ad AFTER DELETE ON photo_tags BEGIN
  UPDATE photos_fts_data SET tags = (
    SELECT GROUP_CONCAT(t.name, ' ') FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.photo_id = old.photo_id
  ) WHERE rowid = old.photo_id;
END;

-- 7. Trigger sur tags (renommage) → met à jour la colonne tags
CREATE TRIGGER tags_fts_au AFTER UPDATE OF name ON tags BEGIN
  UPDATE photos_fts_data SET tags = (
    SELECT GROUP_CONCAT(t.name, ' ') FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.photo_id = photos_fts_data.rowid
  ) WHERE rowid IN (SELECT photo_id FROM photo_tags WHERE tag_id = new.id);
END;

-- 8. Triggers sur faces → met à jour la colonne persons

-- INSERT
CREATE TRIGGER faces_fts_ai AFTER INSERT ON faces BEGIN
  UPDATE photos_fts_data SET persons = (
    SELECT GROUP_CONCAT(pe.name, ' ') FROM faces f JOIN persons pe ON pe.id = f.person_id WHERE f.photo_id = new.photo_id
  ) WHERE rowid = new.photo_id;
END;

-- DELETE
CREATE TRIGGER faces_fts_ad AFTER DELETE ON faces BEGIN
  UPDATE photos_fts_data SET persons = (
    SELECT GROUP_CONCAT(pe.name, ' ') FROM faces f JOIN persons pe ON pe.id = f.person_id WHERE f.photo_id = old.photo_id
  ) WHERE rowid = old.photo_id;
END;

-- UPDATE (changement de person_id)
CREATE TRIGGER faces_fts_au AFTER UPDATE OF person_id ON faces BEGIN
  -- Mettre à jour l'ancienne photo
  UPDATE photos_fts_data SET persons = (
    SELECT GROUP_CONCAT(pe.name, ' ') FROM faces f JOIN persons pe ON pe.id = f.person_id WHERE f.photo_id = old.photo_id
  ) WHERE rowid = old.photo_id;
  -- Mettre à jour la nouvelle photo
  UPDATE photos_fts_data SET persons = (
    SELECT GROUP_CONCAT(pe.name, ' ') FROM faces f JOIN persons pe ON pe.id = f.person_id WHERE f.photo_id = new.photo_id
  ) WHERE rowid = new.photo_id;
END;

-- 9. Trigger sur persons (renommage) → met à jour la colonne persons
CREATE TRIGGER persons_fts_au AFTER UPDATE OF name ON persons BEGIN
  UPDATE photos_fts_data SET persons = (
    SELECT GROUP_CONCAT(pe.name, ' ') FROM faces f JOIN persons pe ON pe.id = f.person_id WHERE f.photo_id = photos_fts_data.rowid
  ) WHERE rowid IN (SELECT DISTINCT f.photo_id FROM faces f WHERE f.person_id = new.id);
END;

-- 10. Peuplement initial : remplir photos_fts_data avec les données existantes
--     Les triggers fts_data_ai insèrent automatiquement dans l'index FTS.
INSERT INTO photos_fts_data (rowid, caption, filename, tags, persons)
SELECT
  p.id, p.caption, p.filename,
  (SELECT GROUP_CONCAT(t.name, ' ') FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.photo_id = p.id),
  (SELECT GROUP_CONCAT(pe.name, ' ') FROM faces f JOIN persons pe ON pe.id = f.person_id WHERE f.photo_id = p.id)
FROM photos p;