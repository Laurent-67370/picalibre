/** Colonnes nécessaires à la grille — ~2,5× moins d'octets IPC que SELECT *.
 *  Les métadonnées complètes passent par photos:details (panneau d'infos).
 *  Isolé dans son propre module (plutôt que dans index.ts) pour que les
 *  services (ex: geosearch.ts) puissent l'importer sans créer de cycle
 *  d'import avec le point d'entrée principal. */
export const GRID_COLS =
  'id, folder_id, filename, filepath, media_type, hash_xxh3, file_size, file_mtime, ' +
  'width, height, duration_ms, taken_at, gps_lat, gps_lon, rating, is_favorite, caption, status, ' +
  'trim_start_ms, trim_end_ms'

export const GRID_COLS_P = GRID_COLS.split(', ').map((c) => 'p.' + c).join(', ')
