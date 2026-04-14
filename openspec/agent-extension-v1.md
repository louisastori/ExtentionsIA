# Spécification détaillée `esctentionIALocal` v1

## 1. Objectif produit

Construire une extension VS Code de type assistant de codage local/agentique, pensée pour évoluer par couches:

1. `Chat local`: conversation simple avec un modèle sélectionnable.
2. `Workspace read/edit`: lecture de fichiers, exploration, patch ciblé et visualisation du diff.
3. `Run`: exécution de commandes, tests, build, lecture de sortie.
4. `Agent`: boucle autonome outillée jusqu'à résolution de la tâche ou atteinte de limites de sécurité.

L'extension doit permettre à l'utilisateur de choisir librement:

- le provider
- le modèle
- les paramètres d'inférence
- le mode d'exécution
- le niveau d'autonomie
- les règles d'approbation

## 2. Décisions structurantes

### 2.1 Stack UI

Choix recommandé:

- Webview en `React`
- bundling via `Vite`
- composants VS Code via `@vscode/webview-ui-toolkit`

Raison:

- bon compromis entre vitesse d'itération, écosystème et maintenabilité
- plus adapté qu'un DOM manuel pour le streaming, l'historique, les états d'exécution et l'affichage des patches

### 2.2 Architecture interne

L'extension est découpée en 7 blocs:

1. `Webview App`
2. `Extension Host Controller`
3. `Provider Registry`
4. `Conversation / Agent Orchestrator`
5. `Tool Runtime`
6. `Workspace Services`
7. `Persistence + Secrets + Telemetry`

### 2.3 Règle de montée en puissance

Les fonctionnalités doivent être activées par phases, pas toutes d'un coup:

- phase 1: aucun tool d'écriture
- phase 2: tools lecture + patch
- phase 3: tools terminal/tests
- phase 4: boucle autonome

Le modèle ne doit voir que les tools réellement disponibles dans la phase active.

## 3. Périmètre fonctionnel v1

### 3.1 Fonctionnalités utilisateur

- ouvrir un panneau latéral `Chat`
- envoyer un message à un modèle choisi
- changer de provider et de modèle depuis l'UI
- voir la réponse en streaming
- attacher le contexte de workspace sélectionné
- demander une modification de code
- visualiser un diff proposé
- approuver ou refuser un patch
- lancer des tests/commandes
- activer un mode agentique borné
- relancer, suspendre ou arrêter une exécution

### 3.2 Non-objectifs v1

- indexation sémantique complexe type RAG complet
- exécution distante arbitraire
- multi-agent distribué
- écriture destructrice silencieuse sans garde-fous
- auto-merge git complet

## 4. Architecture détaillée

### 4.1 Webview App

Responsabilités:

- affichage du transcript
- sélection `provider/profile/model`
- affichage des événements d'outil
- affichage des diffs
- contrôle de la boucle agentique
- écran de configuration

Zones UI minimales:

- en-tête:
  - provider
  - modèle
  - mode (`chat`, `edit`, `run`, `agent`)
  - état de la session
- corps:
  - transcript utilisateur / assistant / tools
  - panneaux de diff et sorties terminal
- pied:
  - zone de saisie
  - bouton envoyer
  - bouton arrêter
  - options avancées repliables

### 4.2 Extension Host Controller

Responsabilités:

- créer la Webview
- router les messages IPC
- instancier l'orchestrateur
- appliquer les `WorkspaceEdit`
- gérer les `Terminal`
- persister les paramètres non secrets
- lire/écrire les secrets via `SecretStorage`

### 4.3 Provider Registry

Le registre des providers expose une interface interne unique:

```ts
export interface LlmProviderAdapter {
  readonly providerId: string;
  readonly providerType: "openai" | "anthropic" | "google" | "ollama" | "openai-compatible";
  listModels?(profile: ProviderProfile): Promise<ModelDescriptor[]>;
  createChatCompletion(
    request: CanonicalChatRequest
  ): Promise<AsyncIterable<CanonicalProviderEvent>>;
}
```

Providers cibles:

- `OpenAI`
- `Anthropic`
- `Google Gemini`
- `Ollama`
- `LM Studio` via mode `openai-compatible`
- providers compatibles OpenAI génériques

Le mapping provider-specifique vers les formats internes doit être centralisé dans les adapters, jamais dispersé dans l'UI.

### 4.4 Conversation / Agent Orchestrator

Responsabilités:

- maintenir l'historique canonique
- construire le prompt système
- injecter les tools disponibles
- lancer le provider choisi
- interpréter les tool calls
- exécuter la boucle agentique
- gérer la reprise après observation

Entités minimales:

- `ChatSession`
- `ConversationTurn`
- `RunContext`
- `AgentRun`
- `ToolCallRecord`
- `ApprovalRequest`

### 4.5 Tool Runtime

Le runtime exécute les outils exposés à l'IA. Il doit:

- valider les arguments d'entrée
- vérifier les permissions et approvals
- exécuter l'action
- renvoyer un résultat structuré
- journaliser les actions

Exigences:

