/**
 * ExifService — lecture EXIF/GPS via exiftool-vendored (process exiftool
 * persistant avec pool interne). Écriture DB par transactions groupées.
 */
import { exiftool, Tags } from 'exiftool-vendored'
import { getDb } from '../db'

const CHUNK = 24 // requêtes exiftool en parallèle par vague

export interface ExifTarget {
  id: number
  filepath: string
}

function toEpoch(v: unknown): number | null {
  if (!v) return null
  // exiftool-vendored renvoie des ExifDateTime avec .toDate()
  const d = typeof (v as any).toDate === 'function' ? (v as any).toDate() : new Date(String(v))
  const t = d?.getTime?.()
  return Number.isFinite(t) ? Math.floor(t / 1000) : null
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

export async function extractExifBatch(
  targets: ExifTarget[],
  onProgress?: (done: number, total: number) => void
): Promise<{ done: number; failed: number }> {
  const db = getDb()
  const update = db.prepare(`
    UPDATE photos SET
      taken_at = COALESCE(@taken_at, taken_at),
      camera_make = @camera_make, camera_model = @camera_model, lens = @lens,
      iso = @iso, f_number = @f_number, exposure_time = @exposure_time,
      focal_length = @focal_length,
      gps_lat = CASE WHEN gps_manual = 1 THEN gps_lat ELSE @gps_lat END,
      gps_lon = CASE WHEN gps_manual = 1 THEN gps_lon ELSE @gps_lon END,
      gps_alt = CASE WHEN gps_manual = 1 THEN gps_alt ELSE @gps_alt END,
      orientation = COALESCE(@orientation, orientation),
      width = COALESCE(@width, width),
      height = COALESCE(@height, height)
    WHERE id = @id
  `)

  let done = 0
  let failed = 0

  for (let i = 0; i < targets.length; i += CHUNK) {
    const wave = targets.slice(i, i + CHUNK)
    const results = await Promise.allSettled(wave.map((t) => exiftool.read(t.filepath)))

    const rows: Array<Record<string, unknown>> = []
    results.forEach((r, j) => {
      if (r.status === 'rejected') {
        failed++
        return
      }
      const tags = r.value as Tags
      rows.push({
        id: wave[j].id,
        taken_at:
          toEpoch(tags.DateTimeOriginal) ?? toEpoch(tags.CreateDate) ?? toEpoch(tags.MediaCreateDate),
        camera_make: tags.Make ?? null,
        camera_model: tags.Model ?? null,
        lens: tags.LensModel ?? tags.LensID ?? null,
        iso: num(tags.ISO),
        f_number: num(tags.FNumber),
        exposure_time: tags.ExposureTime != null ? String(tags.ExposureTime) : null,
        focal_length: num(tags.FocalLength),
        gps_lat: num(tags.GPSLatitude),
        gps_lon: num(tags.GPSLongitude),
        gps_alt: num(tags.GPSAltitude),
        orientation: num(tags.Orientation),
        width: num(tags.ImageWidth),
        height: num(tags.ImageHeight)
      })
    })

    const tx = db.transaction((batch: typeof rows) => {
      for (const row of batch) update.run(row)
    })
    tx(rows)

    done += rows.length
    onProgress?.(done, targets.length)
  }

  return { done, failed }
}

export async function shutdownExiftool(): Promise<void> {
  await exiftool.end()
}
