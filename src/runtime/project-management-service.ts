import { existsSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import type { ProjectConfigEntry } from './codex-config.ts';
import type { ProjectConfigWatcher } from './project-config-watcher.ts';
import { writeProjectsFile, parseProjectConfigEntries } from './codex-config.ts';

export interface ProjectManagementServiceDependencies {
  configWatcher: ProjectConfigWatcher;
  projectsFilePath: string;
  /**
   * 获取 projects.json 中的显式项目（不包括自动发现的项目）
   */
  getExplicitProjects?: () => ProjectConfigEntry[];
}

export interface ProjectManagementService {
  addLocalProject(input: { path: string; id?: string }): Promise<{ projectInstanceId: string; cwd: string }>;
  addRemoteProject(input: { gitRemote: string }): Promise<{ projectInstanceId: string; cwd: string }>;
}

function resolveAbsolutePath(inputPath: string, homeDir: string | undefined = process.env.HOME): string {
  if (inputPath.startsWith('~/')) {
    if (!homeDir) {
      throw new Error('HOME environment variable is not set');
    }
    return path.join(homeDir, inputPath.slice(2));
  }
  return path.resolve(inputPath);
}

function directoryNameFromPath(inputPath: string): string {
  return path.basename(inputPath);
}

async function cloneGitRepository(remote: string, targetDir: string): Promise<void> {
  const parentDir = path.dirname(targetDir);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  await execFileAsync('git', ['clone', remote, targetDir], {
    cwd: parentDir,
  });
}

function createProjectEntry(
  projectInstanceId: string,
  cwd: string,
): ProjectConfigEntry {
  return {
    projectInstanceId,
    cwd,
    providers: [],
  } as ProjectConfigEntry;
}

export function createProjectManagementService(
  dependencies: ProjectManagementServiceDependencies,
): ProjectManagementService {
  return {
    async addLocalProject(input: { path: string; id?: string }): Promise<{ projectInstanceId: string; cwd: string }> {
      const resolvedPath = resolveAbsolutePath(input.path);

      if (!existsSync(resolvedPath)) {
        throw new Error(`Path does not exist: ${resolvedPath}`);
      }

      const stat = statSync(resolvedPath);
      if (!stat.isDirectory()) {
        throw new Error(`Path is not a directory: ${resolvedPath}`);
      }

      const projectInstanceId = input.id?.trim() || directoryNameFromPath(resolvedPath);

      // 使用显式项目列表来检查重复，避免包含自动发现的项目
      const explicitProjects = dependencies.getExplicitProjects?.() ?? [];
      const existingProject = explicitProjects.find(
        (p) => p.projectInstanceId === projectInstanceId,
      );

      if (existingProject) {
        throw new Error(`Project "${projectInstanceId}" already exists`);
      }

      const newProject = createProjectEntry(projectInstanceId, resolvedPath);
      const updatedProjects = [...explicitProjects, newProject];

      writeProjectsFile(dependencies.projectsFilePath, updatedProjects);

      await dependencies.configWatcher.reload();

      return {
        projectInstanceId,
        cwd: resolvedPath,
      };
    },

    async addRemoteProject(input: { gitRemote: string }): Promise<{ projectInstanceId: string; cwd: string }> {
      const remoteUrl = input.gitRemote.trim();
      if (!remoteUrl) {
        throw new Error('Git remote URL is required');
      }

      const repoName = remoteUrl
        .replace(/^[^:]+:/, '')
        .replace(/\.git$/, '')
        .split('/')
        .pop();

      if (!repoName) {
        throw new Error('Could not determine repository name from remote URL');
      }

      const projectsRoot = process.env.BRIDGE_PROJECTS_ROOT;
      if (!projectsRoot) {
        throw new Error('BRIDGE_PROJECTS_ROOT environment variable is not set');
      }

      const resolvedRoot = resolveAbsolutePath(projectsRoot);
      const targetDir = path.join(resolvedRoot, repoName);
      const projectInstanceId = repoName;

      // 先检查重复项目 ID，在克隆之前
      const explicitProjects = dependencies.getExplicitProjects?.() ?? [];
      const existingProject = explicitProjects.find(
        (p) => p.projectInstanceId === projectInstanceId,
      );

      if (existingProject) {
        throw new Error(`Project "${projectInstanceId}" already exists`);
      }

      if (existsSync(targetDir)) {
        throw new Error(`Directory already exists: ${targetDir}`);
      }

      await cloneGitRepository(remoteUrl, targetDir);

      const newProject = createProjectEntry(projectInstanceId, targetDir);
      const updatedProjects = [...explicitProjects, newProject];

      writeProjectsFile(dependencies.projectsFilePath, updatedProjects);

      await dependencies.configWatcher.reload();

      return {
        projectInstanceId,
        cwd: targetDir,
      };
    },
  };
}
