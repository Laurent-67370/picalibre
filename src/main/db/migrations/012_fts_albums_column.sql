-- Migration 012 : ajout de la colonne 'albums' à l'index FTS5.
--
-- Jusqu'ici, chercher "Colmar" trouvait les photos dont le DOSSIER
-- contenait "Colmar" (migration 007), mais pas celles d'un ALBUM nommé
-- "Colmar" — en particulier les albums créés automatiquement par la
-- détection de voyages/événements, qui portent justement le nom du lieu
-- géotagué détecté (ex: "Colmar — 15–18 mars 2026" via géocodage
-- inversé). Une photo géolocalisée à Colmar mais rangée dans un dossier
-- au nom quelconque ne remontait donc jamais.
--
-- FTS5 ne supporte pas ALTER TABLE ADD COLUMN sur une table virtuelle :
-- même reconstruction complète que la migration 007.

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
DROP TRIGGER IF EXISTS folders_fts_au;

DROP TABLE IF EXISTS photos_fts;
DROP TABLE IF EXISTS photos_fts_data;
DROP TABLE IF EXISTS photos_fts_idx;
DROP TABLE IF EXISTS photos_fts_config;
DROP TABLE IF EXISTS photos_fts_content;
DROP TABLE IF EXISTS photos_search_content;

CREATE TABLE photos_search_content (
  rowid    INTEGER PRIMARY KEY,
  caption  TEXT,
  filename TEXT,
  tags     TEXT,
  persons  TEXT,
  folder   TEXT,
  albums   TEXT   -- GROUP_CONCAT des noms d'albums contenant la photo
);

