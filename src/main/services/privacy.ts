/**
 * Masquage protégé par mot de passe — scrypt (node:crypto), sel aléatoire.
 * L'état "déverrouillé" vit en mémoire du main, jamais persisté.
 */
import { getDb } from '../db'
import { hashPassword, verifyPassword } from './privacy-core'

const KEY = 'hidden_password'
let unlocked = false

export function privacyStatus(): { hasPassword: boolean; unlocked: boolean } {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as
    | { value: string }
    | undefined
  return { hasPassword: !!row, unlocked: !row || unlocked }
}

export function setPassword(password: string): { ok: boolean; error?: string } {
  const st = privacyStatus()
  if (st.hasPassword && !unlocked) return { ok: false, error: 'verrouillé' }
  const db = getDb()
  if (!password) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(KEY)
    unlocked = false
    return { ok: true }
  }
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(KEY, hashPassword(password))
  unlocked = true
  return { ok: true }
}

export function unlock(password: string): boolean {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as
    | { value: string }
    | undefined
  if (!row) {
    unlocked = true
    return true
  }
  if (verifyPassword(password, row.value)) {
    unlocked = true
    return true
  }
  return false
}

export function isUnlocked(): boolean {
  return privacyStatus().unlocked
}

export function lock(): void {
  unlocked = false
}
