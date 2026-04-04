import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

import { loadProjectsFromFile, type ProjectConfigEntry } from './codex-config.ts';

export interface ProjectConfigWatcherOptions {
  filePath: string;
  onProjectsChanged?: (projects: ProjectConfigEntry[]) => void | Promise<void>;
  readProjects?: () => Promise<ProjectConfigEntry[] | null> | ProjectConfigEntry[] | null;
}

export interface ProjectConfigWatcher {
  getProjects(): ProjectConfigEntry[];
  reload(): Promise<ProjectConfigEntry[]>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

function cloneProjects(projects: ProjectConfigEntry[]): ProjectConfigEntry[] {
  return projects.map((entry) => ({ ...entry }));
}

function equalProjects(left: ProjectConfigEntry[], right: ProjectConfigEntry[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((entry, index) => JSON.stringify(entry) === JSON.stringify(right[index]));
}

export function createProjectConfigWatcher(options: ProjectConfigWatcherOptions): ProjectConfigWatcher {
  let currentProjects: ProjectConfigEntry[] = [];
  let fileWatcher: FSWatcher | null = null;
  let reloadQueue: Promise<unknown> = Promise.resolve();

  async function publish(nextProjects: ProjectConfigEntry[]): Promise<ProjectConfigEntry[]> {
    if (equalProjects(currentProjects, nextProjects)) {
      return cloneProjects(currentProjects);
    }

    currentProjects = cloneProjects(nextProjects);
    await options.onProjectsChanged?.(cloneProjects(currentProjects));
    return cloneProjects(currentProjects);
  }

  async function reload(): Promise<ProjectConfigEntry[]> {
    const next = reloadQueue.then(async () => {
      const loadedProjects = options.readProjects
        ? await options.readProjects()
        : loadProjectsFromFile(options.filePath);

      if (loadedProjects === null) {
        return cloneProjects(currentProjects);
      }

      return await publish(loadedProjects);
    });

    reloadQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function start(): Promise<void> {
    if (fileWatcher !== null) {
      return;
    }

    const directory = path.dirname(options.filePath);
    const filename = path.basename(options.filePath);

    fileWatcher = watch(directory, { persistent: false }, (_eventType, changedFilename) => {
      if (changedFilename !== undefined && changedFilename !== filename) {
        return;
      }

      void reload();
    });
  }

  async function stop(): Promise<void> {
    fileWatcher?.close();
    fileWatcher = null;
    await reloadQueue;
  }

  return {
    getProjects() {
      return cloneProjects(currentProjects);
    },
    reload,
    start,
    stop,
  };
}
