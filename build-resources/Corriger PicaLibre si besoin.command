#!/bin/bash
# PicaLibre n'est pas encore signé par un certificat Apple payant (voir
# CODE_SIGNING.md) : macOS bloque parfois son lancement après téléchargement
# ("l'app est endommagée") tant que cette étape n'a pas été faite une fois
# par version installée. Double-clique ce fichier après chaque mise à jour
# si PicaLibre refuse de s'ouvrir — pas besoin d'ouvrir le Terminal toi-même.
echo "Correction de PicaLibre en cours..."
APP="/Applications/PicaLibre.app"
if [ ! -d "$APP" ]; then
  echo "PicaLibre.app n'a pas été trouvé dans /Applications."
  echo "Installe d'abord PicaLibre (glisse-le depuis ce DMG vers Applications), puis relance ce script."
else
  xattr -cr "$APP"
  echo "✅ Terminé. Tu peux maintenant lancer PicaLibre normalement."
fi
echo ""
echo "Appuie sur Entrée pour fermer cette fenêtre."
read -r
