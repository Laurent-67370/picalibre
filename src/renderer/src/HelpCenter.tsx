/**
 * HelpCenter — centre d'aide interactif et cherchable.
 * Ouvert via Aide → Centre d'aide, le bouton "?" du bandeau, ou la touche
 * F1 (et "?" hors champ de saisie). Recherche en direct sur titre,
 * catégorie, contenu et mots-clés (voir help-content.ts).
 */
import { useEffect, useMemo, useState } from 'react'
import { HELP_TOPICS, searchHelp, type HelpTopic } from './help-content'

export default function HelpCenter({
  onClose,
  onNavigate
}: {
  onClose: () => void
  onNavigate: (view: 'timeline' | 'map' | 'duplicates' | 'hidden' | 'trash' | 'settings') => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<HelpTopic | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const results = useMemo(() => searchHelp(query), [query])
  const categories = useMemo(() => {
    const map = new Map<string, HelpTopic[]>()
    for (const t of results) {
      if (!map.has(t.category)) map.set(t.category, [])
      map.get(t.category)!.push(t)
    }
    return map
  }, [results])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1080,
        background: 'var(--overlay)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          width: 780,
          maxWidth: '92vw',
          height: 560,
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 12px 48px var(--shadow)'
        }}
      >
        {/* En-tête avec recherche */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '14px 18px',
            borderBottom: '1px solid var(--border)'
          }}
        >
          <span style={{ fontSize: 18 }}>❓</span>
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelected(null)
            }}
            placeholder="Chercher dans l'aide… (ex : recadrer, vidéo, tag, thème)"
            style={{ flex: 1, fontSize: 14 }}
          />
          <button onClick={onClose} title="Fermer (Échap)">
            ✕
          </button>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* Liste des sujets, groupés par catégorie */}
          <div
            style={{
              width: 280,
              borderRight: '1px solid var(--border)',
              overflow: 'auto',
              padding: '8px 0'
            }}
          >
            {results.length === 0 && (
              <p style={{ padding: '12px 16px', fontSize: 13, color: 'var(--muted)' }}>
                Aucun résultat pour « {query} ».
              </p>
            )}
            {[...categories.entries()].map(([cat, topics]) => (
              <div key={cat} style={{ marginBottom: 6 }}>
                <div
                  style={{
                    fontSize: 11,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                    padding: '6px 16px'
                  }}
                >
                  {cat}
                </div>
                {topics.map((t) => (
                  <div
                    key={t.id}
                    onClick={() => setSelected(t)}
                    style={{
                      padding: '8px 16px',
                      fontSize: 13,
                      cursor: 'pointer',
                      background: selected?.id === t.id ? 'var(--card-2)' : 'transparent',
                      borderLeft:
                        selected?.id === t.id ? '3px solid var(--accent)' : '3px solid transparent'
                    }}
                  >
                    {t.title}
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Détail du sujet sélectionné */}
          <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
            {!selected && (
              <div style={{ color: 'var(--muted)', fontSize: 14 }}>
                <p>👋 Choisis un sujet à gauche, ou tape une recherche.</p>
                <p style={{ marginTop: 16 }}>
                  Quelques points de départ : « ajouter un dossier », « recadrer », « vidéo »,
                  « raccourcis », « masquer ».
                </p>
              </div>
            )}
            {selected && (
              <>
                <div
                  style={{
                    fontSize: 11,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: 'var(--accent)',
                    marginBottom: 6
                  }}
                >
                  {selected.category}
                </div>
                <h2 style={{ margin: '0 0 14px', fontSize: 20 }}>{selected.title}</h2>
                <p style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-line' }}>
                  {selected.body}
                </p>
                {selected.action && (
                  <button
                    className="primary"
                    style={{ marginTop: 18 }}
                    onClick={() => {
                      onNavigate(selected.action!.view)
                      onClose()
                    }}
                  >
                    {selected.action.label} →
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        <div
          style={{
            padding: '8px 18px',
            borderTop: '1px solid var(--border)',
            fontSize: 11,
            color: 'var(--muted)'
          }}
        >
          {HELP_TOPICS.length} sujets · Aide → Raccourcis clavier pour la liste complète des gestes
        </div>
      </div>
    </div>
  )
}
