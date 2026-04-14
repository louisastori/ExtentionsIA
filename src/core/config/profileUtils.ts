import type { ProviderProfile } from '../types';

export function isLocalProfile(profile: ProviderProfile): boolean {
  if (profile.providerType === 'ollama') {
    return true;
  }

  if (profile.providerType !== 'openai-compatible') {
    return false;
  }

  if (!profile.baseUrl) {
    return true;
  }

  try {
    const parsedUrl = new URL(profile.baseUrl);
    const hostname = parsedUrl.hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}
