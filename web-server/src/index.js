/**
 * PicaLibre Web — galerie mobile miroir (miniatures + métadonnées seulement).
 * Reçoit les lots de synchronisation depuis l'app desktop, sert l'API JSON
 * et la galerie mobile. Protégé par un token partagé (Authorization: Bearer).
 */
import express from 'express'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import db, { upsertPhoto, deletePhoto, thumbDir } from './db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TOKEN = process.env.SYNC_TOKEN
const PORT = process.env.PORT || 4100

if (!TOKEN) {
  console.error('❌ SYNC_TOKEN manquant (variable d\'environnement obligatoire).')
  process.exit(1)
}

const app = express()
app.use(express.json({ limit: '20mb' }))
app.disable('x-powered-by')

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || ''
  if (auth !== `Bearer ${TOKEN}`) return res.status(401).json({ error: 'unauthorized' })
  next()
}

// ---------- Sync (appelé par l'app desktop) ----------

app.post('/api/sync/batch', requireAuth, (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : []
  const tx = db.transaction((rows) => {
    for (const p of rows) upsertPhoto.run(p)
  })
  tx(items)
  res.json({ upserted: items.length })
})

app.post('/api/sync/delete', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
  const tx = db.transaction((list) => {
    for (const id of list) deletePhoto.run(id)
  })
  tx(ids)
  res.json({ deleted: ids.length })
})

/** Le client interroge quels hash de miniatures existent déjà, pour éviter les ré-envois. */
app.post('/api/sync/thumb-check', requireAuth, (req, res) => {
  const hashes = Array.isArray(req.body?.hashes) ? req.body.hashes : []
  const present = hashes.filter((h) =>
    existsSync(join(thumbDir(), h.slice(0, 2), `${h}_256.webp`))
  )
  res.json({ present })
})

app.put('/api/sync/thumb/:hash/:size', requireAuth, async (req, res) => {
  const { hash, size } = req.params
  if (!/^[a-f0-9]+$/i.test(hash) || !['256', '1024'].includes(size)) {
    return res.status(400).json({ error: 'invalid params' })
  }
  const dir = join(thumbDir(), hash.slice(0, 2))
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, `${hash}_${size}.webp`)
  try {
    await pipeline(req, createWriteStream(dest))
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.put('/api/sync/config', requireAuth, (req, res) => {
  const { libraryName } = req.body || {}
  if (libraryName) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('libraryName', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(libraryName)
  }
  res.json({ ok: true })
})

// ---------- API de lecture (galerie mobile) ----------

app.get('/api/config', requireAuth, (req, res) => {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'libraryName'").get()
  const count = db.prepare('SELECT COUNT(*) c FROM photos').get()
  res.json({ libraryName: row?.value ?? 'PicaLibre', photoCount: count.c })
})

app.get('/api/folders', requireAuth, (_req, res) => {
  const rows = db
    .prepare('SELECT folder_path, COUNT(*) count FROM photos GROUP BY folder_path ORDER BY folder_path')
    .all()
  res.json(rows)
})

app.get('/api/albums', requireAuth, (_req, res) => {
  const rows = db.prepare("SELECT DISTINCT albums FROM photos WHERE albums != '' AND albums IS NOT NULL").all()
  const names = new Set()
  for (const r of rows) for (const a of r.albums.split(',')) if (a) names.add(a)
  res.json([...names].sort())
})

function serializePhoto(p) {
  return {
    id: p.id,
    hash: p.hash,
    filename: p.filename,
    mediaType: p.media_type,
    takenAt: p.taken_at,
    width: p.width,
    height: p.height,
    rating: p.rating,
    caption: p.caption,
    gps: p.gps_lat != null ? { lat: p.gps_lat, lon: p.gps_lon } : null,
    tags: p.tags ? p.tags.split(',').filter(Boolean) : [],
    albums: p.albums ? p.albums.split(',').filter(Boolean) : []
  }
}

app.get('/api/photos', requireAuth, (req, res) => {
  const { folder, album, tag, q, minRating, offset = 0, limit = 300 } = req.query
  let sql = 'SELECT * FROM photos WHERE 1=1'
  const params = []
  if (folder) { sql += ' AND folder_path = ?'; params.push(folder) }
  if (album) { sql += ' AND (\',\' || albums || \',\') LIKE ?'; params.push(`%,${album},%`) }
  if (tag) { sql += ' AND (\',\' || tags || \',\') LIKE ?'; params.push(`%,${tag},%`) }
  if (q) { sql += ' AND filename LIKE ?'; params.push(`%${q}%`) }
  if (minRating) { sql += ' AND rating >= ?'; params.push(Number(minRating)) }
  sql += ' ORDER BY taken_at IS NULL, taken_at DESC LIMIT ? OFFSET ?'
  params.push(Number(limit), Number(offset))
  const rows = db.prepare(sql).all(...params)
  res.json(rows.map(serializePhoto))
})

app.get('/thumb/:hash/:size.webp', (req, res) => {
  const { hash, size } = req.params
  if (!/^[a-f0-9]+$/i.test(hash) || !['256', '1024'].includes(size)) return res.sendStatus(400)
  const file = join(thumbDir(), hash.slice(0, 2), `${hash}_${size}.webp`)
  if (!existsSync(file)) return res.sendStatus(404)
  res.set('Cache-Control', 'public, max-age=31536000, immutable')
  res.sendFile(file)
})

// Auth simple pour la galerie statique : le token est saisi côté client et
// envoyé en header sur chaque appel API ; la page HTML elle-même est publique
// (comme une coquille vide) mais n'affiche rien sans token valide.
app.use(express.static(join(__dirname, '..', 'public')))

app.listen(PORT, () => {
  console.log(`[picalibre-web] écoute sur :${PORT}`)
})
