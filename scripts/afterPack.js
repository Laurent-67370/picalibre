const { execFileSync } = require('child_process');
const path = require('path');

/**
 * Hook electron-builder exécuté juste après l'assemblage du bundle .app,
 * avant sa mise en DMG/zip.
 *
 * Sans certificat Apple Developer (99 $/an), electron-builder ne signe pas
 * l'app par défaut. Sur Apple Silicon, un .app non signé déclenche le
 * message Gatekeeper trompeur « L'app est endommagée et ne peut pas être
 * ouverte » (au lieu du simple avertissement « développeur non identifié »
 * qu'on aurait sur Intel) — la quarantaine appliquée par le navigateur au
 * téléchargement, combinée à l'absence de signature, fait échouer la
 * vérification de Gatekeeper.
 *
 * Une signature ad-hoc (`--sign -`, sans identité réelle) ne notarise pas
 * l'app auprès d'Apple, mais suffit à satisfaire cette vérification locale :
 * le message « endommagé » disparaît. Un clic droit → Ouvrir reste
 * nécessaire au tout premier lancement (avertissement standard « développeur
 * non identifié »), ce qui est le comportement normal pour une app hors
 * App Store / hors notarisation.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`[afterPack] Signature ad-hoc de ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
};