CREATE VIRTUAL TABLE photos_fts USING fts5(
  caption, filename, tags, persons, folder, albums,
  content='photos_search_content', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER fts_data_ai AFTER INSERT ON photos_search_content BEGIN
  INSERT INTO photos_fts(rowid, caption, filename, tags, persons, folder, albums)
  VALUES (new.rowid, new.caption, new.filename, new.tags, new.persons, new.folder, new.albums);
END;

CREATE TRIGGER fts_data_bd BEFORE DELETE ON photos_search_content BEGIN
  INSERT INTO photos_fts(photos_fts, rowid) VALUES('delete', old.rowid);
END;

CREATE TRIGGER fts_data_bu BEFORE UPDATE ON photos_search_content BEGIN
  INSERT INTO photos_fts(photos_fts, rowid) VALUES('delete', old.rowid);
END;

CREATE TRIGGER fts_data_au AFTER UPDATE ON photos_search_content BEGIN
  INSERT INTO photos_fts(rowid, caption, filename, tags, persons, folder, albums)
  VALUES (new.rowid, new.caption, new.filename, new.tags, new.persons, new.folder, new.albums);
END;

CREATE TRIGGER photos_fts_ai AFTER INSERT ON photos BEGIN
  INSERT INTO photos_search_content (rowid, caption, filename, tags, persons, folder, albums)
  SELECT
    new.id, new.caption, new.filename,
    (SELECT GROUP_CONCAT(t.name, ' ') FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.photo_id = new.id),
    (SELECT GROUP_CONCAT(pe.name, ' ') FROM faces f JOIN persons pe ON pe.id = f.person_id WHERE f.photo_id = new.id),
    (SELECT f.path FROM folders f WHERE f.id = new.folder_id),
    (SELECT GROUP_CONCAT(a.name, ' ') FROM album_items ai JOIN albums a ON a.id = ai.album_id WHERE ai.photo_id = new.id)
  ;
END;

CREATE TRIGGER photos_fts_au AFTER UPDATE OF filename, caption, folder_id ON photos BEGIN
  UPDATE photos_search_content
  SET caption = new.caption,
      filename = new.filename,
      folder = (SELECT f.path FROM folders f WHERE f.id = new.folder_id)
  WHERE rowid = new.id;
END;

CREATE TRIGGER photos_fts_ad AFTER DELETE ON photos BEGIN
  DELETE FROM photos_search_content WHERE rowid = old.id;
END;

CREATE TRIGGER photo_tags_fts_ai AFTER INSERT ON photo_tags BEGIN
  UPDATE photos_search_content SET tags = (
    SELECT GROUP_CONCAT(t.name, ' ') FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.photo_id = new.photo_id
  ) WHERE rowid = new.photo_id;
END;

CREATE TRIGGER photo_tags_fts_ad AFTER DELETE ON photo_tags BEGIN
  UPDATE photos_search_content SET tags = (
    SELECT GROUP_CONCAT(t.name, ' ') FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.photo_id = old.photo_id
  ) WHERE rowid = old.photo_id;
END;

CREATE TRIGGER tags_fts_au AFTER UPDATE OF name ON tags BEGIN
  UPDATE photos_search_content SET tags = (
    SELECT GROUP_CONCAT(t.name, ' ') FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.photo_id = photos_search_content.rowid
  ) WHERE rowid IN (SELECT photo_id FROM photo_tags WHERE tag_id = new.id);
END;

CREATE TRIGGER faces_fts_ai AFTER INSERT ON faces BEGIN
  UPDATE photos_search_content SET persons = (
    SELECT GROUP_CONCAT(pe.name, ' ') FROM faces f JOIN persons pe ON pe.id = f.person_id WHERE f.photo_id = new.photo_id
  ) WHERE rowid = new.photo_id;
END;

CREATE TRIGGER faces_fts_ad AFTER DELETE ON faces BEGIN
  UPDATE photos_search_content SET persons = (
    SELECT GROUP_CONCAT(pe.name, ' ') FROM faces f JOIN persons pe ON pe.id = f.person_id WHERE f.photo_id = old.photo_id
  ) WHERE rowid = old.photo_id;
END;

CREATE TRIGGER faces_fts_au AFTER UPDATE OF person_id ON faces BEGIN
  UPDATE photos_search_content SET persons = (
    SELECT GROUP_CONCAT(pe.name, ' ') FROM faces f JOIN persons pe ON pe.id = f.person_id WHERE f.photo_id = old.photo_id
  ) WHERE rowid = old.photo_id;
  UPDATE photos_search_content SET persons = (
    SELECT GROUP_CONCAT(pe.name, ' ') FROM faces f JOIN persons pe ON pe.id = f.person_id WHERE f.photo_id = new.photo_id
  ) WHERE rowid = new.photo_id;
END;

CREATE TRIGGER persons_fts_au AFTER UPDATE OF name ON persons BEGIN
  UPDATE photos_search_content SET persons = (
    SELECT GROUP_CONCAT(pe.name, ' ') FROM faces f JOIN persons pe ON pe.id = f.person_id WHERE f.photo_id = photos_search_content.rowid
  ) WHERE rowid IN (SELECT DISTINCT f.photo_id FROM faces f WHERE f.person_id = new.id);
END;

CREATE TRIGGER folders_fts_au AFTER UPDATE OF path ON folders BEGIN
  UPDATE photos_search_content SET folder = new.path
  WHERE rowid IN (SELECT id FROM photos WHERE folder_id = new.id);
END;

-- Triggers sur album_items → met à jour la colonne albums
CREATE TRIGGER album_items_fts_ai AFTER INSERT ON album_items BEGIN
  UPDATE photos_search_content SET albums = (
    SELECT GROUP_CONCAT(a.name, ' ') FROM album_items ai JOIN albums a ON a.id = ai.album_id WHERE ai.photo_id = new.photo_id
  ) WHERE rowid = new.photo_id;
END;

CREATE TRIGGER album_items_fts_ad AFTER DELETE ON album_items BEGIN
  UPDATE photos_search_content SET albums = (
    SELECT GROUP_CONCAT(a.name, ' ') FROM album_items ai JOIN albums a ON a.id = ai.album_id WHERE ai.photo_id = old.photo_id
  ) WHERE rowid = old.photo_id;
END;

-- Trigger sur albums (renommage) → met à jour la colonne albums de toutes ses photos
CREATE TRIGGER albums_fts_au AFTER UPDATE OF name ON albums BEGIN
  UPDATE photos_search_content SET albums = (
    SELECT GROUP_CONCAT(a.name, ' ') FROM album_items ai JOIN albums a ON a.id = ai.album_id WHERE ai.photo_id = photos_search_content.rowid
  ) WHERE rowid IN (SELECT photo_id FROM album_items WHERE album_id = new.id);
END;

-- Repeuplement initial avec les données existantes
INSERT INTO photos_search_content (rowid, caption, filename, tags, persons, folder, albums)
SELECT
  p.id, p.caption, p.filename,
  (SELECT GROUP_CONCAT(t.name, ' ') FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.photo_id = p.id),
  (SELECT GROUP_CONCAT(pe.name, ' ') FROM faces f JOIN persons pe ON pe.id = f.person_id WHERE f.photo_id = p.id),
  (SELECT f.path FROM folders f WHERE f.id = p.folder_id),
  (SELECT GROUP_CONCAT(a.name, ' ') FROM album_items ai JOIN albums a ON a.id = ai.album_id WHERE ai.photo_id = p.id)
FROM photos p;
