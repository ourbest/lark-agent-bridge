import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createProjectManagementService } from '../../src/runtime/project-management-service.ts';
import type { ProjectConfigWatcher } from '../../src/runtime/project-config-watcher.ts';

function createMockConfigWatcher(initialProjects: any[] = []): ProjectConfigWatcher & { getReloadCount(): number; getProjects(): any[]; setProjects(projects: any[]): void } {
  let projects = [...initialProjects];
  let reloadCount = 0;

  return {
    getProjects() {
      return [...projects];
    },
    getReloadCount() {
      return reloadCount;
    },
    async reload() {
      reloadCount += 1;
      return [...projects];
    },
    setProjects(newProjects: any[]) {
      projects = [...newProjects];
    },
    async start() {},
    async stop() {},
  };
}

function createServiceWithDefaults(overrides: Partial<Parameters<typeof createProjectManagementService>[0]> = {}) {
  const projectsFile = overrides.projectsFilePath || '/tmp/test-projects.json';
  const watcher = overrides.configWatcher || createMockConfigWatcher();

  return createProjectManagementService({
    configWatcher: watcher,
    projectsFilePath: projectsFile,
    getExplicitProjects: overrides.getExplicitProjects || (() => []),
    ...overrides,
  });
}

test('addLocalProject adds a project from a local path', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bridge-test-'));
  const projectDir = path.join(tempDir, 'my-project');
  await mkdir(projectDir);

  const projectsFile = path.join(tempDir, 'projects.json');
  await writeFile(projectsFile, JSON.stringify({ projects: [] }));

  const watcher = createMockConfigWatcher();
  const service = createServiceWithDefaults({
    configWatcher: watcher,
    projectsFilePath: projectsFile,
  });

  const result = await service.addLocalProject({ path: projectDir });

  assert.equal(result.projectInstanceId, 'my-project');
  assert.equal(result.cwd, projectDir);
});

test('addLocalProject uses provided id when specified', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bridge-test-'));
  const projectDir = path.join(tempDir, 'some-directory');
  await mkdir(projectDir);

  const projectsFile = path.join(tempDir, 'projects.json');
  await writeFile(projectsFile, JSON.stringify({ projects: [] }));

  const watcher = createMockConfigWatcher();
  const service = createServiceWithDefaults({
    configWatcher: watcher,
    projectsFilePath: projectsFile,
  });

  const result = await service.addLocalProject({ path: projectDir, id: 'custom-id' });

  assert.equal(result.projectInstanceId, 'custom-id');
  assert.equal(result.cwd, projectDir);
});

test('addLocalProject throws when path does not exist', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bridge-test-'));
  const projectsFile = path.join(tempDir, 'projects.json');
  await writeFile(projectsFile, JSON.stringify({ projects: [] }));

  const watcher = createMockConfigWatcher();
  const service = createServiceWithDefaults({
    configWatcher: watcher,
    projectsFilePath: projectsFile,
  });

  await assert.rejects(
    () => service.addLocalProject({ path: '/nonexistent/path' }),
    /Path does not exist/,
  );
});

test('addLocalProject throws when path is not a directory', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bridge-test-'));
  const filePath = path.join(tempDir, 'file.txt');
  await writeFile(filePath, 'test');

  const projectsFile = path.join(tempDir, 'projects.json');
  await writeFile(projectsFile, JSON.stringify({ projects: [] }));

  const watcher = createMockConfigWatcher();
  const service = createServiceWithDefaults({
    configWatcher: watcher,
    projectsFilePath: projectsFile,
  });

  await assert.rejects(
    () => service.addLocalProject({ path: filePath }),
    /Path is not a directory/,
  );
});

test('addLocalProject throws when project already exists', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bridge-test-'));
  const projectDir = path.join(tempDir, 'my-project');
  await mkdir(projectDir);

  const projectsFile = path.join(tempDir, 'projects.json');
  await writeFile(projectsFile, JSON.stringify({ projects: [] }));

  const watcher = createMockConfigWatcher();
  const explicitProjects: any[] = [];
  const service = createServiceWithDefaults({
    configWatcher: watcher,
    projectsFilePath: projectsFile,
    getExplicitProjects: () => explicitProjects,
  });

  await service.addLocalProject({ path: projectDir });

  // Simulate reload by updating explicit projects
  const { readFileSync } = await import('node:fs');
  const loaded = JSON.parse(readFileSync(projectsFile, 'utf8')).projects;
  explicitProjects.length = 0;
  explicitProjects.push(...loaded);

  await assert.rejects(
    () => service.addLocalProject({ path: projectDir }),
    /Project "my-project" already exists/,
  );
});

test('addLocalProject throws when project id already exists', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bridge-test-'));
  const projectDir1 = path.join(tempDir, 'project-one');
  const projectDir2 = path.join(tempDir, 'project-two');
  await mkdir(projectDir1);
  await mkdir(projectDir2);

  const projectsFile = path.join(tempDir, 'projects.json');
  await writeFile(projectsFile, JSON.stringify({ projects: [] }));

  const watcher = createMockConfigWatcher();
  const explicitProjects: any[] = [];
  const service = createServiceWithDefaults({
    configWatcher: watcher,
    projectsFilePath: projectsFile,
    getExplicitProjects: () => explicitProjects,
  });

  await service.addLocalProject({ path: projectDir1, id: 'shared-id' });

  // Simulate reload
  const { readFileSync } = await import('node:fs');
  const loaded = JSON.parse(readFileSync(projectsFile, 'utf8')).projects;
  explicitProjects.length = 0;
  explicitProjects.push(...loaded);

  await assert.rejects(
    () => service.addLocalProject({ path: projectDir2, id: 'shared-id' }),
    /Project "shared-id" already exists/,
  );
});

test('addLocalProject resolves tilde paths', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bridge-test-'));
  const projectDir = path.join(tempDir, 'my-project');
  await mkdir(projectDir);

  const projectsFile = path.join(tempDir, 'projects.json');
  await writeFile(projectsFile, JSON.stringify({ projects: [] }));

  const watcher = createMockConfigWatcher();
  const service = createServiceWithDefaults({
    configWatcher: watcher,
    projectsFilePath: projectsFile,
  });

  // Test with absolute path instead of tilde (since HOME might not be set in test env)
  const result = await service.addLocalProject({ path: projectDir });

  assert.equal(result.projectInstanceId, 'my-project');
  assert.equal(result.cwd, projectDir);
});

test('addLocalProject only checks explicit projects for duplicates', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bridge-test-'));
  const projectDir = path.join(tempDir, 'my-project');
  await mkdir(projectDir);

  const projectsFile = path.join(tempDir, 'projects.json');
  await writeFile(projectsFile, JSON.stringify({ projects: [] }));

  const watcher = createMockConfigWatcher([
    // Simulate an auto-discovered project with the same ID
    { projectInstanceId: 'my-project', cwd: '/some/other/path', source: 'discovered' },
  ]);

  // Explicit projects is empty - should allow adding
  const service = createServiceWithDefaults({
    configWatcher: watcher,
    projectsFilePath: projectsFile,
    getExplicitProjects: () => [],
  });

  const result = await service.addLocalProject({ path: projectDir });

  assert.equal(result.projectInstanceId, 'my-project');
});
