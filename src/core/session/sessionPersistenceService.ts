import * as vscode from 'vscode';
import type { CommandRunRecord, PersistedSessionState, TaskHistoryEntry, TranscriptMessage } from '../types';

const STORAGE_KEY = 'esctentionialocal.session.v1';

export class SessionPersistenceService {
  public constructor(private readonly storage: vscode.Memento) {}

  public load(): PersistedSessionState | undefined {
    const value = this.storage.get<unknown>(STORAGE_KEY);
    if (!isPersistedSessionState(value)) {
      return undefined;
    }

    return value;
  }

  public async save(state: PersistedSessionState): Promise<void> {
    await this.storage.update(STORAGE_KEY, state);
  }
}

function isPersistedSessionState(value: unknown): value is PersistedSessionState {
  if (!isObject(value)) {
    return false;
  }

  return (
    value.version === 1 &&
    typeof value.sessionId === 'string' &&
    isAppMode(value.mode) &&
    typeof value.activeProfileId === 'string' &&
    typeof value.selectedModel === 'string' &&
    Array.isArray(value.messages) &&
    value.messages.every(isTranscriptMessage) &&
    Array.isArray(value.commandHistory) &&
    value.commandHistory.every(isCommandRunRecord) &&
    Array.isArray(value.taskHistory) &&
    value.taskHistory.every(isTaskHistoryEntry)
  );
}

function isTranscriptMessage(value: unknown): value is TranscriptMessage {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.content === 'string' &&
    typeof value.createdAt === 'string' &&
    (value.runId === undefined || typeof value.runId === 'string') &&
    (value.profileId === undefined || typeof value.profileId === 'string') &&
    (value.profileLabel === undefined || typeof value.profileLabel === 'string') &&
    (value.model === undefined || typeof value.model === 'string') &&
    (value.status === 'complete' || value.status === 'streaming' || value.status === 'error')
  );
}

function isCommandRunRecord(value: unknown): value is CommandRunRecord {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.runId === 'string' &&
    typeof value.command === 'string' &&
    typeof value.cwd === 'string' &&
    (value.label === undefined || typeof value.label === 'string') &&
    (value.status === 'pending_approval' ||
      value.status === 'running' ||
      value.status === 'completed' ||
      value.status === 'failed' ||
      value.status === 'cancelled' ||
      value.status === 'rejected') &&
    typeof value.startedAt === 'string' &&
    (value.endedAt === undefined || typeof value.endedAt === 'string') &&
    (value.exitCode === undefined || value.exitCode === null || typeof value.exitCode === 'number') &&
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string'
  );
}

function isTaskHistoryEntry(value: unknown): value is TaskHistoryEntry {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.runId === 'string' &&
    isAppMode(value.mode) &&
    typeof value.userText === 'string' &&
    typeof value.summary === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    (value.profileId === undefined || typeof value.profileId === 'string') &&
    (value.profileLabel === undefined || typeof value.profileLabel === 'string') &&
    (value.model === undefined || typeof value.model === 'string') &&
    (value.status === 'running' ||
      value.status === 'completed' ||
      value.status === 'failed' ||
      value.status === 'cancelled')
  );
}

function isAppMode(value: unknown): value is PersistedSessionState['mode'] {
  return value === 'chat' || value === 'edit' || value === 'run' || value === 'agent';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}
