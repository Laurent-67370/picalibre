import { useEffect, useState } from 'react'
import type { PhotoRow, RendererApi } from '@shared/ipc'

declare global {
  interface Window {
    api: RendererApi
  }
}

interface Details {
  photo: PhotoRow & {
    camera_make?: string | null
    camera_model?: string | null
    lens?: string | null
    iso?: number | null
    f_number?: number | null
    exposure_time?: string | null
    focal_length?: number | null
    gps_lat?: number | null
    gps_lon?: number | null
    file_size?: number
  }
  tags: string[]
  faces: number
  albums: string[]
}

const fmtSize = (b?: number): string =>
  b == null ? '—' : b > 1048576 ? `${(b / 1048576).toFixed(1)} Mo` : `${Math.round(b / 1024)} Ko`

const fmtDate = (t: number | null): string =>
  t
    ? new Date(t * 1000).toLocaleString('fr-FR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    : 'Sans date'

function Row({ label, value }: { label: string; value?: string | null }): JSX.Element | null {
  if (!value) return null
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '3px 0' }}>
      <span style={{ color: '#94a3b8', flexShrink: 0 }}>{label}</span>
      <span style={{ textAlign: 'right', wordBreak: 'break-word' }}>{value}</span>
    </div>
  )
}

export default function InfoPanel({
  photoId,
  onClose,
  onShowOnMap
}: {
  photoId: number
  onClose: () => void
  onShowOnMap: () => void
}): JSX.Element {
  const [d, setD] = useState<Details | null>(null)

  useEffect(() => {
    let alive = true
    window.api.invoke('photos:details', { photoId }).then((r) => {
      if (alive) setD(r as Details)
    })
    return () => {
      alive = false
    }
  }, [photoId])

  const p = d?.photo

  return (
    <aside
      style={{
        width: 280,
        flexShrink: 0,
        borderLeft: '1px solid #334155',
        background: '#111827',
        padding: 14,
        overflow: 'auto',
        fontSize: 13
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <strong>ℹ Informations</strong>
        <button onClick={onClose} title="Fermer le panneau" style={{ padding: '4px 8px' }}>
          ✕
        </button>
      </div>

      {!p ? (
        <p style={{ color: '#94a3b8' }}>Chargement…</p>
      ) : (
        <>
          <img
            src={`thumb://library/256/${p.id}`}
            style={{ width: '100%', borderRadius: 8, marginBottom: 10, background: '#0f172a' }}
          />
          <div style={{ fontWeight: 600, wordBreak: 'break-all', marginBottom: 2 }}>{p.filename}</div>
          <div style={{ color: '#94a3b8', marginBottom: 10 }}>{fmtDate(p.taken_at)}</div>

          <Row
            label="Dimensions"
            value={p.width && p.height ? `${p.width} × ${p.height}` : null}
          />
          <Row label="Taille" value={fmtSize(p.file_size)} />
          <Row
            label="Appareil"
            value={[p.camera_make, p.camera_model].filter(Boolean).join(' ') || null}
          />
          <Row label="Objectif" value={p.lens ?? null} />
          <Row
            label="Prise de vue"
            value={
              [
                p.f_number ? `f/${p.f_number}` : null,
                p.exposure_time ? `${p.exposure_time} s` : null,
                p.iso ? `ISO ${p.iso}` : null,
                p.focal_length ? `${p.focal_length} mm` : null
              ]
                .filter(Boolean)
                .join(' · ') || null
            }
          />

          {p.gps_lat != null && p.gps_lon != null && (
            <div style={{ margin: '8px 0' }}>
              <Row label="GPS" value={`${p.gps_lat.toFixed(5)}, ${p.gps_lon.toFixed(5)}`} />
              <button onClick={onShowOnMap} style={{ width: '100%', marginTop: 4 }}>
                🗺 Voir sur la carte
              </button>
            </div>
          )}

          {d.tags.length > 0 && (
            <>
              <div style={{ color: '#94a3b8', margin: '10px 0 4px' }}>Tags</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {d.tags.map((t) => (
                  <span
                    key={t}
                    style={{
                      border: '1px solid #f97316',
                      color: '#fb923c',
                      borderRadius: 999,
                      padding: '2px 10px',
                      fontSize: 12
                    }}
                  >
                    {t}
                  </span>
                ))}
              </div>
            </>
          )}

          {d.albums.length > 0 && (
            <Row label="Albums" value={d.albums.join(', ')} />
          )}
          {d.faces > 0 && <Row label="Visages" value={`${d.faces} détecté(s)`} />}
        </>
      )}
    </aside>
  )
}