- validation JSON Schema côté runtime, pas uniquement côté modèle
- exécution bornée par timeout
- résultats cohérents, textuels + structurés
- refus explicite si l'action sort du workspace autorisé

### 4.6 Workspace Services

Services internes recommandés:

- `WorkspaceIndexService`:
  - liste de fichiers
  - recherche par nom
  - recherche texte
- `FileReadService`:
  - lecture complète
  - lecture partielle
  - métadonnées
- `PatchService`:
  - recherche du bloc exact
  - génération du diff aperçu
  - application via `WorkspaceEdit`
- `TerminalService`:
  - sessions
  - exécution de commandes
  - capture de sortie

### 4.7 Persistence + Secrets

Stockage recommandé:

- `workspaceState`: état léger lié au workspace
- `globalState`: derniers profils/modèles utilisés
- `SecretStorage`: clés API, tokens, secrets d'en-têtes

Ne jamais écrire de clé API en clair dans:

- `settings.json`
- `globalState`
- fichiers de projet
- logs

## 5. UX détaillée

### 5.1 Sélection de l'IA

L'utilisateur doit pouvoir choisir:

- un profil de provider
- un modèle dans ce profil
- ou saisir un nom de modèle custom

Chaque profil doit pouvoir définir:

- `providerType`
- `baseUrl`
- `apiKeySecretRef`
- `model`
- `fallbackModel`
- `temperature`
- `topP`
- `maxOutputTokens`
- `reasoningEffort` si supporté
- `customHeaders`
- `capabilities`

### 5.2 Modes d'exécution

- `chat`:
  - discussion simple
  - aucun tool d'écriture
- `edit`:
  - lecture + patch
  - diff obligatoire avant application
- `run`:
  - edit + terminal/tests
- `agent`:
  - run + boucle autonome bornée

### 5.3 Contrôles avancés

La Webview doit exposer:

- `Max iterations`
- `Max tool calls`
- `Time budget`
- `Auto approve read-only tools`
- `Auto approve workspace edits`
- `Auto approve terminal commands`
- `Command allowlist`
- `Command denylist`
- `Stop on test failure`
- `Continue on recoverable error`
- `Require summary before complete`

### 5.4 Affichage des patches

Avant application:

- aperçu diff
- fichier cible
- bloc recherché
- bloc de remplacement
- statut de validation

Après application:

- résultat
- nombre d'occurrences trouvées
- éventuels conflits

## 6. Configuration VS Code

`package.json` devra à terme exposer `contributes.configuration` avec des clés proches de:

```json
{
  "esctentionialocal.defaultProfileId": "openai-gpt-5.3-codex",
  "esctentionialocal.defaultMode": "chat",
  "esctentionialocal.providers": {},
  "esctentionialocal.agent.maxIterations": 12,
  "esctentionialocal.agent.maxToolCalls": 30,
  "esctentionialocal.agent.timeBudgetMs": 600000,
  "esctentionialocal.agent.autoApproveReadOnlyTools": true,
  "esctentionialocal.agent.autoApproveWorkspaceEdits": false,
  "esctentionialocal.agent.autoApproveTerminal": false
}
```

Les secrets restent hors `contributes.configuration` et sont référencés par identifiant.

## 7. Catalogue d'outils canonique

Le catalogue complet est dans `examples/tools.v1.yaml`, mais la stratégie générale est:

### 7.1 Tools lecture

- `list_workspace`
- `list_directory`
- `search_workspace`
- `read_file`
- `read_file_range`

### 7.2 Tools édition

- `apply_patch`
- `create_file`
- `rename_path`
- `delete_path`

### 7.3 Tools exécution

- `execute_terminal_command`
- `read_command_output`

### 7.4 Tools de contrôle

- `ask_user`
- `complete_task`

## 8. Stratégie de patch

Le patch ne doit pas reposer sur "réécrire le fichier entier" en v1.

Ordre recommandé:

1. `search/replace exact block`
2. `search/replace with occurrence index`
3. `line-range patch`
4. `unified diff` plus tard seulement si besoin réel

Contrat minimal `apply_patch`:

- `absolutePath`
- `searchBlock`
- `replaceBlock`
- `occurrence`
- `createIfMissing` optionnel

Règles:

- refuser si le bloc recherché n'existe pas
- refuser si plusieurs matches et aucune occurrence n'est fournie
- produire un aperçu diff avant application si l'outil n'est pas auto-approuvé
- exécuter via `WorkspaceEdit`

## 9. Stratégie terminal/tests

Le terminal VS Code est utile pour exécuter, mais sa capture directe n'est pas triviale. La spec recommande deux modes:

### 9.1 Mode simple v1

- lancer une commande shell dans un process contrôlé
- capturer `stdout`, `stderr`, `exitCode`
- afficher le flux dans la Webview

### 9.2 Mode intégré VS Code

- créer un terminal nommé
- envoyer la commande
- optionnellement journaliser la sortie vers un fichier temporaire ou un pseudo-terminal

Pour la logique agentique, le modèle doit recevoir:

- la commande lancée
- le code de sortie
- un extrait borné des logs

## 10. Boucle agentique

### 10.1 Principe

La boucle suit:

