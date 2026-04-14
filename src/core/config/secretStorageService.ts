import * as vscode from 'vscode';

export class SecretStorageService {
  public constructor(private readonly secrets: vscode.SecretStorage) {}

  public async getSecret(secretRef: string): Promise<string | undefined> {
    return this.secrets.get(secretRef);
  }

  public async hasSecret(secretRef: string): Promise<boolean> {
    return (await this.getSecret(secretRef)) !== undefined;
  }

  public async storeSecret(secretRef: string, value: string): Promise<void> {
    await this.secrets.store(secretRef, value);
  }
}
