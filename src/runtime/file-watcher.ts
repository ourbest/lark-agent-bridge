import chokidar from 'chokidar';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface FileWatcherConfig {
  enabled: boolean;
  watchDir: string;
  openId: string;
  pollIntervalMs: number;
  maxWaitMs: number;
}

export interface FileWatcherDeps {
  sendFileFn: (opts: { receiveId: string; filePath: string }) => Promise<void>;
}

export class FileWatcherService {
  private watcher: chokidar.FSWatcher | null = null;
  private processingFiles = new Set<string>();
  private config: FileWatcherConfig;
  private deps: FileWatcherDeps;

  constructor(
    config: FileWatcherConfig,
    deps: FileWatcherDeps,
  ) {
    this.config = config;
    this.deps = deps;
  }

  start() {
    if (!this.config.enabled) {
      console.log('[file-watcher] disabled, skipping');
      return;
    }
    console.log(`[file-watcher] started watching: ${this.config.watchDir}`);
    this.watcher = chokidar.watch(this.config.watchDir, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: false, // we handle stability ourselves
    });
    this.watcher.on('add', (filePath) => this.handleFileAdd(filePath));
  }

  stop() {
    this.watcher?.close();
    this.watcher = null;
  }

  private async handleFileAdd(filePath: string) {
    const filename = path.basename(filePath);
    if (this.processingFiles.has(filePath)) return;
    this.processingFiles.add(filePath);
    console.log(`[file-watcher] file added: ${filename}`);

    try {
      const stable = await this.waitForStable(filePath);
      if (!stable) {
        console.warn(`[file-watcher] file timeout, skipped: ${filename}`);
        return;
      }
      console.log(`[file-watcher] file stable, sending: ${filename}`);
      await this.deps.sendFileFn({ receiveId: this.config.openId, filePath });
      await fs.unlink(filePath);
      console.log(`[file-watcher] sent successfully, deleted: ${filename}`);
    } catch (err) {
      console.error(`[file-watcher] send failed, will retry: ${filename}`, err);
    } finally {
      this.processingFiles.delete(filePath);
    }
  }

  private async waitForStable(filePath: string): Promise<boolean> {
    const { pollIntervalMs, maxWaitMs } = this.config;
    const start = Date.now();
    let prevSize = -1;
    while (Date.now() - start < maxWaitMs) {
      await sleep(pollIntervalMs);
      try {
        const stats = await fs.stat(filePath);
        if (stats.size === prevSize) return true;
        prevSize = stats.size;
      } catch {
        return false; // file deleted
      }
    }
    return false;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}