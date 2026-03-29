import { pathToFileURL } from 'node:url';

import { createBridgeApp } from './app.ts';
import { createLocalDevLarkTransport, resolveBridgeConfig } from './runtime/bootstrap.ts';

export async function run(): Promise<void> {
  const config = resolveBridgeConfig();
  const transport = createLocalDevLarkTransport({
    onSend(message) {
      console.log(`[codex-bridge] outbound -> ${message.sessionId}: ${message.text}`);
    },
  });

  const app = createBridgeApp({
    config,
    larkTransport: transport,
  });

  await app.start();

  let keepAlive: NodeJS.Timeout | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      const server = app.apiServer;
      server.once('error', reject);
      server.listen(config.server.port, config.server.host, () => {
        console.log(
          `[codex-bridge] listening on http://${config.server.host}:${config.server.port} (storage: ${config.storage.path})`,
        );
        resolve();
      });
    });
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
    if (code !== 'EPERM' && code !== 'EACCES') {
      throw error;
    }

    console.warn('[codex-bridge] HTTP listen is unavailable in this environment, continuing in dry-run mode');
    keepAlive = setInterval(() => {}, 60_000);
    console.log(
      `[codex-bridge] dry-run active (storage: ${config.storage.path}); set BRIDGE_PORT/BRIDGE_HOST in a normal environment to enable HTTP`,
    );
  }

  const shutdown = async () => {
    if (keepAlive !== null) {
      clearInterval(keepAlive);
      keepAlive = null;
    }
    await app.stop();
    await new Promise<void>((resolve) => {
      app.apiServer.close(() => resolve());
    });
  };

  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run().catch((error) => {
    console.error('[codex-bridge] fatal startup error');
    console.error(error);
    process.exitCode = 1;
  });
}
