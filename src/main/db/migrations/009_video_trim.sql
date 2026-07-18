-- PicaLibre — migration 009 : découpe vidéo (trim)
-- NULL = pas de découpe (lecture/export intégral, comportement actuel
-- inchangé). Non destructif : le fichier original n'est jamais modifié,
-- seuls ces deux points de repère sont stockés — appliqués à la lecture
-- (Lightbox) et à l'export/inclusion dans un film (ffmpeg -ss/-to).
ALTER TABLE photos ADD COLUMN trim_start_ms INTEGER;
ALTER TABLE photos ADD COLUMN trim_end_ms INTEGER;
