# PicaLibre Web

Galerie mobile miroir de ta bibliothèque PicaLibre : **miniatures + métadonnées
uniquement**, aucun fichier original ne quitte ton ordinateur. Déployable sur
ton VPS (Coolify, Docker, ou Node nu).

## Déploiement Coolify (Oracle Cloud, comme tes autres apps)

1. Nouvelle ressource → **Dockerfile** → pointer sur ce dossier `web-server/`
   du dépôt `picalibre`.
2. Variables d'environnement :
   - `SYNC_TOKEN` — un jeton long et aléatoire (ex. `openssl rand -hex 32`),
     à recopier dans les réglages de synchronisation de l'app desktop.
   - `PORT=4100` (ou laisser par défaut).
3. **Volume persistant** sur `/data` — sinon la galerie repart de zéro à
   chaque redéploiement.
4. Domaine : par exemple `photos.lhusser.cloud`, HTTPS via Traefik (comme
   `home.lhusser.cloud`).

## Déploiement Docker manuel

```bash
docker build -t picalibre-web .
docker run -d -p 4100:4100 \
  -e SYNC_TOKEN=$(openssl rand -hex 32) \
  -v picalibre-web-data:/data \
  --name picalibre-web picalibre-web
```

## Sans Docker

```bash
npm install
SYNC_TOKEN=un-jeton-long PORT=4100 npm start
```

## Sécurité

- Le jeton protège **toute** l'API (lecture et écriture) — sans lui, rien
  n'est accessible.
- HTTPS fortement recommandé (le jeton transite en clair sinon) : Traefik
  s'en charge automatiquement sur Coolify.
- Aucun original, aucune donnée EXIF sensible (adresse précise) au-delà de la
  latitude/longitude déjà choisie côté desktop.
