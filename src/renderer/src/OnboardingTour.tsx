/**
 * OnboardingTour — visite guidée au premier lancement (façon Picasa 3).
 * Repère les vrais éléments de l'UI via des attributs data-tour="..."
 * posés dans App.tsx, plutôt que des sélecteurs texte fragiles.
 * Persistée via localStorage ; rejouable depuis Aide → Revoir la visite.
 */
import { useEffect, useState } from 'react'

interface Step {
  target: string // valeur de l'attribut data-tour à repérer
  title: string
  body: string
  placement: 'right' | 'bottom' | 'top'
}

const STEPS: Step[] = [
  {
    target: 'add-folder',
    title: '👋 Bienvenue dans PicaLibre',
    body: "Commence par ajouter un dossier de photos ou vidéos — il sera ensuite surveillé automatiquement, aucun scan manuel à relancer.",
    placement: 'right'
  },
  {
    target: 'sidebar-nav',
    title: 'Ta bibliothèque',
    body: 'Chronologie, Carte, Doublons, Photos masquées, personnes détectées, albums et dossiers surveillés — tout est ici.',
    placement: 'right'
  },
  {
    target: 'grid',
    title: 'La grille',
    body: 'Clic pour sélectionner, Ctrl/⌘+clic pour ajouter, double-clic pour afficher ou lire. Clic droit pour toutes les actions rapides.',
    placement: 'top'
  },
  {
    target: 'tray',
    title: 'Le bac',
    body: "Sélectionne plusieurs photos : elles apparaissent ici avec toutes les actions groupées (albums, tags, export, correction auto…).",
    placement: 'top'
  },
  {
    target: 'help-button',
    title: "Besoin d'aide ?",
    body: "Ce bouton (ou la touche F1) ouvre le centre d'aide cherchable, à tout moment.",
    placement: 'bottom'
  }
]

const STORAGE_KEY = 'picalibre.onboarding.done'

export function onboardingDone(): boolean {
  return localStorage.getItem(STORAGE_KEY) === '1'
}

export default function OnboardingTour({ onFinish }: { onFinish: () => void }): JSX.Element | null {
  const [stepIndex, setStepIndex] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)

  const step = STEPS[stepIndex]

  useEffect(() => {
    const el = document.querySelector(`[data-tour="${step.target}"]`)
    setRect(el ? el.getBoundingClientRect() : null)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [step.target])

  const finish = (): void => {
    localStorage.setItem(STORAGE_KEY, '1')
    onFinish()
  }

  const next = (): void => {
    if (stepIndex < STEPS.length - 1) setStepIndex(stepIndex + 1)
    else finish()
  }

  // Position de la carte, calée près de l'élément visé (avec repli si absent)
  const cardStyle: React.CSSProperties = rect
    ? step.placement === 'right'
      ? { top: rect.top, left: rect.right + 16 }
      : step.placement === 'bottom'
        ? { top: rect.bottom + 12, left: Math.max(16, rect.left - 100) }
        : { bottom: window.innerHeight - rect.top + 12, left: Math.max(16, rect.left) }
    : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1090, pointerEvents: 'none' }}>
      {/* Voile sombre avec découpe autour de l'élément ciblé */}
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
        <defs>
          <mask id="tour-mask">
            <rect width="100%" height="100%" fill="white" />
            {rect && (
              <rect
                x={rect.left - 6}
                y={rect.top - 6}
                width={rect.width + 12}
                height={rect.height + 12}
                rx={8}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="#0f172acc" mask="url(#tour-mask)" />
        {rect && (
          <rect
            x={rect.left - 6}
            y={rect.top - 6}
            width={rect.width + 12}
            height={rect.height + 12}
            rx={8}
            fill="none"
            stroke="#f97316"
            strokeWidth={2}
          />
        )}
      </svg>

      {/* Carte d'explication */}
      <div
        style={{
          position: 'absolute',
          ...cardStyle,
          pointerEvents: 'auto',
          background: '#1e293b',
          color: '#e2e8f0',
          border: '1px solid #334155',
          borderRadius: 10,
          padding: 18,
          width: 300,
          boxShadow: '0 8px 32px #000a'
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 8 }}>{step.title}</div>
        <div style={{ fontSize: 13, lineHeight: 1.5, color: '#cbd5e1' }}>{step.body}</div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 16
          }}
        >
          <button onClick={finish} style={{ opacity: 0.7, fontSize: 12 }}>
            Passer
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 11, color: '#94a3b8' }}>
              {stepIndex + 1} / {STEPS.length}
            </span>
            <button className="primary" onClick={next}>
              {stepIndex < STEPS.length - 1 ? 'Suivant →' : 'Terminer'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
