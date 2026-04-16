export type ProviderKind = 'codex' | 'cc' | 'qwen' | 'gemini';
export type ProviderTransport = 'stdio' | 'websocket' | 'ssh+stdio';

export const DEFAULT_PROVIDER_ORDER: ProviderKind[] = ['codex', 'cc', 'qwen', 'gemini'];

export interface ProviderDescriptor {
  id: string;
  kind: ProviderKind;
  transport: ProviderTransport;
  port?: number;
  websocketUrl?: string;
  remoteCwd?: string;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshIdentityFile?: string;
  sshCommand?: string;
  sshArgs?: string[];
}

export interface ProviderState {
  id: string;
  kind: ProviderKind;
  transport: ProviderTransport;
  active: boolean;
  started: boolean;
  port?: number;
}

export function isProviderKind(value: string): value is ProviderKind {
  return value === 'codex' || value === 'cc' || value === 'qwen' || value === 'gemini';
}

export function defaultProviderDescriptors(): ProviderDescriptor[] {
  return DEFAULT_PROVIDER_ORDER.map((kind) => ({ id: kind, kind, transport: 'stdio' }));
}

export function providerToAdapterType(kind: ProviderKind): 'codex' | 'claude-code' | 'qwen-code' | 'gemini-cli' {
  if (kind === 'codex') {
    return 'codex';
  }

  if (kind === 'cc') {
    return 'claude-code';
  }

  if (kind === 'gemini') {
    return 'gemini-cli';
  }

  return 'qwen-code';
}
