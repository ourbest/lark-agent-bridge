import { CodexAppServerClient, type CodexAppServerClientOptions, type CodexClientInfo } from './app-server-client.ts';

export interface SshStdioCodexClientOptions
  extends Omit<CodexAppServerClientOptions, 'command' | 'args' | 'transport' | 'websocketUrl'> {
  sshHost: string;
  sshPort?: number;
  sshUser?: string;
  sshIdentityFile?: string;
  sshCommand: string;
  sshArgs?: string[];
}

function buildSshArgs(input: SshStdioCodexClientOptions): string[] {
  const args = [
    ...(input.sshPort !== undefined ? ['-p', String(input.sshPort)] : []),
    ...(input.sshIdentityFile !== undefined ? ['-i', input.sshIdentityFile] : []),
  ];

  if (input.sshUser !== undefined && input.sshUser.trim() !== '') {
    args.push(`${input.sshUser}@${input.sshHost}`);
  } else {
    args.push(input.sshHost);
  }

  args.push(input.sshCommand, ...(input.sshArgs ?? []));
  return args;
}

export function createSshStdioCodexClient(input: SshStdioCodexClientOptions): CodexAppServerClient {
  return new CodexAppServerClient({
    ...input,
    command: 'ssh',
    args: buildSshArgs(input),
    transport: 'stdio',
  });
}

export type { CodexClientInfo };
