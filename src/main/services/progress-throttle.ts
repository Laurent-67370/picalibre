/**
 * ProgressThrottle — limite l'émission d'événements scan:progress à
 * ~10 par seconde (100 ms minimum entre émissions), tout en garantissant
 * que le dernier état est toujours envoyé (flush final).
 *
 * Avant : chaque fichier traité envoyait un événement → 10 000 photos
 *         = 10 000+ messages IPC = 10 000+ redraws du renderer.
 * Après : au plus ~10 messages/seconde, plus un flush final — l'UI reste
 *         fluide pendant le scan et le décompte final est exact.
 *
 * Usage :
 *   const send = createProgressThrottle(win, 100)
 *   send({ phase: 'hashing', filesFound, filesProcessed })  // throttlé
 *   ...
 *   await send.flush()  // envoie le dernier état pending (si throttle actif)
 *
 * Le throttle est par-phase : chaque phase (hashing/exif/thumbs) a son propre
 * état (filesFound/filesProcessed) qu'on veut voir progresser, mais on ne
 * veut PAS qu'une phase "écrase" la progression d'une autre phase pendant la
 * fenêtre de throttle. On stocke donc le dernier payload par phase et on
 * n'émet que le payload de la phase courante.
 */
import type { BrowserWindow } from 'electron'
import type { ScanProgress } from '../../shared/ipc'

export interface ProgressSender {
  /** Envoie (ou met en file) une mise à jour de progression. Throtté à ~10/s. */
  send(payload: ScanProgress): void
  /** Force l'envoi immédiat du dernier payload pending, s'il y en a un. */
  flush(): void
}

/**
 * Crée un émetteur throtté pour 'scan:progress' vers le renderer.
 * @param win fenêtre cible
 * @param intervalMs intervalle minimum entre deux émissions (défaut 100 ms)
 */
export function createProgressThrottle(
  win: BrowserWindow,
  intervalMs = 100
): ProgressSender {
  let lastSentAt = 0
  let pending: ScanProgress | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const emit = (payload: ScanProgress): void => {
    lastSentAt = Date.now()
    pending = null
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    win.webContents.send('scan:progress', payload)
  }

  const send = (payload: ScanProgress): void => {
    const now = Date.now()
    const elapsed = now - lastSentAt
    if (elapsed >= intervalMs) {
      // Fenêtre écoulée → émission immédiate
      emit(payload)
      return
    }
    // Trop tôt → on met en file et on programme l'émission
    pending = payload
    if (timer) clearTimeout(timer)
    const wait = intervalMs - elapsed
    timer = setTimeout(() => {
      timer = null
      if (pending) {
        const p = pending
        pending = null
        emit(p)
      }
    }, wait)
  }

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (pending) {
      const p = pending
      pending = null
      emit(p)
    }
  }

  return { send, flush }
}