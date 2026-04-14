# OpenSpec `esctentionIALocal`

Ce dossier contient un pack de spécifications pour construire l'extension VS Code `esctentionIALocal` en suivant la montée en puissance souhaitée:

1. chat local d'abord
2. lecture de fichiers + diff + apply patch
3. terminal/tests
4. logique agentique ensuite

Le choix technique retenu dans cette spec est:

- `TypeScript` pour l'extension host
- `React + Vite` pour la Webview
- `@vscode/webview-ui-toolkit` pour conserver une UI cohérente avec VS Code
- preset `OpenAI GPT-5.3-Codex` recommandé pour les tâches de code côté cloud

## Fichiers

- `agent-extension-v1.md`: spécification fonctionnelle et technique principale
- `examples/tools.v1.yaml`: manifeste des outils exposables au modèle
- `examples/settings.sample.jsonc`: exemple de configuration multi-provider et multi-modèle
- `schemas/provider-config.schema.json`: schéma de configuration des providers/modèles
- `schemas/tool-runtime.schema.json`: schéma canonique des tools, tool calls et tool results
- `schemas/webview-protocol.schema.json`: schéma du protocole Webview <-> Extension Host
- `schemas/agent-run.schema.json`: schéma de la boucle agentique, des budgets et des états d'exécution

## Comment utiliser ce pack

1. Lire `agent-extension-v1.md` pour cadrer l'architecture.
2. Prendre `schemas/provider-config.schema.json` comme référence pour `contributes.configuration`.
3. Utiliser `examples/tools.v1.yaml` comme catalogue d'outils canoniques côté orchestrateur.
4. Mapper les formats propriétaires OpenAI / Anthropic / Gemini / Ollama vers les schémas internes.
5. Implémenter les phases dans l'ordre défini, sans exposer les outils avancés avant la phase correspondante.

## Principe clé

Le mode "boucle jusqu'à ce que ce soit fini" ne doit jamais être une boucle infinie. La spec formalise un mode `until_goal_or_limits`:

- l'agent continue tant que l'objectif n'est pas déclaré terminé
- mais il reste borné par `maxIterations`, `maxToolCalls`, `timeBudgetMs` et les règles d'approbation
