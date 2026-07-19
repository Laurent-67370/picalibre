-- Nettoyage des tables timeline/tracks/clips/transitions créées par la
-- migration 003_timeline.sql. Ces tables n'étaient référencées que par le
-- code mort de src/main/services/timeline/core.ts (supprimé) — aucune autre
-- partie de l'application ne les utilise. On les DROP proprement si elles
-- existent (IGNORE les bases qui ne les ont jamais créées).
DROP TABLE IF EXISTS transitions;
DROP TABLE IF EXISTS clips;
DROP TABLE IF EXISTS tracks;
DROP TABLE IF EXISTS timelines;