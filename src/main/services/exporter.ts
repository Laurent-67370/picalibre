/**
 * Exports : lots avec presets/watermark (applique les éditions !),
 * métadonnées CSV (ISO-8859-1, séparateur ';', fins de ligne CRLF),
 * partage email (copies redimensionnées + client mail).
 */
import { BrowserWindow, shell, app } from 'electron'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getDb } from '../db'
import { getEditState } from './edits'
import { renderEdited, ExportOptions } from './render-sharp'

export interface BatchExportOptions {
  photoIds: number[]
  destDir: string
  maxSize: number | null
  quality: number
  watermark: string | null
}

export async function batchExport(
  win: BrowserWindow,
  opts: BatchExportOptions
): Promise<{ exported: number; errors: number }> {
  const db = getDb()
  const getPhoto = db.prepare('SELECT filepath, filename FROM photos WHERE id = ?')
  let exported = 0
  let errors = 0
  await mkdir(opts.destDir, { recursive: true })

  for (const id of opts.photoIds) {
    try {
      const photo = getPhoto.get(id) as { filepath: string; filename: string } | undefined
      if (!photo) throw new Error('photo introuvable')
      const { stack } = getEditState(id)
      const renderOpts: ExportOptions = {
        format: 'jpeg',
        quality: opts.quality,
        maxSize: opts.maxSize ?? undefined,
        watermark: opts.watermark ?? undefined
      }
      const buffer = await renderEdited(photo.filepath, stack, renderOpts)
      const base = photo.filename.replace(/\.[^.]+$/, '')
      await writeFile(join(opts.destDir, `${base}.jpg`), buffer)
      exported++
    } catch {
      errors++
    }
    win.webContents.send('export:progress', {
      done: exported + errors,
      total: opts.photoIds.length
    })
  }
  return { exported, errors }
}

