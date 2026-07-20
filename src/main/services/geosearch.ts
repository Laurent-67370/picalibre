/**
 * Recherche par lieu géotagué, indépendamment de tout dossier ou album.
 *
 * Le complément naturel de la recherche FTS (qui trouve les photos par
 * dossier/album nommés d'après un lieu) : ici on géocode la REQUÊTE
 * tapée elle-même ("Colmar" → une zone géographique via Nominatim), puis
 * on cherche les photos dont le GPS tombe dans cette zone — qu'elles
 * aient ou non été rangées dans un dossier/album portant ce nom.
 *
 * Volontairement l'inverse de trips.ts (qui géocode les COORDONNÉES de
 * groupes de photos pour leur donner un nom) : ici on géocode un NOM
 * pour en tirer des coordonnées. Un seul appel réseau par recherche
 * "installée" (texte stabilisé après le debounce de la barre de
 * recherche), mis en cache pour toute la durée de vie de l'app — les
 * mêmes 2-3 lieux reviennent souvent d'une recherche à l'autre.
 */
import { app, net } from 'electron'
import { getDb } from '../db'
import { GRID_COLS } from '../grid-cols'
import type { BoundingBox, PhotoRow } from '../../shared/ipc'

/** Cache mémoire requête→zone, cases non trouvées incluses (évite de
 * re-géocoder en vain "chat" ou "vacances" à chaque recherche). */
const geocodeCache = new Map<string, BoundingBox | null>()

async function forwardGeocode(query: string): Promise<BoundingBox | null> {
  const key = query.trim().toLowerCase()
  if (geocodeCache.has(key)) return geocodeCache.get(key) ?? null
  let result: BoundingBox | null = null
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(key)}&limit=1`
    const resp = await net.fetch(url, {
      headers: { 'User-Agent': `PicaLibre/${app.getVersion()} (photo manager)` }
    })
    if (resp.ok) {
      const data = (await resp.json()) as Array<{ boundingbox: [string, string, string, string] }>
      const bbox = data[0]?.boundingbox
      if (bbox) {
        result = {
          south: parseFloat(bbox[0]),
          north: parseFloat(bbox[1]),
          west: parseFloat(bbox[2]),
          east: parseFloat(bbox[3])
        }
      }
    }
  } catch {
    // Pas de réseau, Nominatim indisponible, etc. — on dégrade en
    // silence : la recherche par texte (FTS) reste dans tous les cas
    // pleinement fonctionnelle sans ce complément.
    result = null
  }
  geocodeCache.set(key, result)
  return result
}

/**
 * Cherche les photos géolocalisées dans la zone correspondant à `query`,
 * qu'elles soient ou non déjà couvertes par la recherche FTS habituelle
 * (dossier/album/tag/personne/légende/nom de fichier). Lecture seule,
 * aucun appel si moins de 3 caractères (évite des géocodages sur une
 * frappe encore trop courte pour être un vrai nom de lieu).
 */
export async function searchPhotosByPlace(query: string, limit = 200): Promise<PhotoRow[]> {
  if (query.trim().length < 3) return []
  const bbox = await forwardGeocode(query)
  if (!bbox) return []
  return getDb()
    .prepare(
      `SELECT ${GRID_COLS} FROM photos
       WHERE status = 'active' AND is_hidden = 0
         AND gps_lat IS NOT NULL AND gps_lon IS NOT NULL
         AND gps_lat >= ? AND gps_lat <= ? AND gps_lon >= ? AND gps_lon <= ?
       ORDER BY taken_at DESC LIMIT ?`
    )
    .all(bbox.south, bbox.north, bbox.west, bbox.east, limit) as PhotoRow[]
}
