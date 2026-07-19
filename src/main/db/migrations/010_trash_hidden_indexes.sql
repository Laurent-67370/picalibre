-- Index partiels pour les vues Corbeille et Masquées (audit performance).
--
-- Ces deux vues filtrent sur des sous-ensembles minoritaires de la table
-- photos (status='trashed' d'un côté, is_hidden=1 de l'autre) mais
-- l'index général idx_photos_taken les forçait à parcourir toute la
-- bibliothèque triée pour en écarter l'immense majorité des lignes.
-- Un index partiel ne stocke QUE les lignes concernées, déjà triées par
-- date : le coût de la requête devient proportionnel à la taille de la
-- corbeille (resp. des masquées), plus à celle de la bibliothèque — et
-- le coût d'écriture/stockage est quasi nul puisque l'index ne grossit
-- qu'avec les photos effectivement en corbeille ou masquées.

CREATE INDEX IF NOT EXISTS idx_photos_trashed
  ON photos (taken_at DESC)
  WHERE status = 'trashed';

CREATE INDEX IF NOT EXISTS idx_photos_hidden
  ON photos (taken_at DESC)
  WHERE is_hidden = 1 AND status = 'active';
