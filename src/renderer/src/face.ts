/**
 * Renderer caché : détection de visages avec @vladmandic/human.
 * Reçoit des lots de photoIds, détecte sur les miniatures 1024 (thumb://),
 * renvoie box normalisée + embedding + score au main.
 */
import { Human, Config } from '@vladmandic/human'

declare global {
  interface Window {
    faceBridge: {
      ready: () => void
      result: (p: unknown) => void
      error: (m: string) => void
      onDetect: (cb: (photoIds: number[]) => void) => void
    }
  }
}

const config: Partial<Config> = {
  modelBasePath: 'faceres://models/',
  backend: 'webgl',
  face: {
    enabled: true,
    detector: { rotation: false, maxDetected: 20, minConfidence: 0.6 },
    mesh: { enabled: false },
    iris: { enabled: false },
    emotion: { enabled: false },
    antispoof: { enabled: false },
    liveness: { enabled: false },
    description: { enabled: true } // → embedding faceres
  },
  body: { enabled: false },
  hand: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: false },
  filter: { enabled: false }
}

const human = new Human(config)

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`image introuvable: ${src}`))
    img.src = src
  })
}

async function detectOne(photoId: number): Promise<void> {
  let faces: unknown[] = []
  try {
    const img = await loadImage(`thumb://library/1024/${photoId}`)
    const res = await human.detect(img)
    const W = img.naturalWidth
    const H = img.naturalHeight
    faces = res.face
      .filter((f) => Array.isArray(f.embedding) && f.embedding.length > 0)
      .map((f) => ({
        box: {
          x: f.box[0] / W,
          y: f.box[1] / H,
          w: f.box[2] / W,
          h: f.box[3] / H
        },
        embedding: Array.from(f.embedding as number[]),
        score: f.score ?? f.boxScore ?? 0
      }))
  } catch {
    // image manquante ou décodage impossible : photo marquée scannée sans visage
  }
  window.faceBridge.result({ photoId, faces, batchDone: false })
}

async function main(): Promise<void> {
  try {
    await human.load()
    await human.warmup()
  } catch (e) {
    window.faceBridge.error(`chargement modèles: ${(e as Error).message}`)
    return
  }

  window.faceBridge.onDetect(async (photoIds) => {
    for (let i = 0; i < photoIds.length; i++) {
      const last = i === photoIds.length - 1
      const photoId = photoIds[i]
      let payload: { photoId: number; faces: unknown[]; batchDone: boolean }
      try {
        const img = await loadImage(`thumb://library/1024/${photoId}`)
        const res = await human.detect(img)
        const W = img.naturalWidth
        const H = img.naturalHeight
        const faces = res.face
          .filter((f) => Array.isArray(f.embedding) && f.embedding.length > 0)
          .map((f) => ({
            box: { x: f.box[0] / W, y: f.box[1] / H, w: f.box[2] / W, h: f.box[3] / H },
            embedding: Array.from(f.embedding as number[]),
            score: f.score ?? f.boxScore ?? 0
          }))
        payload = { photoId, faces, batchDone: last }
      } catch {
        payload = { photoId, faces: [], batchDone: last }
      }
      window.faceBridge.result(payload)
    }
  })

  window.faceBridge.ready()
}

void detectOne // (API unitaire gardée pour debug)
main()
