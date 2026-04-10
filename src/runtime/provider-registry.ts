export type ProviderName = 'codex' | 'cc' | 'qwen' | 'gemini';
export type ProviderTransport = 'stdio' | 'websocket';

export const DEFAULT_PROVIDER_ORDER: ProviderName[] = ['codex', 'cc', 'qwen', 'gemini'];

export interface ProviderDescriptor {
  provider: ProviderName;
  transport: ProviderTransport;
  port?: number;
}

export interface ProviderState {
  provider: ProviderName;
  transport: ProviderTransport;
  active: boolean;
  started: boolean;
  port?: number;
}

export function isProviderName(value: string): value is ProviderName {
  return value === 'codex' || value === 'cc' || value === 'qwen' || value === 'gemini';
}

export function defaultProviderDescriptors(): ProviderDescriptor[] {
  return DEFAULT_PROVIDER_ORDER.map((provider) => ({ provider, transport: 'stdio' }));
}

export function providerToAdapterType(provider: ProviderName): 'codex' | 'claude-code' | 'qwen-code' | 'gemini-cli' {
  if (provider === 'codex') {
    return 'codex';
  }

  if (provider === 'cc') {
    return 'claude-code';
  }

  if (provider === 'gemini') {
    return 'gemini-cli';
  }

  return 'qwen-code';
}
