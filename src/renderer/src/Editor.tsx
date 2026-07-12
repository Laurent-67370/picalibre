import { useCallback, useEffect, useRef, useState } from 'react'
import type { PhotoRow, RendererApi } from '@shared/ipc'
import {
  ColorOpType,
  EditStack,
  emptyStack,
  getOp,
  upsertOp
} from '@shared/edit-engine'
import { renderPreview } from './render-canvas'

declare global {
  interface Window {
    api: RendererApi
  }
}

const SLIDERS: Array<{ type: ColorOpType; label: string; min: number; max: number }> = [
  { type: 'fill_light', label: 'Lumière de remplissage', min: 0, max: 1 },
  { type: 'highlights', label: 'Hautes lumières', min: -1, max: 1 },
  { type: 'contrast', label: 'Contraste', min: -1, max: 1 },
  { type: 'saturation', label: 'Saturation', min: -1, max: 1 },
  { type: 'temperature', label: 'Température', min: -1, max: 1 }
]

export default function Editor({
  photo,
  onClose
}: {
  photo: PhotoRow
  onClose: () => void
}): JSX.Element {
  const [stack, setStack] = useState<EditStack>(emptyStack())
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [showOriginal, setShowOriginal] = useState(false)
  const [exportMsg, setExportMsg] = useState('')

  const imgRef = useRef<HTMLImageElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef(0)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()

  // Chargement : stack persisté + image source (preview 1024 du cache)
  useEffect(() => {
    window.api.invoke('edits:get', { photoId: photo.id }).then((s) => {
      setStack(s.stack)
      setCanUndo(s.canUndo)
      setCanRedo(s.canRedo)
    })
    const img = new Image()
    img.onload = () => {
      imgRef.current = img
      scheduleRender()
    }
    img.src = `thumb://library/1024/${photo.id}`
    return () => cancelAnimationFrame(rafRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo.id])

  const scheduleRender = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const img = imgRef.current
      const canvas = canvasRef.current
      if (img && canvas) {
        renderPreview(img, showOriginal ? emptyStack() : stackRef.current, canvas)
      }
    })
  }, [showOriginal])

  const stackRef = useRef(stack)
  stackRef.current = stack
  useEffect(scheduleRender, [stack, showOriginal, scheduleRender])

  // Sauvegarde débouncée (une entrée d'historique par "geste", pas par pixel de slider)
  const applyOp = (op: Parameters<typeof upsertOp>[1], action: string) => {
    const next = upsertOp(stackRef.current, op)
    setStack(next)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      const r = await window.api.invoke('edits:save', { photoId: photo.id, stack: next, action })
      setCanUndo(r.canUndo)
      setCanRedo(r.canRedo)
    }, 400)
  }

  const doUndo = async () => {
    const s = await window.api.invoke('edits:undo', { photoId: photo.id })
    setStack(s.stack)
    setCanUndo(s.canUndo)
    setCanRedo(s.canRedo)
  }
  const doRedo = async () => {
    const s = await window.api.invoke('edits:redo', { photoId: photo.id })
    setStack(s.stack)
    setCanUndo(s.canUndo)
    setCanRedo(s.canRedo)
  }
  const resetAll = () => applyOp({ type: 'straighten', params: { angle: 0 } }, 'reset') // remplacé juste après
  const doReset = async () => {
    const next = emptyStack()
    setStack(next)
    const r = await window.api.invoke('edits:save', { photoId: photo.id, stack: next, action: 'reset' })
    setCanUndo(r.canUndo)
    setCanRedo(r.canRedo)
  }
  void resetAll

  const doExport = async () => {
    setExportMsg('Export en cours…')
    const { outPath } = await window.api.invoke('edits:export', { photoId: photo.id, format: 'jpeg' })
    setExportMsg(outPath ? `✅ Exporté : ${outPath}` : '')
  }

  const angle = getOp(stack, 'straighten')?.params.angle ?? 0

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) doUndo()
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) doRedo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#111418',
        display: 'flex',
        zIndex: 100
      }}
    >
      {/* Panneau outils */}
      <aside
        style={{
          width: 300,
          borderRight: '1px solid #333',
          padding: 16,
          overflow: 'auto',
          flexShrink: 0
        }}
      >
        <button onClick={onClose} style={{ marginBottom: 12 }}>
          ← Bibliothèque (Échap)
        </button>
        <h3 style={{ margin: '4px 0 12px', fontSize: 15 }}>{photo.filename}</h3>

        <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
          <button onClick={doUndo} disabled={!canUndo} title="Ctrl+Z">
            ↩ Annuler
          </button>
          <button onClick={doRedo} disabled={!canRedo} title="Ctrl+Y">
            ↪ Rétablir
          </button>
          <button onClick={doReset}>Original</button>
        </div>

        <label style={{ fontSize: 13, display: 'block', marginBottom: 14 }}>
          Redressement : {angle.toFixed(1)}°
          <input
            type="range"
            min={-15}
            max={15}
            step={0.1}
            value={angle}
            onChange={(e) =>
              applyOp(
                { type: 'straighten', params: { angle: parseFloat(e.target.value) } },
                'straighten'
              )
            }
            style={{ width: '100%' }}
          />
        </label>

        {SLIDERS.map((s) => {
          const value = (getOp(stack, s.type)?.params as { value: number } | undefined)?.value ?? 0
          return (
            <label key={s.type} style={{ fontSize: 13, display: 'block', marginBottom: 14 }}>
              {s.label} : {(value * 100).toFixed(0)}
              <input
                type="range"
                min={s.min}
                max={s.max}
                step={0.01}
                value={value}
                onChange={(e) =>
                  applyOp(
                    { type: s.type, params: { value: parseFloat(e.target.value) } },
                    s.type
                  )
                }
                style={{ width: '100%' }}
              />
            </label>
          )
        })}

        <button
          onMouseDown={() => setShowOriginal(true)}
          onMouseUp={() => setShowOriginal(false)}
          onMouseLeave={() => setShowOriginal(false)}
          style={{ width: '100%', padding: 8, marginBottom: 8 }}
        >
          👁 Maintenir : avant/après
        </button>
        <button onClick={doExport} style={{ width: '100%', padding: 8 }}>
          💾 Exporter en JPEG (pleine résolution)
        </button>
        {exportMsg && (
          <p style={{ fontSize: 12, opacity: 0.8, wordBreak: 'break-all' }}>{exportMsg}</p>
        )}
        <p style={{ fontSize: 11, opacity: 0.45, marginTop: 16 }}>
          Édition non destructive : le fichier original n&apos;est jamais modifié. La preview et
          l&apos;export partagent la même math couleur.
        </p>
      </aside>

      {/* Zone image */}
      <main
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          minWidth: 0
        }}
      >
        <canvas
          ref={canvasRef}
          style={{
            maxWidth: '100%',
            maxHeight: '100%',
            objectFit: 'contain',
            boxShadow: '0 4px 24px #0008',
            borderRadius: 4
          }}
        />
      </main>
    </div>
  )
}
