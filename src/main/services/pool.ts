/**
 * Pool de concurrence minimal (audit réactivité, items 14 et 23) : exécute
 * un traitement asynchrone sur une liste avec au plus `concurrency`
 * exécutions simultanées. Chaque « couloir » tire le prochain index dès
 * qu'il a fini le sien — pas de vagues (contrairement à un découpage en
 * chunks + Promise.all, aucun couloir n'attend le plus lent de sa vague).
 *
 * Les erreurs d'un item ne doivent pas interrompre les autres : c'est au
 * worker de faire son propre try/catch s'il veut continuer (même contrat
 * que les boucles séquentielles qu'il remplace).
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) return
  let next = 0
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      await worker(items[i], i)
    }
  })
  await Promise.all(lanes)
}
