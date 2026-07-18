# Politique de signature de code

PicaLibre est un logiciel open-source (licence MIT) distribué gratuitement
via [GitHub Releases](https://github.com/Laurent-67370/picalibre/releases).
Les installeurs Windows (`.exe`) sont construits automatiquement à partir
de ce dépôt public par notre pipeline CI (GitHub Actions,
[`.github/workflows/ci.yml`](.github/workflows/ci.yml)) — aucune étape
manuelle, aucun code propriétaire n'entre dans le binaire publié.

## Signature Windows

Les installeurs `.exe` sont signés numériquement grâce à une certification
de code offerte gracieusement aux projets open-source par la
[**SignPath Foundation**](https://signpath.org/), via la plateforme
[SignPath.io](https://signpath.io/).

- **Éditeur affiché** : SignPath Foundation (le certificat est délivré à la
  fondation, pas à un contributeur individuel — voir leurs
  [conditions pour projets open-source](https://signpath.org/terms.html))
- **Clé privée** : générée et stockée sur le module matériel de sécurité
  (HSM) de SignPath — jamais accessible aux mainteneurs du projet
- **Intégration** : la signature est appliquée automatiquement dans le
  pipeline CI, sur les binaires construits depuis ce dépôt

## Vérifier l'intégrité d'un installeur

Windows affiche l'éditeur **SignPath Foundation** lors de l'installation.
Pour vérifier manuellement la signature d'un fichier téléchargé :

```powershell
Get-AuthenticodeSignature ".\PicaLibre Setup X.Y.Z.exe"
```

Le résultat doit indiquer `Status: Valid` avec un certificat émis par
SignPath Foundation.

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
  dépôt seul. Si Laurent souhaite s'y engager un jour, l'intégration
  CI (soumission automatique à `notarytool` à chaque release) peut être
  ajoutée en une fois.
- **Linux** : AppImage et `.deb` ne sont pas signés (non requis par les
  gestionnaires de paquets Linux courants pour une distribution hors dépôt
  officiel).
