/**
 * Web Worker pour le décodage des miniatures — décharge le main thread.
 *
 * Reçoit une URL thumb://, fait fetch + createImageBitmap, et renvoie
 * l'ImageBitmap au main thread (transférable, zero-copy).
 *
 * Si le protocole thumb:// n'est pas accessible depuis le worker (custom
 * protocol Electron non disponible en contexte Worker), le fetch échoue
 * et le main thread bascule sur le fallback createImageBitmap + requestIdleCallback.
 */
interface DecodeRequest {
  url: string
}

interface DecodeSuccess {
  bitmap: ImageBitmap
  url: string
}

interface DecodeError {
  error: string
  url: string
}

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<DecodeRequest>) => void) | null
  postMessage: (message: DecodeSuccess | DecodeError, transfer?: Transferable[]) => void
}

ctx.onmessage = (e: MessageEvent<DecodeRequest>): void => {
  const { url } = e.data

  fetch(url)
    .then((res: Response): Promise<Blob> => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.blob()
    })
    .then((blob: Blob): Promise<ImageBitmap> => createImageBitmap(blob))
    .then((bitmap: ImageBitmap): void => {
      const msg: DecodeSuccess = { bitmap, url }
      ctx.postMessage(msg, [bitmap])
    })
    .catch((err: Error): void => {
      const msg: DecodeError = { error: err.message, url }
      ctx.postMessage(msg)
    })
}