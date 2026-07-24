# Politique de signature de code

PicaLibre est un logiciel open-source (licence MIT) distribué gratuitement
via [GitHub Releases](https://github.com/Laurent-67370/picalibre/releases).
Les installeurs Windows (`.exe`) sont construits automatiquement à partir
de ce dépôt public par notre pipeline CI (GitHub Actions,
[`.github/workflows/ci.yml`](.github/workflows/ci.yml)) — aucune étape
manuelle, aucun code propriétaire n'entre dans le binaire publié.

## Signature Windows — état actuel : NON signés

Les installeurs `.exe` ne sont **pas encore signés numériquement**.
SmartScreen affiche donc l'avertissement « Éditeur inconnu » au premier
lancement (cliquer sur *Informations complémentaires* → *Exécuter quand
même*). C'est attendu et sans rapport avec l'intégrité du fichier — les
binaires sont construits automatiquement par la CI publique de ce dépôt,
sans étape manuelle.

**Démarche en cours** : un dossier a été déposé auprès de la
[**SignPath Foundation**](https://signpath.org/), qui offre gracieusement
la signature de code aux projets open-source. Il n'a pas encore été
accepté (projet jugé trop jeune) ; une nouvelle candidature sera faite
après quelques mois d'historique de releases. L'intégration CI est déjà
préparée (étape commentée dans
[`.github/workflows/ci.yml`](.github/workflows/ci.yml)) : à l'acceptation,
la signature s'activera en une seule modification.

Une fois actif :
- **Éditeur affiché** : SignPath Foundation (le certificat est délivré à la
  fondation, pas à un contributeur individuel — voir leurs
  [conditions pour projets open-source](https://signpath.org/terms.html))
- **Clé privée** : générée et stockée sur le module matériel de sécurité
  (HSM) de SignPath — jamais accessible aux mainteneurs du projet
- **Intégration** : signature appliquée automatiquement dans le pipeline
  CI, sur les binaires construits depuis ce dépôt

## Vérifier l'intégrité d'un installeur (dès aujourd'hui)

En attendant la signature, chaque fichier de release a une empreinte
**SHA-256** affichée par GitHub (page de la release → icône à côté de
chaque fichier, ou via l'API). Pour vérifier un téléchargement :

```powershell
Get-FileHash ".\PicaLibre.Setup.X.Y.Z.exe" -Algorithm SHA256
```

```bash
sha256sum PicaLibre-X.Y.Z.AppImage
```

L'empreinte doit correspondre exactement à celle affichée sur la page de
la release GitHub.

Quand la signature SignPath sera active, la vérification deviendra :

```powershell
Get-AuthenticodeSignature ".\PicaLibre.Setup.X.Y.Z.exe"
```

avec `Status: Valid` et un certificat émis par SignPath Foundation.

## Autres plateformes

- **macOS** : les `.app`/`.dmg` sont signés en ad-hoc (sans certificat
  Apple Developer payant), ce qui satisfait Gatekeeper au premier
  lancement mais ne permet pas de notarisation Apple ni l'installation
  automatique des mises à jour (voir le
  [CHANGELOG](CHANGELOG.md) — v2.3.2 et v2.5.1 pour le détail). Sur les
  versions récentes de macOS, la signature ad-hoc seule ne suffit
  parfois pas à passer Gatekeeper après un téléchargement (message
  « l'app est endommagée »), nécessitant de retirer manuellement
  l'attribut de quarantaine (`xattr -cr /Applications/PicaLibre.app`).
  **Pour éviter de taper cette commande dans le Terminal à chaque mise
  à jour** : télécharge une fois pour toutes le fichier
  [`Corriger PicaLibre si besoin.command`](https://github.com/Laurent-67370/picalibre/releases/latest)
  (présent dans chaque release, à côté des installeurs), garde-le où tu
  veux (Bureau, dossier Applications…), et double-clique dessus après
  chaque mise à jour si PicaLibre refuse de s'ouvrir — il se réutilise
  indéfiniment, pas besoin de le retélécharger à chaque fois.
  **Solution définitive** (élimine complètement ce problème, sans script
  à relancer) : rejoindre l'Apple Developer Program (99 $/an) pour
  obtenir un certificat Developer ID et faire notariser l'app par Apple
  — une démarche que seul le propriétaire du compte Apple Developer
  peut engager (identité vérifiée par Apple), non automatisable par ce
  dépôt seul. **L'intégration CI est déjà prête** : hardened runtime et
  entitlements configurés (`build-resources/entitlements.mac.plist`),
  signature et notarisation automatiques dès que les secrets
  `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` et `APPLE_TEAM_ID` sont ajoutés au dépôt
  (voir les commentaires de l'étape « Package » dans
  [`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Sans ces
  secrets, rien ne change : signature ad-hoc actuelle.
- **Linux** : AppImage et `.deb` ne sont pas signés (non requis par les
  gestionnaires de paquets Linux courants pour une distribution hors dépôt
  officiel).
