import type { AppMode, HostMessage, UiMessage } from './types';

interface VsCodeApi<State> {
  postMessage(message: UiMessage): void;
  getState(): State | undefined;
  setState(state: State): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: <State>() => VsCodeApi<State>;
  }
}

type StoredState = {
  sessionId?: string;
  selectedProfileId?: string;
  selectedMode?: AppMode;
  modelInput?: string;
  advancedPanelOpen?: boolean;
  workspaceToolsOpen?: boolean;
  activeEditorDetailsOpen?: boolean;
};

const fallbackApi: VsCodeApi<StoredState> = {
  postMessage(message) {
    console.debug('VS Code API unavailable, message:', message);
  },
  getState() {
    return undefined;
  },
  setState(state) {
    console.debug('VS Code state:', state);
  }
};

export const vscodeApi = window.acquireVsCodeApi?.<StoredState>() ?? fallbackApi;

export function postMessage(message: UiMessage): void {
  vscodeApi.postMessage(message);
}

export function isHostMessage(value: unknown): value is HostMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return typeof (value as { type?: string }).type === 'string';
}
