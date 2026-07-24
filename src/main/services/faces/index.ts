/**
 * FaceService — orchestre la détection de visages.
 *
 * Une fenêtre CACHÉE charge Human (WebGL/WASM, 100 % offline) via face.html.
 * Le main lui envoie des lots de photoId ; elle détecte sur les miniatures
 * 1024 (thumb://) et renvoie box + embedding. Le main insère en DB et
 * effectue le clustering incrémental (voir ./cluster).
 */
import { BrowserWindow, ipcMain, app } from 'electron'
import { join } from 'node:path'
import { getDb } from '../../db'
import { faceBatchSize, faceBatchPauseMs } from '../../../shared/perf-profile'
import {
  PersonCentroid,
  bestMatch,
  blobToF32,
  f32ToBlob,
  mergeCentroid
} from './cluster'

export interface DetectedFace {
  box: { x: number; y: number; w: number; h: number } // normalisé 0–1
  embedding: number[]
  score: number
}

let faceWin: BrowserWindow | null = null
let running = false

export function isFaceScanRunning(): boolean {
  return running
}

export async function startFaceScan(mainWin: BrowserWindow): Promise<void> {
  if (running) return
  const db = getDb()
  const targets = db
    .prepare(
      `SELECT p.id FROM photos p
       WHERE p.status = 'active' AND p.media_type = 'image' AND p.faces_scanned = 0
         AND EXISTS (SELECT 1 FROM thumbnails t WHERE t.photo_id = p.id AND t.size = 1024)`
    )
    .all() as { id: number }[]
  if (targets.length === 0) return
  running = true

  // Centroïdes en mémoire pendant toute la passe
  // Tableau pour bestMatch (boucle cosine) ET Map<number, PersonCentroid>
  // parallèle pour l'update du centroïde par id en O(1) — avant, chaque
  // visage déclenchait un persons.find(x => x.id === personId) O(n) sur
  // le tableau. À 10 000 personnes et 100 000 visages, c'était 10^9
  // comparaisons juste pour retrouver le centroïde déjà identifié.
  const persons: PersonCentroid[] = (
    db.prepare('SELECT id, centroid, face_count FROM persons WHERE is_ignored = 0').all() as {
      id: number
      centroid: Uint8Array | null
      face_count: number
    }[]
  )
    .filter((p) => p.centroid)
    .map((p) => ({ id: p.id, centroid: blobToF32(p.centroid!), count: p.face_count }))
  const personsById = new Map<number, PersonCentroid>(
    persons.map((p) => [p.id, p])
  )

  const insertFace = db.prepare(
    `INSERT INTO faces (photo_id, person_id, bbox_x, bbox_y, bbox_w, bbox_h, embedding, confidence, assignment)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const markScanned = db.prepare('UPDATE photos SET faces_scanned = 1 WHERE id = ?')
  const createPerson = db.prepare(
    'INSERT INTO persons (centroid, face_count) VALUES (?, 1) RETURNING id'
  )
  const updatePerson = db.prepare(
    'UPDATE persons SET centroid = ?, face_count = face_count + 1 WHERE id = ?'
  )

  let processed = 0

  const handleResult = (photoId: number, faces: DetectedFace[]): void => {
    const tx = db.transaction(() => {
      for (const f of faces) {
        const emb = Float32Array.from(f.embedding)
        const match = bestMatch(emb, persons)
        let personId: number
        if (match) {
          personId = match.personId
          // Map.get O(1) — avant persons.find(x => x.id === personId) O(n).
          const p = personsById.get(personId)!
          p.centroid = mergeCentroid(p.centroid, p.count, emb)
          p.count++
          updatePerson.run(f32ToBlob(p.centroid), personId)
        } else {
          const row = createPerson.get(f32ToBlob(emb)) as { id: number }
          personId = row.id
          const np: PersonCentroid = { id: personId, centroid: emb, count: 1 }
          persons.push(np)
          personsById.set(personId, np)
        }
        insertFace.run(
          photoId,
          personId,
          f.box.x,
          f.box.y,
          f.box.w,
          f.box.h,
          f32ToBlob(emb),
          f.score,
          'auto'
        )
      }
      markScanned.run(photoId)
    })
    tx()
    processed++
    if (processed % 10 === 0 || processed === targets.length) {
      mainWin.webContents.send('faces:progress', { done: processed, total: targets.length })
    }
  }

  await new Promise<void>((resolve) => {
    faceWin = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/face.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    const cleanup = (): void => {
      ipcMain.removeAllListeners('faces:ready')
      ipcMain.removeAllListeners('faces:result')
      ipcMain.removeAllListeners('faces:error')
      faceWin?.destroy()
      faceWin = null
      running = false
      mainWin.webContents.send('faces:progress', { done: processed, total: targets.length })
      mainWin.webContents.send('persons:changed', {})
      resolve()
    }

    // Petite configuration (≤ 8 Go / ≤ 4 cœurs) : lots de 4 au lieu de 8 et
    // pause de 250 ms entre deux lots — la détection Human (WebGL/WASM) est
    // la tâche de fond la plus gourmande, sans respiration elle rend la
    // grille poussive pendant toute la passe.
    let cursor = 0
    const BATCH = faceBatchSize()
    const PAUSE_MS = faceBatchPauseMs()
    const sendNext = (): void => {
      if (cursor >= targets.length) {
        cleanup()
        return
      }
      const dispatch = (): void => {
        // La fenêtre a pu être détruite pendant la pause (faces:error, quit)
        if (!faceWin || !running) return
        const batch = targets.slice(cursor, cursor + BATCH).map((t) => t.id)
        cursor += BATCH
        faceWin.webContents.send('faces:detect', { photoIds: batch })
      }
      if (PAUSE_MS > 0 && cursor > 0) setTimeout(dispatch, PAUSE_MS)
      else dispatch()
    }

    ipcMain.on('faces:ready', () => sendNext())
    ipcMain.on('faces:result', (_e, { photoId, faces, batchDone }) => {
      handleResult(photoId, faces as DetectedFace[])
      if (batchDone) sendNext()
    })
    ipcMain.on('faces:error', (_e, { message }) => {
      console.error('[faces]', message)
      cleanup()
    })

    const url = process.env.ELECTRON_RENDERER_URL
    if (url) faceWin.loadURL(`${url}/face.html`)
    else faceWin.loadFile(join(__dirname, '../renderer/face.html'))

    // Sécurité : si le modèle ne charge jamais (30 s), on abandonne proprement
    setTimeout(() => {
      if (running && processed === 0 && cursor === 0) {
        console.error('[faces] timeout de chargement des modèles')
        cleanup()
      }
    }, 30000)
  })
}

export function humanModelsPath(): string {
  return join(app.getAppPath(), 'node_modules', '@vladmandic', 'human', 'models')
}