`Goal -> Think -> Tool Call -> Observation -> Replan -> ... -> Complete`

### 10.2 Modes de boucle

- `single_turn`: une seule réponse du modèle
- `step`: un seul cycle d'outil
- `bounded_auto`: plusieurs cycles bornés
- `until_goal_or_limits`: continue jusqu'à `complete_task` ou jusqu'aux limites de sécurité

### 10.3 Conditions d'arrêt

- `complete_task` appelé
- annulation utilisateur
- budget temps dépassé
- budget d'itérations dépassé
- trop d'erreurs consécutives
- demande explicite d'information utilisateur
- violation de politique

### 10.4 Pseudocode

```ts
while (!run.completed) {
  ensureBudgets(run);

  const response = await provider.createChatCompletion(buildRequest(run));
  const normalized = await collectProviderResponse(response);
  appendAssistantTurn(run, normalized);

  if (!normalized.toolCalls.length) {
    if (normalized.requiresUserInput) {
      run.stopReason = "user_input_required";
      break;
    }

    run.stopReason = "assistant_returned_without_completion";
    break;
  }

  for (const toolCall of normalized.toolCalls) {
    ensureBudgets(run);
    const approval = await approvalService.resolve(toolCall, run.policy);
    if (approval.status !== "approved") {
      appendToolResult(run, toolCall, approval.asToolResult());
      continue;
    }

    const result = await toolRuntime.execute(toolCall, run.context);
    appendToolResult(run, toolCall, result);

    if (toolCall.name === "complete_task" && result.success) {
      run.completed = true;
      run.stopReason = "completed";
      break;
    }
  }
}
```

### 10.5 Politique de sécurité

Le mode "jusqu'à fini" n'autorise pas:

- boucle infinie
- commandes shell non bornées
- suppressions silencieuses hors workspace
- modifications de fichiers invisibles sans journal

## 11. Politique d'approbation

Niveaux recommandés:

- `alwaysRequireApproval`
- `autoApproveReadOnly`
- `autoApproveReadWriteInsideWorkspace`
- `customPolicy`

Actions généralement auto-approuvables:

- `list_workspace`
- `list_directory`
- `search_workspace`
- `read_file`
- `read_file_range`

Actions normalement soumises à approbation:

- `apply_patch`
- `create_file`
- `rename_path`
- `delete_path`
- `execute_terminal_command`

## 12. Contrat de messages Webview <-> Host

Le protocole doit être événementiel, typé et corrélé par `requestId`.

Familles de messages:

- `ui.*`: événements émis par la Webview
- `host.*`: événements émis par l'Extension Host

Exemples:

- `ui.chat.submit`
- `ui.agent.start`
- `ui.agent.stop`
- `ui.settings.upsertProfile`
- `host.stream.delta`
- `host.tool.proposed`
- `host.tool.result`
- `host.run.status`
- `host.error`

Le détail formel est dans `schemas/webview-protocol.schema.json`.

## 13. Proposition d'arborescence de code

```text
src/
  extension.ts
  core/
    session/
      sessionStore.ts
      transcript.ts
    providers/
      base.ts
      openaiAdapter.ts
      anthropicAdapter.ts
      googleAdapter.ts
      ollamaAdapter.ts
      openAiCompatibleAdapter.ts
    agent/
      orchestrator.ts
      runLoop.ts
      budgets.ts
      approvals.ts
    tools/
      registry.ts
      runtime.ts
      definitions.ts
      validators.ts
    workspace/
      fileReadService.ts
      searchService.ts
      patchService.ts
      terminalService.ts
    protocol/
      webviewMessages.ts
      providerMessages.ts
    config/
      settings.ts
      secrets.ts
  webview/
    main.tsx
    App.tsx
    components/
    state/
    protocol/
```

## 14. Critères d'acceptation par phase

### Phase 1

- un chat fonctionne avec au moins 2 providers
- changement de modèle depuis l'UI
- streaming texte fiable
- historique basique

### Phase 2

- lecture de fichiers du workspace
- recherche texte
- apply patch ciblé
- aperçu diff avant application

### Phase 3

- commande shell exécutée
- sortie visible
- tests relançables
- échec exploitable par le modèle

### Phase 4

- boucle multi-étapes
- budgets appliqués
- approbations respectées
- arrêt propre
- résumé final structuré

## 15. Tests à prévoir

### Unit tests

- normalisation des réponses providers
- validation des tool args
- recherche de blocs pour patch
- budgets et stop reasons

### Integration tests

- Webview protocol
- apply patch sur fichiers réels temporaires
- commandes shell contrôlées
- approval workflow

### End-to-end

- ouvrir panneau
- envoyer demande
- lire fichier
- proposer patch
- appliquer
- lancer tests
- terminer la tâche

## 16. Décision finale à retenir

Si l'objectif est un assistant comparable aux extensions modernes de code:

- partir sur `VS Code`, pas `Visual Studio`
- partir sur `React + Vite + TypeScript`
- construire le système autour d'un `catalogue de tools` canonique
- normaliser tous les providers derrière une seule interface
- exposer un mode `until_goal_or_limits`, jamais une boucle infinie brute
