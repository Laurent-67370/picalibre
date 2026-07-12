/**
 * EditsService — persistance des stacks + historique undo/redo illimité.
 * Modèle : edit_history = suite linéaire de snapshots par photo ;
 * edits.current_history_id = pointeur. Une nouvelle action après un undo
 * supprime la branche "redo" (modèle linéaire, comme Picasa).
 */
import { getDb } from '../db'
import { EditStack, emptyStack, parseStack, stackHash } from '../../shared/edit-engine'

export interface EditState {
  stack: EditStack
  canUndo: boolean
  canRedo: boolean
}

function pointer(photoId: number): number {
  const row = getDb()
    .prepare('SELECT current_history_id AS p FROM edits WHERE photo_id = ?')
    .get(photoId) as { p: number | null } | undefined
  return row?.p ?? 0
}

function stateAt(photoId: number, historyId: number): EditState {
  const db = getDb()
  const stack =
    historyId === 0
      ? emptyStack()
      : parseStack(
          (db.prepare('SELECT stack FROM edit_history WHERE id = ?').get(historyId) as any)?.stack ??
            '{}'
        )
  const canUndo = historyId !== 0
  const canRedo = !!db
    .prepare('SELECT 1 FROM edit_history WHERE photo_id = ? AND id > ? LIMIT 1')
    .get(photoId, historyId)
  return { stack, canUndo, canRedo }
}

export function getEditState(photoId: number): EditState {
  return stateAt(photoId, pointer(photoId))
}

export function saveStack(photoId: number, stack: EditStack, action: string): EditState {
  const db = getDb()
  const tx = db.transaction(() => {
    const p = pointer(photoId)
    // Coupe la branche redo
    db.prepare('DELETE FROM edit_history WHERE photo_id = ? AND id > ?').run(photoId, p)
    const { lastInsertRowid } = db
      .prepare('INSERT INTO edit_history (photo_id, stack, action) VALUES (?, ?, ?)')
      .run(photoId, JSON.stringify(stack), action)
    db.prepare(
      `INSERT INTO edits (photo_id, current_stack, current_history_id, stack_hash, updated_at)
       VALUES (?, ?, ?, ?, unixepoch())
       ON CONFLICT(photo_id) DO UPDATE SET
         current_stack = excluded.current_stack,
         current_history_id = excluded.current_history_id,
         stack_hash = excluded.stack_hash,
         updated_at = excluded.updated_at`
    ).run(photoId, JSON.stringify(stack), lastInsertRowid, stackHash(stack))
  })
  tx()
  return getEditState(photoId)
}

function movePointer(photoId: number, newPointer: number): EditState {
  const state = stateAt(photoId, newPointer)
  getDb()
    .prepare(
      `UPDATE edits SET current_history_id = ?, current_stack = ?, stack_hash = ?, updated_at = unixepoch()
       WHERE photo_id = ?`
    )
    .run(newPointer === 0 ? null : newPointer, JSON.stringify(state.stack), stackHash(state.stack), photoId)
  return state
}

export function undo(photoId: number): EditState {
  const p = pointer(photoId)
  if (p === 0) return getEditState(photoId)
  const prev = getDb()
    .prepare('SELECT MAX(id) AS id FROM edit_history WHERE photo_id = ? AND id < ?')
    .get(photoId, p) as { id: number | null }
  return movePointer(photoId, prev.id ?? 0)
}

export function redo(photoId: number): EditState {
  const p = pointer(photoId)
  const next = getDb()
    .prepare('SELECT MIN(id) AS id FROM edit_history WHERE photo_id = ? AND id > ?')
    .get(photoId, p) as { id: number | null }
  if (next.id == null) return getEditState(photoId)
  return movePointer(photoId, next.id)
}
