import type { AppShell, BridgeConfig } from './types/index.ts';

export function createApp(options: { config: BridgeConfig }): AppShell {
  return {
    name: 'lark-agent-bridge',
    ready: false,
    config: options.config,
  };
}

export { createBridgeApp } from './app.ts';
export type { BridgeRuntime } from './app.ts';
