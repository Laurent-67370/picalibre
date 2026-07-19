/**
 * Détection automatique de voyages/événements (façon Google Photos) :
 * regroupe les photos/vidéos par rupture dans la chronologie.
 *
 * Règle de rupture entre deux photos CONSÉCUTIVES (triées par date de
 * prise de vue) :
 *   - rupture temporelle : plus de 2 jours d'écart, OU
 *   - rupture géographique : plus de 60 km (haversine), uniquement
 *     quand les deux photos ont des coordonnées GPS — l'absence de GPS
 *     sur l'une des deux ne déclenche jamais de rupture à elle seule.
 *
 * Les groupes de moins de 4 photos sont ignorés (pas assez significatifs
 * pour constituer un "voyage" — restent simplement non proposés, aucune
 * photo n'est jamais modifiée par la détection elle-même : elle ne fait
 * que PROPOSER, la création réelle des albums est une étape séparée et
 * explicite côté utilisateur).
 *
 * Le nom suggéré réutilise le géocodage inversé déjà en place
 * (Nominatim/OpenStreetMap) sur la position représentative du groupe
 * (première photo du groupe qui a des coordonnées GPS) : "Ville — 15–18
 * mars 2026". Sans aucune photo géolocalisée dans le groupe, on retombe
 * sur la plage de dates seule.
 */
import { net } from 'electron'
import { getDb } from '../db'

const GAP_SECONDS = 2 * 24 * 3600 // 2 jours
const GEO_KM = 60
const MIN_GROUP_SIZE = 4

export interface TripPhotoLite {
  id: number
  taken_at: number
  gps_lat: number | null
  gps_lon: number | null
}

export interface TripGroup {
  photoIds: number[]
  count: number
  startDate: number
  endDate: number
  city: string | null
  suggestedName: string
  coverPhotoId: number
}

/** Distance haversine en kilomètres. */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371
  const toRad = (d: number): number => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

const MONTHS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'
]

function formatDateRange(startSec: number, endSec: number): string {
  const start = new Date(startSec * 1000)
  const end = new Date(endSec * 1000)
  const sD = start.getDate()
  const sM = start.getMonth()
  const sY = start.getFullYear()
  const eD = end.getDate()
  const eM = end.getMonth()
  const eY = end.getFullYear()
  if (sY === eY && sM === eM && sD === eD) {
    return `${sD} ${MONTHS_FR[sM]} ${sY}`
  }
  if (sY === eY && sM === eM) {
    return `${sD}–${eD} ${MONTHS_FR[sM]} ${sY}`
  }
  if (sY === eY) {
    return `${sD} ${MONTHS_FR[sM]} – ${eD} ${MONTHS_FR[eM]} ${sY}`
  }
  return `${sD} ${MONTHS_FR[sM]} ${sY} – ${eD} ${MONTHS_FR[eM]} ${eY}`
}

async function reverseGeocodeCity(lat: number, lon: number): Promise<string | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`
    const resp = await net.fetch(url, {
      headers: { 'User-Agent': 'PicaLibre/2.21.0 (photo manager)' }
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as {
      address?: { city?: string; town?: string; village?: string; municipality?: string; country?: string }
    }
    const city =
      data.address?.city ?? data.address?.town ?? data.address?.village ?? data.address?.municipality
    return city ?? data.address?.country ?? null
  } catch {
    return null
  }
}

/**
 * Regroupe des photos déjà triées par taken_at croissant en segments
 * séparés par une rupture (temporelle ou géographique). Ne filtre PAS
 * encore par taille minimale — fait par l'appelant.
 */
export function segmentByBreaks(photos: TripPhotoLite[]): TripPhotoLite[][] {
  const groups: TripPhotoLite[][] = []
  let current: TripPhotoLite[] = []
  for (const p of photos) {
    if (current.length === 0) {
      current.push(p)
      continue
    }
    const prev = current[current.length - 1]
    const timeBreak = p.taken_at - prev.taken_at > GAP_SECONDS
    let geoBreak = false
    if (prev.gps_lat != null && prev.gps_lon != null && p.gps_lat != null && p.gps_lon != null) {
      geoBreak = haversineKm(prev.gps_lat, prev.gps_lon, p.gps_lat, p.gps_lon) > GEO_KM
    }
    if (timeBreak || geoBreak) {
      groups.push(current)
      current = [p]
    } else {
      current.push(p)
    }
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/**
 * Détecte les voyages/événements sur toute la bibliothèque active. Lecture
 * seule — ne modifie rien, ne fait que proposer. Les appels de géocodage
 * sont espacés (politique d'usage Nominatim : 1 req/s max) et limités à
 * un seul par groupe retenu (pas par photo).
 */
export async function detectTrips(): Promise<TripGroup[]> {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, taken_at, gps_lat, gps_lon FROM photos
       WHERE status = 'active' AND is_hidden = 0 AND taken_at IS NOT NULL
       ORDER BY taken_at ASC`
    )
    .all() as TripPhotoLite[]

  const segments = segmentByBreaks(rows).filter((g) => g.length >= MIN_GROUP_SIZE)

  const result: TripGroup[] = []
  for (const g of segments) {
    const startDate = g[0].taken_at
    const endDate = g[g.length - 1].taken_at
    const geoPhoto = g.find((p) => p.gps_lat != null && p.gps_lon != null)
    let city: string | null = null
    if (geoPhoto && geoPhoto.gps_lat != null && geoPhoto.gps_lon != null) {
      city = await reverseGeocodeCity(geoPhoto.gps_lat, geoPhoto.gps_lon)
      // Respecte la politique d'usage Nominatim (max ~1 req/s) — seulement
      // entre deux vrais appels réseau, pas quand city est déjà connu ou
      // qu'aucune photo du groupe n'a de GPS.
      await new Promise((r) => setTimeout(r, 1100))
    }
    const dateRange = formatDateRange(startDate, endDate)
    result.push({
      photoIds: g.map((p) => p.id),
      count: g.length,
      startDate,
      endDate,
      city,
      suggestedName: city ? `${city} — ${dateRange}` : dateRange,
      coverPhotoId: g[Math.floor(g.length / 2)].id
    })
  }
  return result
}
