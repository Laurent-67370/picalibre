/**
 * Tests de la gestion manuelle des clusters (fusion/scission/confirmation).
 * DB better-sqlite3 en mémoire avec les vraies migrations.
 */
import Database from 'better-sqlite3'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { f32ToBlob, blobToF32, cosine } from '../src/main/services/faces/cluster'
import {
  mergePersons,
  splitFaces,
  confirmFaces,
  rejectFaces,
  facesByPerson,
  recomputeCentroid
} from '../src/main/services/faces/manage-core'

const db = new Database(':memory:')
db.pragma('foreign_keys = ON')
db.exec(readFileSync('src/main/db/migrations/001_init.sql', 'utf8'))
db.exec(readFileSync('src/main/db/migrations/002_faces_scanned.sql', 'utf8'))

// --- Jeu de données : 1 dossier, 6 photos, 2 personnes ---
db.prepare("INSERT INTO folders (id, path) VALUES (1, '/t')").run()
for (let i = 1; i <= 6; i++) {
  db.prepare(
    `INSERT INTO photos (id, folder_id, filename, filepath, hash_xxh3, file_size, file_mtime)
     VALUES (?, 1, ?, ?, ?, 100, 100)`
  ).run(i, `p${i}.jpg`, `/t/p${i}.jpg`, `h${i}`)
}
const emb = (v: number[]): Uint8Array => f32ToBlob(Float32Array.from(v))
// Personne A : embeddings autour de [1,0,0] — Personne B : autour de [0,1,0]
db.prepare('INSERT INTO persons (id, centroid, face_count, name) VALUES (1, ?, 3, ?)').run(
  emb([1, 0, 0]),
  'Nathalie'
)
db.prepare('INSERT INTO persons (id, centroid, face_count, name) VALUES (2, ?, 2, NULL)').run(
  emb([0, 1, 0])
)
const addFace = db.prepare(
  `INSERT INTO faces (id, photo_id, person_id, bbox_x, bbox_y, bbox_w, bbox_h, embedding, confidence, assignment)
   VALUES (?, ?, ?, 0.1, 0.1, 0.2, 0.2, ?, ?, 'auto')`
)
addFace.run(1, 1, 1, emb([1, 0, 0]), 0.9)
addFace.run(2, 2, 1, emb([0.9, 0.1, 0]), 0.8)
addFace.run(3, 3, 1, emb([0.95, 0.05, 0]), 0.55) // peu sûr → à vérifier
addFace.run(4, 4, 2, emb([0, 1, 0]), 0.9)
addFace.run(5, 5, 2, emb([0.1, 0.9, 0]), 0.85)

// --- 1. facesByPerson : tri par confiance croissante ---
const fA = facesByPerson(db as any, 1)
assert.equal(fA.length, 3)
assert.equal(fA[0].id, 3, 'le moins sûr en premier')
console.log('✅ facesByPerson (tri par confiance)')

// --- 2. Confirmation ---
confirmFaces(db as any, [1, 2])
assert.equal(
  (db.prepare("SELECT COUNT(*) c FROM faces WHERE assignment='confirmed'").get() as any).c,
  2
)
console.log('✅ confirmFaces')

// --- 3. Scission : le visage 3 quitte la personne 1 ---
const newId = splitFaces(db as any, [3])!
assert.ok(newId > 2)
const moved = db.prepare('SELECT person_id, assignment FROM faces WHERE id = 3').get() as any
assert.equal(moved.person_id, newId)
assert.equal(moved.assignment, 'auto', 'repart en auto')
const p1 = db.prepare('SELECT face_count, centroid FROM persons WHERE id = 1').get() as any
assert.equal(p1.face_count, 2, 'centroïde/compteur origine recalculés')
const c1 = blobToF32(p1.centroid)
assert.ok(cosine(c1, Float32Array.from([1, 0, 0])) > 0.99, 'centroïde recalculé cohérent')
console.log('✅ splitFaces (recalcul des deux centroïdes)')

// --- 4. Fusion : nouvelle personne fusionnée DANS la 1 ---
mergePersons(db as any, 1, [newId])
assert.equal(db.prepare('SELECT COUNT(*) c FROM persons WHERE id = ?').get(newId) as any && (db.prepare('SELECT COUNT(*) c FROM persons WHERE id = ?').get(newId) as any).c, 0, 'source supprimée')
assert.equal((db.prepare('SELECT face_count FROM persons WHERE id = 1').get() as any).face_count, 3)
console.log('✅ mergePersons (visages re-rattachés, source supprimée)')

// --- 5. Fusion avec transfert de nom : 1 (Nathalie) dans 2 (anonyme) ---
mergePersons(db as any, 2, [1])
const p2 = db.prepare('SELECT name, face_count FROM persons WHERE id = 2').get() as any
assert.equal(p2.name, 'Nathalie', 'le nom de la source est conservé si la cible est anonyme')
assert.equal(p2.face_count, 5)
console.log('✅ mergePersons (transfert de nom vers cible anonyme)')

// --- 6. Rejet : visages 4 et 5 détachés + marqués rejected ---
const rejId = rejectFaces(db as any, [4, 5])!
const rej = db.prepare('SELECT person_id, assignment FROM faces WHERE id IN (4,5)').all() as any[]
assert.ok(rej.every((r) => r.person_id === rejId && r.assignment === 'rejected'))
assert.equal((db.prepare('SELECT face_count FROM persons WHERE id = 2').get() as any).face_count, 3)
console.log('✅ rejectFaces')

// --- 7. Personne vidée = supprimée automatiquement ---
const lastFaces = (db.prepare('SELECT id FROM faces WHERE person_id = ?').all(rejId) as any[]).map((r) => r.id)
splitFaces(db as any, lastFaces) // vide rejId
assert.equal((db.prepare('SELECT COUNT(*) c FROM persons WHERE id = ?').get(rejId) as any).c, 0)
console.log('✅ personne vidée supprimée (recomputeCentroid)')

// --- 8. Idempotence recompute sur personne inexistante ---
recomputeCentroid(db as any, 9999)
console.log('✅ recompute robuste')

console.log('\n🎉 Gestion des clusters : 8/8')