/** CSV façon "règles maison" : ISO-8859-1, ';', CRLF, pas de BOM. */
export async function exportMetadataCsv(
  photoIds: number[],
  destFile: string
): Promise<{ rows: number }> {
  const db = getDb()
  const stmt = db.prepare(
    `SELECT p.filename, p.filepath, p.taken_at, p.rating, p.is_favorite, p.caption,
            p.gps_lat, p.gps_lon,
            (SELECT GROUP_CONCAT(t.name, ', ') FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
              WHERE pt.photo_id = p.id) AS tags,
            (SELECT GROUP_CONCAT(DISTINCT pe.name) FROM faces f JOIN persons pe ON pe.id = f.person_id
              WHERE f.photo_id = p.id AND pe.name IS NOT NULL) AS persons
     FROM photos p WHERE p.id = ?`
  )
  const clean = (v: unknown): string =>
    v == null ? '' : String(v).replace(/;/g, ',').replace(/\r?\n/g, ' ')
  const fmtDate = (t: number | null): string => {
    if (!t) return ''
    const d = new Date(t * 1000)
    const p2 = (n: number): string => String(n).padStart(2, '0')
    return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`
  }

  const lines = ['Fichier;Chemin;Date de prise;Note;Favori;Légende;Tags;Personnes;Latitude;Longitude']
  for (const id of photoIds) {
    const r = stmt.get(id) as Record<string, unknown> | undefined
    if (!r) continue
    lines.push(
      [
        clean(r.filename),
        clean(r.filepath),
        fmtDate(r.taken_at as number | null),
        String(r.rating ?? 0),
        r.is_favorite ? 'Oui' : 'Non',
        clean(r.caption),
        clean(r.tags),
        clean(r.persons),
        r.gps_lat != null ? String(r.gps_lat).replace('.', ',') : '',
        r.gps_lon != null ? String(r.gps_lon).replace('.', ',') : ''
      ].join(';')
    )
  }
  const content = lines.join('\r\n') + '\r\n'
  await writeFile(destFile, Buffer.from(content, 'latin1'))
  return { rows: lines.length - 1 }
}

/**
 * Export vers blog : redimensionne à 1024 px, copie le chemin dans le
 * presse-papiers, ouvre le navigateur par défaut vers un site de blog.
 */
export async function blogExport(photoId: number): Promise<{ ok: boolean; error?: string }> {
  const { clipboard } = await import('electron')
  const db = getDb()
  const photo = db.prepare('SELECT filepath, filename FROM photos WHERE id = ?').get(photoId) as
    | { filepath: string; filename: string }
    | undefined
  if (!photo) return { ok: false, error: 'Photo introuvable' }

  try {
    const { stack } = getEditState(photoId)
    const buffer = await renderEdited(photo.filepath, stack, { format: 'jpeg', quality: 88, maxSize: 1024 })
    const base = photo.filename.replace(/\.[^.]+$/, '')
    const tmpFile = join(app.getPath('temp'), `picalibre-blog-${base}-${Date.now()}.jpg`)
    await writeFile(tmpFile, buffer)
    clipboard.writeText(tmpFile)
    void shell.openExternal('https://wordpress.com/post')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Email (photo unique via menu contextuel) : export JPEG temp + ouverture dossier + client mail. */
export async function emailPhoto(photoId: number): Promise<{ ok: boolean; error?: string }> {
  const db = getDb()
  const photo = db.prepare('SELECT filepath, filename FROM photos WHERE id = ?').get(photoId) as
    | { filepath: string; filename: string }
    | undefined
  if (!photo) return { ok: false, error: 'Photo introuvable' }

  try {
    const { stack } = getEditState(photoId)
    const buffer = await renderEdited(photo.filepath, stack, { format: 'jpeg', quality: 90, maxSize: 1600 })
    const base = photo.filename.replace(/\.[^.]+$/, '')
    const tmpFile = join(app.getPath('temp'), `picalibre-email-${base}-${Date.now()}.jpg`)
    await writeFile(tmpFile, buffer)
    shell.showItemInFolder(tmpFile)
    void shell.openExternal(
      `mailto:?subject=${encodeURIComponent('Photo')}&body=${encodeURIComponent(
        "La photo est prête à être jointe — le dossier vient de s'ouvrir."
      )}`
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Email : copies 1600 px dans un dossier temporaire + client mail + dossier ouvert. */
export async function emailShare(
  win: BrowserWindow,
  photoIds: number[]
): Promise<{ dir: string }> {
  const dir = join(app.getPath('temp'), `picalibre-email-${Date.now()}`)
  await batchExport(win, {
    photoIds,
    destDir: dir,
    maxSize: 1600,
    quality: 88,
    watermark: null
  })
  shell.showItemInFolder(dir)
  void shell.openExternal(
    `mailto:?subject=${encodeURIComponent('Photos')}&body=${encodeURIComponent(
      `${photoIds.length} photo(s) redimensionnée(s) prête(s) à joindre — le dossier vient de s'ouvrir.`
    )}`
  )
  return { dir }
}

/**
 * Définit une photo (avec éditions appliquées) comme fond d'écran.
 * Adaptation selon l'OS :
 *  - Linux : gsettings set org.gnome.desktop.background picture-uri file://path
 *  - Windows : powershell SystemParametersInfo
 *  - macOS : osascript -e 'tell application "System Events" to set picture ...'
 *
 * La photo est exportée vers un fichier temporaire avant d'être appliquée.
 */
export async function setWallpaper(
  photoId: number
): Promise<{ ok: boolean; error?: string }> {
  const { exec } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execAsync = promisify(exec)

  const db = getDb()
  const photo = db.prepare('SELECT filepath, filename FROM photos WHERE id = ?').get(photoId) as
    | { filepath: string; filename: string }
    | undefined
  if (!photo) return { ok: false, error: 'Photo introuvable' }

  const { stack } = getEditState(photoId)
  const buffer = await renderEdited(photo.filepath, stack, { format: 'jpeg', quality: 95 })

  const base = photo.filename.replace(/\.[^.]+$/, '')
  const tmpFile = join(app.getPath('temp'), `picalibre-wallpaper-${base}.jpg`)
  await writeFile(tmpFile, buffer)

  const platform = process.platform
  try {
    if (platform === 'linux') {
      // GNOME : gsettings ; KDE : pas de commande universelle, on essaie gsettings
      await execAsync(`gsettings set org.gnome.desktop.background picture-uri "file://${tmpFile}"`)
      await execAsync(`gsettings set org.gnome.desktop.background picture-uri-dark "file://${tmpFile}"`)
    } else if (platform === 'win32') {
      // PowerShell : SystemParametersInfo SPIF_SETDESKWALLPAPER
      const psScript = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W{[DllImport("user32.dll",CharSet=CharSet.Auto)]public static extern int SystemParametersInfo(int uAction,int uParam,string lpvParam,int fuWinIni);}'; [W]::SystemParametersInfo(20,0,"${tmpFile.replace(/\\/g, '\\\\')}",3)`
      await execAsync(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`)
    } else if (platform === 'darwin') {
      // macOS : osascript
      await execAsync(`osascript -e 'tell application "System Events" to set picture of every desktop to "${tmpFile}"'`)
    } else {
      return { ok: false, error: `OS non supporté: ${platform}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
