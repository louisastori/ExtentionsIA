# esctentionIALocal

Extension VS Code orientee agent de code. Par defaut, elle demarre en mode local-only, sans provider cloud ni cle API.

## Scripts

- `npm run compile`: compile l'extension et la webview
- `npm run lint`: lance ESLint
- `npm run test:unit`: execute les tests metier du runtime agent/tools
- `npm run test:integration`: lance les tests d'integration via `@vscode/test-cli` dans un hote VS Code
- `npm test`: enchaine les tests unitaires et d'integration
- `npm run package:vsix`: genere une archive `.vsix` locale dans `dist/`

## Fonctions actuelles

- mode local-only active par defaut: profils locaux uniquement, sans `API key missing`
- chat local avec selection de provider/modele
- lecture de fichiers et recherche workspace
- apercu diff et `apply_patch` avec approbation
- terminal/tests avec historique, capture `stdout/stderr`, stop et policy
- mode agent borne avec pause, reprise, stop et approbations UI
- garde GPU reglable par temperature, pourcentage d'utilisation et action `warn`/`pause`/`stop`
