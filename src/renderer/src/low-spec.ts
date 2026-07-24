/**
 * Heuristique « petite configuration » côté renderer (pas d'accès à node:os).
 *
 * - navigator.hardwareConcurrency : nombre réel de cœurs logiques.
 * - navigator.deviceMemory (Chromium) : RAM approximative, PLAFONNÉE à 8 —
 *   une machine 8 Go et une machine 32 Go rapportent toutes deux 8, donc
 *   seul « ≤ 4 » est un signal fiable de machine vraiment contrainte.
 *
 * Utilisée pour dimensionner les caches et le préchargement du renderer ;
 * le processus main a son propre profil précis (shared/perf-profile.ts).
 */
export function isLowSpecRenderer(): boolean {
  const cores = navigator.hardwareConcurrency || 4
  const deviceMemory = (navigator as { deviceMemory?: number }).deviceMemory
  return cores <= 4 || (deviceMemory !== undefined && deviceMemory <= 4)
}
