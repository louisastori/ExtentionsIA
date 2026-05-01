import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppMode,
  CommandRunRecord,
  GpuGuardAction,
  GpuGuardProvider,
  HostMessage,
  UiMessage
} from './types';
import { isHostMessage, postMessage, vscodeApi } from './vscode';

const APP_VERSION = '0.4.0-phase4';
const COMMAND_PRESETS = [
  { label: 'npm test', command: 'npm test' },
  { label: 'npm run lint', command: 'npm run lint' },
  { label: 'npm run build', command: 'npm run build' }
];
const DEFAULT_ASSISTANT_ACTIVITY: AssistantActivity = {
  tone: 'idle',
  label: 'IA au repos',
  detail: 'Aucune execution en cours'
};

export function App() {
  const initialViewState = useMemo(() => vscodeApi.getState(), []);
  const [session, setSession] = useState<SessionStatePayload | null>(null);
  const [draft, setDraft] = useState('');
  const [selectedProfileId, setSelectedProfileId] = useState(initialViewState?.selectedProfileId ?? '');
  const [selectedMode, setSelectedMode] = useState<AppMode>(initialViewState?.selectedMode ?? 'agent');
  const [modelInput, setModelInput] = useState(initialViewState?.modelInput ?? '');
  const [autoApproveWorkspaceEdits, setAutoApproveWorkspaceEdits] = useState(false);
  const [autoApproveTerminal, setAutoApproveTerminal] = useState(false);
  const [statusText, setStatusText] = useState('Au repos');
  const [assistantActivity, setAssistantActivity] = useState<AssistantActivity>(DEFAULT_ASSISTANT_ACTIVITY);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [commandInput, setCommandInput] = useState('');
  const [commandCwd, setCommandCwd] = useState('');
  const [gpuGuardEnabled, setGpuGuardEnabled] = useState(false);
  const [gpuProvider, setGpuProvider] = useState<GpuGuardProvider>('auto');
  const [gpuAction, setGpuAction] = useState<GpuGuardAction>('pause');
  const [gpuMaxTemperature, setGpuMaxTemperature] = useState('');
  const [gpuMaxUtilization, setGpuMaxUtilization] = useState('');
  const [gpuPollInterval, setGpuPollInterval] = useState('5000');
  const [temperatureInput, setTemperatureInput] = useState('1');
  const [systemPromptInput, setSystemPromptInput] = useState('');
  const [advancedPanelOpen, setAdvancedPanelOpen] = useState(initialViewState?.advancedPanelOpen ?? false);
  const [workspaceToolsOpen, setWorkspaceToolsOpen] = useState(initialViewState?.workspaceToolsOpen ?? false);
  const [activeEditorDetailsOpen, setActiveEditorDetailsOpen] = useState(initialViewState?.activeEditorDetailsOpen ?? false);
  const [isTemperatureDirty, setIsTemperatureDirty] = useState(false);
  const [isSystemPromptDirty, setIsSystemPromptDirty] = useState(false);
  const hasHydratedSelectionRef = useRef(false);
  const lastHydratedTemperatureRef = useRef<string | null>(null);
  const lastHydratedSystemPromptRef = useRef<string | null>(null);

  useEffect(() => {
    const handler = (event: MessageEvent<unknown>) => {
      if (!isHostMessage(event.data)) {
        return;
      }

      handleHostMessage(event.data);
    };

    window.addEventListener('message', handler);
    postMessage(createMessage('ui.ready', { webviewVersion: APP_VERSION }));

    return () => {
      window.removeEventListener('message', handler);
    };
  }, []);

  const activeProfile = useMemo(
    () => session?.profiles.find((profile) => profile.id === selectedProfileId) ?? session?.profiles[0],
    [selectedProfileId, session]
  );

  const runningCommand = useMemo(
    () => session?.commandHistory.find((entry) => entry.status === 'running'),
    [session]
  );
  const currentAgentRun = session?.currentAgentRun;
  const pendingAgentToolApproval = session?.pendingAgentToolApproval;
  const queuedPrompts = session?.queuedPrompts ?? [];
  const activeEditorContext = session?.activeEditorContext;
  const canSaveSelection = Boolean(session && !session.isBusy && activeProfile);
  const canSubmit = draft.trim().length > 0 && Boolean(session && activeProfile);
  const activeModelLabel = modelInput.trim() || activeProfile?.model || 'modele non defini';
  const advancedSummary = `${activeProfile?.label ?? 'aucun profil'} | ${formatModeLabel(selectedMode)} | ${activeModelLabel}`;
  const toolsSummary = formatWorkspaceToolsSummary(
    session?.commandHistory.length ?? 0,
    session?.taskHistory.length ?? 0,
    Boolean(session?.projectMemory),
    Boolean(session?.pendingCommandApproval),
    Boolean(runningCommand)
  );
  const activeEditorSummary = activeEditorContext
    ? `${activeEditorContext.languageId} | ${activeEditorContext.isDirty ? 'non sauvegarde' : 'sauvegarde'} | lignes ${
        activeEditorContext.excerptStartLine
      }-${activeEditorContext.excerptEndLine}`
    : "Aucun fichier actif exploitable dans l'editeur";

  useEffect(() => {
    if (!session) {
      return;
    }

    const selectedProfileExists = session.profiles.some((profile) => profile.id === selectedProfileId);
    if (!hasHydratedSelectionRef.current || session.isBusy || !selectedProfileExists) {
      setSelectedProfileId(session.activeProfileId);
      setSelectedMode(session.mode);
      setModelInput(session.selectedModel);
      hasHydratedSelectionRef.current = true;
    }
    if (!commandCwd && session.workspaceFolders[0]) {
      setCommandCwd(session.workspaceFolders[0]);
    }
    setAutoApproveWorkspaceEdits(session.terminalPolicy.autoApproveWorkspaceEdits);
    setAutoApproveTerminal(session.terminalPolicy.autoApproveTerminal);
    if (typeof session.defaultTemperature === 'number') {
      const nextTemperature = session.defaultTemperature.toFixed(2).replace(/\.00$/, '');
      const hasRemoteTemperatureChanged = lastHydratedTemperatureRef.current !== nextTemperature;
      if (!isTemperatureDirty || hasRemoteTemperatureChanged) {
        setTemperatureInput(nextTemperature);
        setIsTemperatureDirty(false);
      }
      lastHydratedTemperatureRef.current = nextTemperature;
    }
    const nextSystemPrompt = session.systemPrompt ?? '';
    const hasRemoteSystemPromptChanged = lastHydratedSystemPromptRef.current !== nextSystemPrompt;
    if (!isSystemPromptDirty || hasRemoteSystemPromptChanged) {
      setSystemPromptInput(nextSystemPrompt);
      setIsSystemPromptDirty(false);
    }
    lastHydratedSystemPromptRef.current = nextSystemPrompt;
    setGpuGuardEnabled(session.gpuGuard.policy.enabled);
    setGpuProvider(session.gpuGuard.policy.provider);
    setGpuAction(session.gpuGuard.policy.action);
    setGpuMaxTemperature(asInputValue(session.gpuGuard.policy.maxTemperatureC));
    setGpuMaxUtilization(asInputValue(session.gpuGuard.policy.maxUtilizationPercent));
    setGpuPollInterval(asInputValue(session.gpuGuard.policy.pollIntervalMs) || '5000');
  }, [commandCwd, isSystemPromptDirty, isTemperatureDirty, selectedProfileId, session]);

  useEffect(() => {
    const previousState = vscodeApi.getState();
    vscodeApi.setState({
      ...previousState,
      sessionId: session?.sessionId ?? previousState?.sessionId,
      selectedProfileId,
      selectedMode,
      modelInput,
      advancedPanelOpen,
      workspaceToolsOpen,
      activeEditorDetailsOpen
    });
  }, [activeEditorDetailsOpen, advancedPanelOpen, modelInput, selectedMode, selectedProfileId, session?.sessionId, workspaceToolsOpen]);

  useEffect(() => {
    if (session?.pendingCommandApproval || runningCommand) {
      setWorkspaceToolsOpen(true);
    }
  }, [runningCommand, session?.pendingCommandApproval]);

  function handleProfileChange(nextProfileId: string): void {
    setSelectedProfileId(nextProfileId);
    const nextProfile = session?.profiles.find((profile) => profile.id === nextProfileId);
    if (nextProfile) {
      setModelInput(nextProfile.model);
    }
  }

  function handleHostMessage(message: HostMessage): void {
    if (message.type === 'host.session.state') {
      setSession(message.payload);
      setAssistantActivity((current) => deriveAssistantActivityFromSession(message.payload, current));
      setErrorText(null);
      setStatusText((current) => {
        const queuedStatus = formatQueuedPromptCount(message.payload.queuedPrompts.length);
        if (message.payload.isBusy) {
          if (current === 'Au repos' || current === 'Pret' || current.startsWith('File d attente')) {
            return queuedStatus ? `Conversation en cours | ${queuedStatus}` : 'Conversation en cours';
          }

          return current;
        }

        if (message.payload.queuedPrompts.length > 0) {
          return `File d attente | ${queuedStatus}`;
        }

        return current === 'Au repos' ? 'Pret' : current;
      });
      return;
    }

    if (message.type === 'host.stream.delta') {
      setSession((current) => updateAssistantStream(current, message.payload.runId, message.payload.textDelta));
      setAssistantActivity({
        tone: 'running',
        label: 'IA en cours',
        detail: 'Generation de la reponse'
      });
      return;
    }

    if (message.type === 'host.run.status') {
      setAssistantActivity(createAssistantActivityFromRunStatus(message.payload.status, message.payload.stopReason));
      setStatusText(
        `${formatRunStatus(message.payload.status)}${message.payload.stopReason ? ` | ${formatStopReason(message.payload.stopReason)}` : ''}`
      );
      return;
    }

    if (message.type === 'host.command.proposed') {
      setSession((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          pendingCommandApproval: message.payload
        };
      });
      return;
    }

    if (message.type === 'host.command.started') {
      setSession((current) => upsertCommandRecord(current, message.payload));
      setStatusText(`Commande en cours | ${message.payload.command}`);
      return;
    }

    if (message.type === 'host.command.stream') {
      setSession((current) => appendCommandStream(current, message.payload.runId, message.payload.stream, message.payload.textDelta));
      return;
    }

    if (message.type === 'host.command.finished') {
      setSession((current) => upsertCommandRecord(current, message.payload, true));
      setStatusText(`Commande ${formatCommandStatus(message.payload.status)}`);
      return;
    }

    if (message.type === 'host.agent.status') {
      setSession((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          currentAgentRun: message.payload
        };
      });
      setAssistantActivity(createAssistantActivityFromAgentRun(message.payload));
      setStatusText(
        `Agent ${formatAgentStatus(message.payload.status)} | iteration ${message.payload.iteration} | outils ${message.payload.toolCallsUsed}`
      );
      return;
    }

    if (message.type === 'host.agent.approvalRequired') {
      setSession((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          pendingAgentToolApproval: message.payload
        };
      });
      setAssistantActivity({
        tone: 'warning',
        label: 'IA en attente',
        detail: `Approbation requise pour ${message.payload.toolName}`
      });
      setStatusText(`Agent en attente d'approbation | ${message.payload.toolName}`);
      return;
    }

    if (message.type === 'host.preferences.saved') {
      setErrorText(null);
      setStatusText(message.payload.message);
      return;
    }

    if (message.type === 'host.error') {
      setErrorText(message.payload.message);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }

    postMessage(
      createMessage('ui.chat.submit', {
        text: draft.trim(),
        mode: selectedMode,
        profileId: selectedProfileId,
        model: modelInput.trim() || undefined
      })
    );
    setDraft('');
    setErrorText(null);
    if (session?.isBusy || queuedPrompts.length > 0) {
      setStatusText(`Ajoute a la file d attente | ${formatQueuedPromptCount(queuedPrompts.length + 1)}`);
    }
  }

  function handleStopChat(): void {
    postMessage(
      createMessage('ui.agent.stop', {
        runId: session?.busyRunId
      })
    );
  }

  function handleAgentControl(type: 'ui.agent.pause' | 'ui.agent.resume' | 'ui.agent.stop'): void {
    postMessage(
      createMessage(type, {
        runId: currentAgentRun?.runId
      })
    );
  }

  function handleAgentToolApproval(decision: 'approved' | 'rejected'): void {
    if (!pendingAgentToolApproval) {
      return;
    }

    postMessage(
      createMessage('ui.agent.toolApproval', {
        approvalId: pendingAgentToolApproval.approvalId,
        decision
      })
    );
  }

  function handleCommandSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!commandInput.trim()) {
      return;
    }

    postMessage(
      createMessage('ui.command.execute', {
        command: commandInput.trim(),
        cwd: commandCwd.trim() || undefined
      })
    );
  }

  function handleCommandPreset(command: string): void {
    setCommandInput(command);
    postMessage(
      createMessage('ui.command.execute', {
        command,
        cwd: commandCwd.trim() || undefined,
        label: command
      })
    );
  }

  function handleCommandApproval(decision: 'approved' | 'rejected'): void {
    if (!session?.pendingCommandApproval) {
      return;
    }

    postMessage(
      createMessage('ui.command.approval', {
        approvalId: session.pendingCommandApproval.approvalId,
        decision
      })
    );
  }

  function handleStopCommand(runId: string): void {
    postMessage(
      createMessage('ui.command.stop', {
        runId
      })
    );
  }

  function handleGpuGuardSave(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    postMessage(
      createMessage('ui.gpuGuard.update', {
        enabled: gpuGuardEnabled,
        provider: gpuProvider,
        action: gpuAction,
        maxTemperatureC: parseOptionalNumber(gpuMaxTemperature),
        maxUtilizationPercent: parseOptionalNumber(gpuMaxUtilization),
        pollIntervalMs: parseOptionalNumber(gpuPollInterval)
      })
    );
    setStatusText('Surveillance GPU mise a jour');
  }

  function handleSaveSelection(): void {
    if (!canSaveSelection) {
      return;
    }

    const parsedTemperature = parseOptionalNumber(temperatureInput);
    postMessage(
      createMessage('ui.preferences.save', {
        profileId: selectedProfileId || activeProfile?.id,
        mode: selectedMode,
        model: modelInput.trim() || undefined,
        autoApproveWorkspaceEdits,
        autoApproveTerminal,
        temperature: parsedTemperature,
        systemPrompt: systemPromptInput.trim()
      })
    );
  }

  function handleStartOllama(): void {
    postMessage(createMessage('ui.ollama.start', {}));
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">esctentionIALocal</p>
          <h1>Agent workspace</h1>
        </div>
        <div className="topbar-status" aria-live="polite">
          <div className={`status-pill ${assistantActivity.tone}`}>
            <span className={`status-dot ${assistantActivity.tone}`} aria-hidden="true" />
            <span>{assistantActivity.label}</span>
          </div>
          <p className="status-caption">{statusText}</p>
        </div>
      </header>

      <section className="active-editor-card">
        <div className="panel-head">
          <div>
            <strong>Contexte actif</strong>
            <p className="muted">{activeEditorContext ? activeEditorContext.workspacePath : activeEditorSummary}</p>
          </div>
          {activeEditorContext ? <span className="section-label">ligne {activeEditorContext.cursorLine}</span> : null}
        </div>

        {activeEditorContext ? (
          <div className="active-editor-body">
            <div className="meta-chip-row">
              <span className="meta-chip">{activeEditorContext.languageId}</span>
              <span className="meta-chip">{activeEditorContext.isDirty ? 'non sauvegarde' : 'sauvegarde'}</span>
              <span className="meta-chip">
                Curseur {activeEditorContext.cursorLine}:{activeEditorContext.cursorCharacter}
              </span>
              <span className="meta-chip">
                Focus {activeEditorContext.focusStartLine}-{activeEditorContext.focusEndLine}
              </span>
              <span className="meta-chip">{activeEditorContext.lineCount} lignes</span>
            </div>
            <details
              className="fold-panel fold-panel-inline"
              open={activeEditorDetailsOpen}
              onToggle={(event) => setActiveEditorDetailsOpen((event.currentTarget as HTMLDetailsElement).open)}
            >
              <summary className="fold-summary">
                <div>
                  <strong>Contexte injecte au modele</strong>
                  <p className="muted">
                    {activeEditorSummary}
                    {activeEditorContext.selection ? ' | selection presente' : ''}
                  </p>
                </div>
                <span className="fold-chevron" aria-hidden="true">
                  ▾
                </span>
              </summary>

              <div className="fold-content">
                {activeEditorContext.selection ? (
                  <div className="active-editor-selection">
                    <strong>Selection</strong>
                    <p className="muted">
                      Lignes {activeEditorContext.selection.startLine}-{activeEditorContext.selection.endLine}, colonnes{' '}
                      {activeEditorContext.selection.startCharacter}-{activeEditorContext.selection.endCharacter}
                    </p>
                    <pre>{activeEditorContext.selection.text || '(selection vide)'}</pre>
                  </div>
                ) : null}

                <div className="active-editor-excerpt">
                  <strong>Extrait injecte</strong>
                  <p className="muted">
                    Lignes {activeEditorContext.excerptStartLine}-{activeEditorContext.excerptEndLine}
                  </p>
                  <pre>{activeEditorContext.excerpt}</pre>
                </div>
              </div>
            </details>
          </div>
        ) : (
          <p className="muted">
            Ouvre un fichier du workspace dans l editeur principal pour que l agent voie automatiquement le contexte courant.
          </p>
        )}
      </section>

      <details
        className="fold-panel"
        open={advancedPanelOpen}
        onToggle={(event) => setAdvancedPanelOpen((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className="fold-summary">
          <div>
            <strong>Reglages avances</strong>
            <p className="muted">{advancedSummary}</p>
          </div>
          <span className="fold-chevron" aria-hidden="true">
            ▾
          </span>
        </summary>

        <div className="fold-content">
          <section className="control-grid">
            <label className="field">
              <span>Fournisseur</span>
              <select
                value={selectedProfileId}
                onChange={(event) => handleProfileChange(event.target.value)}
                disabled={!session || session.profiles.length === 0 || session.isBusy}
              >
                {session?.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Mode</span>
              <select
                value={selectedMode}
                onChange={(event) => setSelectedMode(event.target.value as AppMode)}
                disabled={session?.isBusy}
              >
                <option value="chat">discussion</option>
                <option value="edit">edition - texte</option>
                <option value="run">execution - texte</option>
                <option value="agent">agent - modifie le workspace</option>
              </select>
              <p className="field-hint">Le mode agent pilote directement le workspace. Les autres modes restent textuels.</p>
            </label>

            <label className="field field-wide">
              <span>Modele</span>
              <input
                type="text"
                value={modelInput}
                onChange={(event) => setModelInput(event.target.value)}
                placeholder={activeProfile?.model ?? 'Choisir un modele'}
                disabled={session?.isBusy}
              />
            </label>

            <div className="field field-wide">
              <span>Temperature</span>
              <div className="temperature-row">
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={Number.isFinite(Number(temperatureInput)) ? Number(temperatureInput) : 1}
                  onChange={(event) => {
                    setTemperatureInput(event.target.value);
                    setIsTemperatureDirty(true);
                  }}
                  disabled={session?.isBusy}
                />
                <input
                  className="temperature-input"
                  type="number"
                  min={0}
                  max={2}
                  step={0.05}
                  value={temperatureInput}
                  onChange={(event) => {
                    setTemperatureInput(event.target.value);
                    setIsTemperatureDirty(true);
                  }}
                  disabled={session?.isBusy}
                />
              </div>
              <p className="field-hint">0 = deterministe, 2 = creatif. Valeur appliquee au prochain run.</p>
            </div>

            <label className="field field-wide">
              <span>System prompt (optionnel)</span>
              <textarea
                rows={4}
                value={systemPromptInput}
                onChange={(event) => {
                  setSystemPromptInput(event.target.value);
                  setIsSystemPromptDirty(true);
                }}
                placeholder="Ajoute des instructions de haut niveau appliquees a toutes les discussions."
                disabled={session?.isBusy}
              />
            </label>

            <div className="field field-wide">
              <span>Approbations</span>
              <div className="approval-toggles">
                <label className="toggle-chip">
                  <input
                    type="checkbox"
                    checked={autoApproveWorkspaceEdits}
                    onChange={(event) => setAutoApproveWorkspaceEdits(event.target.checked)}
                    disabled={session?.isBusy}
                  />
                  <span>Fichiers auto-approuves</span>
                </label>

                <label className="toggle-chip">
                  <input
                    type="checkbox"
                    checked={autoApproveTerminal}
                    onChange={(event) => setAutoApproveTerminal(event.target.checked)}
                    disabled={session?.isBusy}
                  />
                  <span>Terminal auto-approuve</span>
                </label>
              </div>
            </div>

            <div className="field field-wide control-actions">
              <button type="button" className="secondary action-button" onClick={handleSaveSelection} disabled={!canSaveSelection}>
                Sauvegarder
              </button>
            </div>
          </section>

          <section className="provider-card">
            <div>
              <strong>{activeProfile?.label ?? 'Aucun profil selectionne'}</strong>
              <p>
                {activeProfile?.providerType ?? 'n/a'}
                {activeProfile?.isLocal ? ' | local' : ' | cloud'}
              </p>
            </div>
            <div className="provider-actions">
              {activeProfile?.providerType === 'ollama' ? (
                <button type="button" className="secondary action-button" onClick={handleStartOllama}>
                  Demarrer Ollama
                </button>
              ) : null}
              <div className={`secret-state ${activeProfile?.hasApiKey === false && !activeProfile?.isLocal ? 'missing' : ''}`}>
                {activeProfile?.isLocal ? 'Aucune cle requise' : activeProfile?.hasApiKey ? 'Cle API configuree' : 'Cle API manquante'}
              </div>
            </div>
          </section>

          <section className="workspace-roots">
            <p className="section-label">Racines du workspace</p>
            {session?.workspaceFolders.length ? (
              <div className="root-list">
                {session.workspaceFolders.map((folder) => (
                  <button
                    key={folder}
                    type="button"
                    className="root-pill"
                    onClick={() => setCommandCwd(folder)}
                  >
                    {folder}
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted">Ouvre un dossier dans VS Code pour activer le terminal et les actions agent.</p>
            )}
          </section>

          <section className="gpu-guard-card">
            <div className="panel-head">
              <div>
                <strong>Surveillance GPU</strong>
                <p className="muted">
                  {formatGpuGuardStatus(session?.gpuGuard.status)} | fournisseur {formatGpuProvider(session?.gpuGuard.provider)} |
                  {' '}action {formatGpuAction(session?.gpuGuard.policy.action)}
                </p>
              </div>
              <div className={`status-pill ${session?.gpuGuard.limitExceeded ? 'busy' : ''}`}>
                {session?.gpuGuard.limitExceeded ? 'Seuil depasse' : 'Dans les limites'}
              </div>
            </div>

            <form className="gpu-guard-form" onSubmit={handleGpuGuardSave}>
              <label className="field checkbox-field">
                <span>Active</span>
                <input type="checkbox" checked={gpuGuardEnabled} onChange={(event) => setGpuGuardEnabled(event.target.checked)} />
              </label>

              <label className="field">
                <span>Fournisseur</span>
                <select value={gpuProvider} onChange={(event) => setGpuProvider(event.target.value as GpuGuardProvider)}>
                  <option value="off">desactive</option>
                  <option value="auto">auto</option>
                  <option value="nvidia-smi">nvidia-smi</option>
                </select>
              </label>

              <label className="field">
                <span>Action</span>
                <select value={gpuAction} onChange={(event) => setGpuAction(event.target.value as GpuGuardAction)}>
                  <option value="warn">avertir</option>
                  <option value="pause">pause</option>
                  <option value="stop">arreter</option>
                </select>
              </label>

              <label className="field">
                <span>Temp. max C</span>
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={gpuMaxTemperature}
                  onChange={(event) => setGpuMaxTemperature(event.target.value)}
                  placeholder="80"
                />
              </label>

              <label className="field">
                <span>GPU max %</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={gpuMaxUtilization}
                  onChange={(event) => setGpuMaxUtilization(event.target.value)}
                  placeholder="90"
                />
              </label>

              <label className="field">
                <span>Intervalle ms</span>
                <input
                  type="number"
                  min={1000}
                  value={gpuPollInterval}
                  onChange={(event) => setGpuPollInterval(event.target.value)}
                  placeholder="5000"
                />
              </label>

              <div className="composer-actions">
                <button type="submit" className="primary">
                  Enregistrer la surveillance GPU
                </button>
              </div>
            </form>

            <div className="gpu-guard-meta">
              <p>
                Limites : temp. {session?.gpuGuard.policy.maxTemperatureC ?? 'off'} C | usage{' '}
                {session?.gpuGuard.policy.maxUtilizationPercent ?? 'off'}%
              </p>
              {session?.gpuGuard.updatedAt ? <p className="muted">Mise a jour : {session.gpuGuard.updatedAt}</p> : null}
              {session?.gpuGuard.reasons.length ? <p className="gpu-warning">{session.gpuGuard.reasons.join(' | ')}</p> : null}
              {session?.gpuGuard.error ? <p className="gpu-warning">{session.gpuGuard.error}</p> : null}
            </div>

            <div className="gpu-device-list">
              {session?.gpuGuard.devices.length ? (
                session.gpuGuard.devices.map((device) => (
                  <article key={device.name} className="gpu-device">
                    <strong>{device.name}</strong>
                    <p>
                      Temp. : {device.temperatureC ?? 'n/a'} C | Usage : {device.utilizationPercent ?? 'n/a'}%
                    </p>
                  </article>
                ))
              ) : (
                <p className="muted">
                  Aucune telemetrie GPU en direct pour l'instant. Active la surveillance pour relever les metriques locales.
                </p>
              )}
            </div>
          </section>
        </div>
      </details>

      {errorText ? <div className="error-banner">{errorText}</div> : null}

      {currentAgentRun ? (
        <section className="agent-box">
          <div className="panel-head">
            <div>
              <strong>Execution agent</strong>
              <p className="muted">
                {formatAgentStatus(currentAgentRun.status)} | iteration {currentAgentRun.iteration}/{currentAgentRun.maxIterations} | outils{' '}
                {currentAgentRun.toolCallsUsed}/{currentAgentRun.maxToolCalls}
              </p>
            </div>
            <div className="composer-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => handleAgentControl('ui.agent.pause')}
                disabled={currentAgentRun.status !== 'running'}
              >
                Pause
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => handleAgentControl('ui.agent.resume')}
                disabled={currentAgentRun.status !== 'paused'}
              >
                Reprendre
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => handleAgentControl('ui.agent.stop')}
                disabled={currentAgentRun.status === 'completed' || currentAgentRun.status === 'failed' || currentAgentRun.status === 'cancelled'}
              >
                Arreter
              </button>
            </div>
          </div>
          <p className="muted">Budget temps : {currentAgentRun.timeBudgetMs} ms</p>
          {currentAgentRun.summary ? <p>{currentAgentRun.summary}</p> : null}
          {currentAgentRun.lastAssistantText ? <pre>{currentAgentRun.lastAssistantText}</pre> : null}
          {pendingAgentToolApproval ? (
            <div className="approval-box agent-approval">
              <strong>Approbation agent requise</strong>
              <p className="muted">{pendingAgentToolApproval.toolName}</p>
              {pendingAgentToolApproval.patchProposal ? (
                <>
                  <p>{pendingAgentToolApproval.patchProposal.workspacePath}</p>
                  <div className="diff-view compact">
                    {pendingAgentToolApproval.patchProposal.diffLines.map((line, index) => (
                      <div key={`${line.kind}-${index}`} className={`diff-line ${line.kind}`}>
                        <span className="line-no">{line.lineNumberBefore ?? ''}</span>
                        <span className="line-no">{line.lineNumberAfter ?? ''}</span>
                        <code>
                          {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
                          {line.text}
                        </code>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
              {pendingAgentToolApproval.commandApproval ? (
                <>
                  <p>{pendingAgentToolApproval.commandApproval.command}</p>
                  <p className="muted">{pendingAgentToolApproval.commandApproval.cwd}</p>
                </>
              ) : null}
              <div className="composer-actions">
                <button type="button" className="secondary" onClick={() => handleAgentToolApproval('rejected')}>
                  Refuser
                </button>
                <button type="button" className="primary" onClick={() => handleAgentToolApproval('approved')}>
                  Approuver
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {queuedPrompts.length ? (
        <section className="queue-box">
          <div className="panel-head">
            <div>
              <strong>File d'attente</strong>
              <p className="muted">{formatQueuedPromptCount(queuedPrompts.length)}</p>
            </div>
          </div>
          <div className="queued-prompt-list">
            {queuedPrompts.map((prompt, index) => (
              <article key={prompt.id} className="queued-prompt">
                <div className="bubble-meta">
                  <span>#{index + 1}</span>
                  <span>{formatModeLabel(prompt.mode)}</span>
                </div>
                <p>{prompt.textPreview}</p>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <details
        className="fold-panel fold-panel-secondary"
        open={workspaceToolsOpen}
        onToggle={(event) => setWorkspaceToolsOpen((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className="fold-summary">
          <div>
            <strong>Outils et historique</strong>
            <p className="muted">{toolsSummary}</p>
          </div>
          <span className="fold-chevron" aria-hidden="true">
            ▾
          </span>
        </summary>

        <div className="fold-content">
          <section className="tool-grid">
            <section className="panel panel-terminal">
              <div className="panel-head">
                <h2>Terminal et tests</h2>
                {runningCommand ? (
                  <button type="button" className="mini-button danger" onClick={() => handleStopCommand(runningCommand.runId)}>
                    Arreter l'execution
                  </button>
                ) : null}
              </div>

              <div className="preset-row">
                {COMMAND_PRESETS.map((preset) => (
                  <button
                    key={preset.command}
                    type="button"
                    className="root-pill"
                    onClick={() => handleCommandPreset(preset.command)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              <form className="terminal-form" onSubmit={handleCommandSubmit}>
                <input
                  type="text"
                  value={commandInput}
                  onChange={(event) => setCommandInput(event.target.value)}
                  placeholder="Commande a executer, par exemple npm test"
                />
                <input
                  type="text"
                  value={commandCwd}
                  onChange={(event) => setCommandCwd(event.target.value)}
                  placeholder="Dossier de travail dans le workspace"
                />
                <div className="composer-actions">
                  <button type="submit" className="primary">
                    Lancer la commande
                  </button>
                </div>
              </form>

              <div className="policy-box">
                <strong>Politique</strong>
                <p>Auto-approbation fichiers : {session?.terminalPolicy.autoApproveWorkspaceEdits ? 'activee' : 'desactivee'}</p>
                <p>Auto-approbation terminal : {session?.terminalPolicy.autoApproveTerminal ? 'activee' : 'desactivee'}</p>
                <p>Liste autorisee : {(session?.terminalPolicy.commandAllowList ?? []).join(', ') || 'aucune'}</p>
              </div>

              {session?.pendingCommandApproval ? (
                <div className="approval-box">
                  <strong>Approbation requise</strong>
                  <p>{session.pendingCommandApproval.command}</p>
                  <p className="muted">{session.pendingCommandApproval.cwd}</p>
                  <div className="composer-actions">
                    <button type="button" className="secondary" onClick={() => handleCommandApproval('rejected')}>
                      Refuser
                    </button>
                    <button type="button" className="primary" onClick={() => handleCommandApproval('approved')}>
                      Approuver
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="terminal-history">
                {session?.commandHistory.length ? (
                  session.commandHistory.map((entry) => (
                    <article key={entry.runId} className={`terminal-run ${entry.status}`}>
                      <div className="panel-head">
                        <div>
                          <strong>{entry.label ?? entry.command}</strong>
                          <p className="muted">
                            {entry.cwd} | {formatCommandStatus(entry.status)}
                            {entry.exitCode !== undefined ? ` | code ${String(entry.exitCode)}` : ''}
                          </p>
                        </div>
                        {entry.status === 'running' ? (
                          <button type="button" className="mini-button danger" onClick={() => handleStopCommand(entry.runId)}>
                            Arreter
                          </button>
                        ) : null}
                      </div>
                      <div className="terminal-output">
                        <div>
                          <span className="section-label">stdout</span>
                          <pre>{entry.stdout || '(vide)'}</pre>
                        </div>
                        <div>
                          <span className="section-label">stderr</span>
                          <pre>{entry.stderr || '(vide)'}</pre>
                        </div>
                      </div>
                    </article>
                  ))
                ) : (
                  <p className="muted">Lance ici les tests, le lint ou le build. Les sorties sont capturees et gardees dans l'historique.</p>
                )}
              </div>
            </section>
          </section>

          {session ? (
            <section className="memory-box">
              <div className="panel-head">
                <div>
                  <strong>Memoire et historique</strong>
                  <p className="muted">
                    Le profil projet et les taches terminees sont sauvegardes puis reinjectes dans les prochains runs.
                  </p>
                </div>
              </div>
              {session.projectMemory ? (
                <article className="history-card project-memory-card">
                  <div className="panel-head">
                    <div>
                      <strong>{session.projectMemory.displayName}</strong>
                      <p className="muted">
                        Profil projet | {session.projectMemory.workspaceFolders.join(', ') || 'workspace courant'} |{' '}
                        {formatTimestamp(session.projectMemory.updatedAt)}
                      </p>
                    </div>
                    <span className="section-label">projet</span>
                  </div>
                  {session.projectMemory.description ? (
                    <p className="history-summary">{session.projectMemory.description}</p>
                  ) : null}
                  {session.projectMemory.techStack.length ? (
                    <div className="meta-chip-row">
                      {session.projectMemory.techStack.slice(0, 8).map((item) => (
                        <span key={item} className="meta-chip">
                          {item}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {session.projectMemory.packageScripts.length ? (
                    <p className="muted">Scripts: {session.projectMemory.packageScripts.slice(0, 10).join(', ')}</p>
                  ) : null}
                  {session.projectMemory.importantFiles.length ? (
                    <p className="muted">Reperes: {session.projectMemory.importantFiles.slice(0, 10).join(', ')}</p>
                  ) : null}
                </article>
              ) : (
                <p className="muted">Aucun profil projet detecte pour ce workspace.</p>
              )}
              <div className="memory-list">
                {session.taskHistory.length ? (
                  session.taskHistory.slice(0, 12).map((entry) => (
                    <article key={entry.id} className={`history-card ${entry.status}`}>
                      <div className="panel-head">
                        <div>
                          <strong>{entry.userText}</strong>
                          <p className="muted">
                            {formatModeLabel(entry.mode)} | {formatTaskHistoryStatus(entry.status)} | {formatTimestamp(entry.updatedAt)}
                          </p>
                        </div>
                        {entry.profileLabel ? <span className="section-label">{entry.profileLabel}</span> : null}
                      </div>
                      <p className="history-summary">{entry.summary || 'Tache en cours.'}</p>
                    </article>
                  ))
                ) : (
                  <p className="muted">La memoire va se remplir a partir des prochaines demandes et restera disponible apres redemarrage.</p>
                )}
              </div>
            </section>
          ) : null}
        </div>
      </details>

      <main className="transcript">
        {session?.messages.length ? (
          session.messages.map((message) => (
            <article key={message.id} className={`bubble ${message.role} ${message.status}`}>
              <div className="bubble-meta">
                <span>{message.role === 'user' ? 'Toi' : message.profileLabel ?? 'Assistant'}</span>
                {message.model ? <span>{message.model}</span> : null}
              </div>
              <pre>{message.content || (message.status === 'streaming' ? '...' : '')}</pre>
            </article>
          ))
        ) : (
          <div className="empty-state">
            <h2>Decris ce que tu veux changer</h2>
            <p>Le fichier actif peut etre injecte automatiquement et le mode agent applique ensuite les modifications dans le workspace.</p>
          </div>
        )}
      </main>

      <form className="composer" onSubmit={handleSubmit}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={getComposerPlaceholder(selectedMode)}
          rows={5}
          disabled={!session}
        />
        <div className="composer-actions">
          <button type="button" className="secondary" onClick={handleStopChat} disabled={!session?.isBusy}>
            Arreter
          </button>
          <button type="submit" className="primary" disabled={!canSubmit}>
            Envoyer
          </button>
        </div>
      </form>
    </div>
  );
}

type SessionStatePayload = Extract<HostMessage, { type: 'host.session.state' }>['payload'];

type AssistantActivityTone = 'idle' | 'running' | 'success' | 'warning' | 'error';

type AssistantActivity = {
  tone: AssistantActivityTone;
  label: string;
  detail: string;
};

function createMessage<TType extends UiMessage['type']>(
  type: TType,
  payload: Extract<UiMessage, { type: TType }>['payload']
): UiMessage {
  return {
    type,
    payload,
    requestId: `ui-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: new Date().toISOString()
  } as UiMessage;
}

function parseOptionalNumber(value: string): number | undefined {
  if (!value.trim()) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asInputValue(value: number | undefined): string {
  return typeof value === 'number' ? String(value) : '';
}

function formatRunStatus(status: string): string {
  switch (status) {
    case 'running':
      return 'en cours';
    case 'completed':
      return 'termine';
    case 'failed':
      return 'echoue';
    case 'cancelled':
      return 'annule';
    default:
      return status;
  }
}

function formatStopReason(reason: string): string {
  switch (reason) {
    case 'completed':
      return 'termine';
    case 'cancelled_by_user':
      return 'arrete par l utilisateur';
    case 'provider_error':
      return 'erreur du fournisseur';
    default:
      return reason;
  }
}

function formatCommandStatus(status: CommandRunRecord['status']): string {
  switch (status) {
    case 'running':
      return 'en cours';
    case 'completed':
      return 'terminee';
    case 'failed':
      return 'echouee';
    case 'cancelled':
      return 'annulee';
    case 'rejected':
      return 'refusee';
    default:
      return status;
  }
}

function formatTaskHistoryStatus(status: SessionStatePayload['taskHistory'][number]['status']): string {
  switch (status) {
    case 'completed':
      return 'terminee';
    case 'failed':
      return 'echouee';
    case 'cancelled':
      return 'annulee';
    default:
      return 'en cours';
  }
}

function formatAgentStatus(status: string): string {
  switch (status) {
    case 'running':
      return 'en cours';
    case 'paused':
      return 'en pause';
    case 'waiting_for_user':
      return 'en attente';
    case 'completed':
      return 'termine';
    case 'failed':
      return 'echoue';
    case 'cancelled':
      return 'annule';
    default:
      return status;
  }
}

function formatGpuGuardStatus(status: string | undefined): string {
  switch (status) {
    case 'healthy':
      return 'ok';
    case 'throttled':
      return 'limite';
    case 'unsupported':
      return 'non pris en charge';
    case 'disabled':
      return 'desactivee';
    case 'error':
      return 'erreur';
    default:
      return status ?? 'desactivee';
  }
}

function formatGpuProvider(provider: string | undefined): string {
  switch (provider) {
    case 'off':
      return 'desactive';
    default:
      return provider ?? 'desactive';
  }
}

function formatGpuAction(action: string | undefined): string {
  switch (action) {
    case 'warn':
      return 'avertir';
    case 'pause':
      return 'pause';
    case 'stop':
      return 'arreter';
    default:
      return action ?? 'pause';
  }
}

function formatQueuedPromptCount(count: number): string {
  return `${count} prompt${count > 1 ? 's' : ''} en attente`;
}

function formatWorkspaceToolsSummary(
  commandCount: number,
  taskHistoryCount: number,
  hasProjectMemory: boolean,
  hasPendingCommandApproval: boolean,
  hasRunningCommand: boolean
): string {
  const fragments: string[] = [];

  if (hasProjectMemory) {
    fragments.push('profil projet');
  }

  if (hasPendingCommandApproval) {
    fragments.push('approbation terminal en attente');
  }

  if (hasRunningCommand) {
    fragments.push('commande en cours');
  }

  if (commandCount > 0) {
    fragments.push(`${commandCount} commande${commandCount > 1 ? 's' : ''}`);
  }

  if (taskHistoryCount > 0) {
    fragments.push(`${taskHistoryCount} tache${taskHistoryCount > 1 ? 's' : ''} memorisee${taskHistoryCount > 1 ? 's' : ''}`);
  }

  if (fragments.length === 0) {
    return 'terminal, tests et historique repliables';
  }

  return fragments.join(' | ');
}

function formatModeLabel(mode: AppMode): string {
  switch (mode) {
    case 'chat':
      return 'discussion';
    case 'edit':
      return 'edition';
    case 'run':
      return 'execution';
    case 'agent':
      return 'agent';
    default:
      return mode;
  }
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('fr-FR');
}

function updateAssistantStream(
  current: SessionStatePayload | null,
  runId: string,
  textDelta: string
) {
  if (!current) {
    return current;
  }

  const messages = [...current.messages];
  const index = [...messages]
    .reverse()
    .findIndex((entry) => entry.role === 'assistant' && entry.runId === runId);

  if (index === -1) {
    return current;
  }

  const actualIndex = messages.length - 1 - index;
  const target = messages[actualIndex];
  messages[actualIndex] = {
    ...target,
    content: target.content + textDelta
  };

  return {
    ...current,
    messages
  };
}

function upsertCommandRecord(
  current: SessionStatePayload | null,
  record: CommandRunRecord,
  clearApproval = false
) {
  if (!current) {
    return current;
  }

  const commandHistory = [...current.commandHistory];
  const index = commandHistory.findIndex((entry) => entry.runId === record.runId);
  if (index === -1) {
    commandHistory.unshift(record);
  } else {
    commandHistory[index] = record;
  }

  return {
    ...current,
    commandHistory,
    pendingCommandApproval: clearApproval ? undefined : current.pendingCommandApproval
  };
}

function appendCommandStream(
  current: SessionStatePayload | null,
  runId: string,
  stream: 'stdout' | 'stderr',
  textDelta: string
) {
  if (!current) {
    return current;
  }

  const commandHistory = current.commandHistory.map((entry) =>
    entry.runId === runId
      ? {
          ...entry,
          [stream]: `${entry[stream]}${textDelta}`
        }
      : entry
  );

  return {
    ...current,
    commandHistory
  };
}

function deriveAssistantActivityFromSession(
  session: SessionStatePayload,
  current: AssistantActivity
): AssistantActivity {
  if (session.currentAgentRun) {
    return createAssistantActivityFromAgentRun(session.currentAgentRun);
  }

  if (session.isBusy) {
    return {
      tone: 'running',
      label: 'IA en cours',
      detail: 'Generation de la reponse'
    };
  }

  const lastAssistantMessage = [...session.messages].reverse().find((message) => message.role === 'assistant');
  if (lastAssistantMessage?.status === 'error') {
    return {
      tone: 'error',
      label: 'IA en erreur',
      detail: 'La derniere execution a echoue'
    };
  }

  if (lastAssistantMessage?.status === 'complete') {
    if (current.tone === 'idle' || current.tone === 'running') {
      return {
        tone: 'success',
        label: 'IA terminee',
        detail: 'La derniere reponse est disponible'
      };
    }

    return current;
  }

  return current;
}

function createAssistantActivityFromRunStatus(
  status: 'running' | 'completed' | 'failed' | 'cancelled',
  stopReason?: string
): AssistantActivity {
  switch (status) {
    case 'running':
      return {
        tone: 'running',
        label: 'IA en cours',
        detail: 'Generation de la reponse'
      };
    case 'completed':
      return {
        tone: 'success',
        label: 'IA terminee',
        detail: 'La reponse est complete'
      };
    case 'failed':
      return {
        tone: 'error',
        label: 'IA en erreur',
        detail: stopReason ? formatStopReason(stopReason) : 'Erreur du fournisseur'
      };
    case 'cancelled':
      return {
        tone: 'warning',
        label: 'IA arretee',
        detail: stopReason ? formatStopReason(stopReason) : 'Execution interrompue'
      };
    default:
      return DEFAULT_ASSISTANT_ACTIVITY;
  }
}

function createAssistantActivityFromAgentRun(run: SessionStatePayload['currentAgentRun']): AssistantActivity {
  if (!run) {
    return DEFAULT_ASSISTANT_ACTIVITY;
  }

  switch (run.status) {
    case 'running':
      return {
        tone: 'running',
        label: 'IA en cours',
        detail: `Iteration ${run.iteration + 1} sur ${run.maxIterations}`
      };
    case 'paused':
      return {
        tone: 'warning',
        label: 'IA en pause',
        detail: 'Execution mise en pause'
      };
    case 'waiting_for_user':
      return {
        tone: 'warning',
        label: 'IA en attente',
        detail: 'Une approbation utilisateur est requise'
      };
    case 'completed':
      return {
        tone: 'success',
        label: 'IA terminee',
        detail: run.summary?.trim() || 'Le travail est termine'
      };
    case 'failed':
      return {
        tone: 'error',
        label: 'IA en erreur',
        detail: run.stopReason?.trim() || 'L execution agent a echoue'
      };
    case 'cancelled':
      return {
        tone: 'warning',
        label: 'IA arretee',
        detail: run.stopReason?.trim() || 'Execution interrompue'
      };
    default:
      return DEFAULT_ASSISTANT_ACTIVITY;
  }
}

function getComposerPlaceholder(mode: AppMode): string {
  switch (mode) {
    case 'agent':
      return 'Decris le changement souhaite. Le fichier actif et son extrait seront injectes automatiquement.';
    case 'edit':
    case 'run':
      return 'Ce mode reste textuel pour l instant. Utilise le mode agent si tu veux modifier des fichiers.';
    default:
      return "Demande au modele d'analyser du code, d'expliquer un fichier ou de preparer la suite.";
  }
}
