# esctentionIALocal

Extension VS Code orientee agent de code. Par defaut, elle demarre en mode local-only, sans provider cloud ni cle API.

## Scripts

- `npm run compile`: compile l'extension et la webview
- `npm run lint`: lance ESLint
- `npm run test:unit`: execute les tests metier du runtime agent/tools
- `npm run test:integration`: lance les tests d'integration via `@vscode/test-cli` dans un hote VS Code
- `npm test`: enchaine les tests unitaires et d'integration
- `npm run package:vsix`: genere une archive `.vsix` locale dans `dist/`

## Installation Windows one-click

Le depot inclut un bootstrapper Windows dans `installer/windows/Install-esctentionIALocal.ps1`.

Ce script :
- telecharge le `.vsix` depuis la derniere GitHub Release ou utilise un fichier local
- installe l'extension dans VS Code via `code --install-extension`
- installe Ollama via le script officiel Windows
- demarre Ollama si necessaire
- execute `ollama pull gemma4:26b`

Exemples :

- Installer depuis la derniere release publique :
  - `powershell -ExecutionPolicy Bypass -File .\installer\windows\Install-esctentionIALocal.ps1`
- Installer depuis un `.vsix` local deja genere :
  - `powershell -ExecutionPolicy Bypass -File .\installer\windows\Install-esctentionIALocal.ps1 -VsixPath .\dist\esctentionIALocal.vsix`
- Installer un autre modele :
  - `powershell -ExecutionPolicy Bypass -File .\installer\windows\Install-esctentionIALocal.ps1 -Model gemma4:31b`

## Fonctions actuelles

- mode local-only active par defaut: profils locaux uniquement, sans `API key missing`
- chat local avec selection de provider/modele
- profil local pret pour `Ollama Gemma 4 26B` via `gemma4:26b`
- lecture de fichiers et recherche workspace
- apercu diff et `apply_patch` avec approbation
- terminal/tests avec historique, capture `stdout/stderr`, stop et policy
- mode agent borne avec pause, reprise, stop et approbations UI
- garde GPU reglable par temperature, pourcentage d'utilisation et action `warn`/`pause`/`stop`
