// Store Zustand pour l'état global volatile de l'application.
//
// Objectif: ces états n'ont PAS besoin de re-render la grille de photos
// (ThumbCanvas / virtualizer). En les sortant de App.tsx via un store externe
// consommé avec des selectors ciblés (useStore(s => s.xxx)), on évite que la
// frappe dans la barre de recherche, l'ouverture d'un dialogue d'aide, ou le
// réglage de l'écran de veille ne re-render l'intégralité de App.tsx — et donc
// la grille, la sidebar et la barre d'outils.
//
// États explicitement NON migrés ici (touchent à la grille / au tray / à la
// lightbox et restent dans App.tsx pour l'instant): photos, view, tray,
// progress, cellSize, sortMode, minStars, typeFilter, lightboxIndex, editing,
// slideshow, faceMovieActive, etc.
//
// Le store reste volontairement simple: un slice unique, setters générés
// via `set` immuable. On n'utilise pas de middleware (immer, persist) pour
// ne pas alourdir — la persistance localStorage des réglages écran de veille
// est gérée par des useEffect dans App.tsx comme auparavant.

import { create } from 'zustand'
import type { TripGroup } from '@shared/ipc'
import type { CollageLayout, CollageFormat } from './CollagePreview'

/** Progression websync (événements IPC websync:progress). */
export interface WebsyncProgress {
  phase: 'checking' | 'metadata' | 'thumbnails' | 'done' | 'error'
  done: number
  total: number
  message?: string
}

/** Groupe de voyage tel que présenté dans le dialogue trips ( TripGroup + UI state ). */
export type TripGroupUI = TripGroup & { included: boolean; name: string }

export interface TripCreateProgress {
  done: number
  total: number
}

export interface VolatileState {
  // --- Barre de recherche (re-render la grille à chaque frappe si locale) ---
  searchInput: string
  setSearchInput: (v: string) => void

  // --- Websync (formulaire + message + progression IPC) ---
  websyncUrl: string
  setWebsyncUrl: (v: string) => void
  websyncToken: string
  setWebsyncToken: (v: string) => void
  websyncMsg: string
  setWebsyncMsg: (v: string) => void
  websyncProgress: WebsyncProgress | null
  setWebsyncProgress: (v: WebsyncProgress | null) => void

  // --- Privacy password input (champ volatile des dialogues) ---
  pwInput: string
  setPwInput: (v: string) => void

  // --- Renommage batch ---
  renameOpen: boolean
  setRenameOpen: (v: boolean) => void
  renamePattern: string
  setRenamePattern: (v: string) => void
  renameStart: number
  setRenameStart: (v: number) => void
  renameBusy: boolean
  setRenameBusy: (v: boolean) => void

  // --- Renommage d'une personne (champ inline dans la vue Face) ---
  renameValue: string
  setRenameValue: (v: string) => void

  // --- Watermark (champ export) ---
  watermark: string
  setWatermark: (v: string) => void

  // --- Aide & onboarding ---
  helpOpen: boolean
  setHelpOpen: (v: boolean) => void
  showTour: boolean
  setShowTour: (v: boolean) => void

  // --- Écran de veille (réglages; l'activation elle-même reste côté App) ---
  screensaverEnabled: boolean
  setScreensaverEnabled: (v: boolean) => void
  screensaverMinutes: number
  setScreensaverMinutes: (v: number) => void

  // --- Dialogues Trips ---
  tripsOpen: boolean
  setTripsOpen: (v: boolean) => void
  tripsLoading: boolean
  setTripsLoading: (v: boolean) => void
  tripGroups: TripGroupUI[]
  setTripGroups: (v: TripGroupUI[] | ((prev: TripGroupUI[]) => TripGroupUI[])) => void
  tripsCreating: boolean
  setTripsCreating: (v: boolean) => void
  tripsCreateProgress: TripCreateProgress | null
  setTripsCreateProgress: (v: TripCreateProgress | null) => void

  // --- Collage ---
  collageLayout: CollageLayout
  setCollageLayout: (v: CollageLayout) => void
  collagePreview: boolean
  setCollagePreview: (v: boolean) => void
  collageFormat: CollageFormat
  setCollageFormat: (v: CollageFormat) => void

  /** Réinitialise les champs websync (utile pour les tests / reset UI). */
  resetWebsync: () => void
}

export const useVolatileStore = create<VolatileState>((set) => ({
  searchInput: '',
  setSearchInput: (v) => set({ searchInput: v }),

  websyncUrl: '',
  setWebsyncUrl: (v) => set({ websyncUrl: v }),
  websyncToken: '',
  setWebsyncToken: (v) => set({ websyncToken: v }),
  websyncMsg: '',
  setWebsyncMsg: (v) => set({ websyncMsg: v }),
  websyncProgress: null,
  setWebsyncProgress: (v) => set({ websyncProgress: v }),

  pwInput: '',
  setPwInput: (v) => set({ pwInput: v }),

  renameOpen: false,
  setRenameOpen: (v) => set({ renameOpen: v }),
  renamePattern: '{name}',
  setRenamePattern: (v) => set({ renamePattern: v }),
  renameStart: 1,
  setRenameStart: (v) => set({ renameStart: v }),
  renameBusy: false,
  setRenameBusy: (v) => set({ renameBusy: v }),

  renameValue: '',
  setRenameValue: (v) => set({ renameValue: v }),

  watermark: '',
  setWatermark: (v) => set({ watermark: v }),

  helpOpen: false,
  setHelpOpen: (v) => set({ helpOpen: v }),
  showTour: false, // App.tsx initialise avec !onboardingDone() au montage
  setShowTour: (v) => set({ showTour: v }),

  screensaverEnabled: localStorage.getItem('picalibre.screensaver.enabled') === 'true',
  setScreensaverEnabled: (v) => set({ screensaverEnabled: v }),
  screensaverMinutes: Number(localStorage.getItem('picalibre.screensaver.minutes')) || 5,
  setScreensaverMinutes: (v) => set({ screensaverMinutes: v }),

  tripsOpen: false,
  setTripsOpen: (v) => set({ tripsOpen: v }),
  tripsLoading: false,
  setTripsLoading: (v) => set({ tripsLoading: v }),
  tripGroups: [],
  setTripGroups: (v) =>
    set((state) => ({
      tripGroups: typeof v === 'function' ? v(state.tripGroups) : v
    })),
  tripsCreating: false,
  setTripsCreating: (v) => set({ tripsCreating: v }),
  tripsCreateProgress: null,
  setTripsCreateProgress: (v) => set({ tripsCreateProgress: v }),

  collageLayout: 'grid',
  setCollageLayout: (v) => set({ collageLayout: v }),
  collagePreview: false,
  setCollagePreview: (v) => set({ collagePreview: v }),
  collageFormat: 'jpeg',
  setCollageFormat: (v) => set({ collageFormat: v }),

  resetWebsync: () =>
    set({
      websyncUrl: '',
      websyncToken: '',
      websyncMsg: '',
      websyncProgress: null
    })
}))