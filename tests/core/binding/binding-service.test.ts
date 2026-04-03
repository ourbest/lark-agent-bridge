import assert from 'node:assert/strict';
import test from 'node:test';

import { BindingService } from '../../../src/core/binding/binding-service.ts';
import { InMemoryBindingStore } from '../../../src/storage/binding-store.ts';

test('binds a project instance to a session', async () => {
  const service = new BindingService(new InMemoryBindingStore());

  await service.bindProjectToSession('project-a', 'session-a');

  assert.equal(await service.getSessionByProject('project-a'), 'session-a');
  assert.equal(await service.getProjectBySession('session-a'), 'project-a');
});

test('replaces an existing project binding when rebinding', async () => {
  const service = new BindingService(new InMemoryBindingStore());

  await service.bindProjectToSession('project-a', 'session-a');
  await service.bindProjectToSession('project-a', 'session-b');

  assert.equal(await service.getSessionByProject('project-a'), 'session-b');
  assert.equal(await service.getProjectBySession('session-a'), null);
  assert.equal(await service.getProjectBySession('session-b'), 'project-a');
});

test('detaches a session from its project when the session is rebound', async () => {
  const service = new BindingService(new InMemoryBindingStore());

  await service.bindProjectToSession('project-a', 'session-a');
  await service.bindProjectToSession('project-b', 'session-a');

  assert.equal(await service.getSessionByProject('project-a'), null);
  assert.equal(await service.getSessionByProject('project-b'), 'session-a');
  assert.equal(await service.getProjectBySession('session-a'), 'project-b');
});

test('unbinds a project instance from its session', async () => {
  const service = new BindingService(new InMemoryBindingStore());

  await service.bindProjectToSession('project-a', 'session-a');
  await service.unbindProject('project-a');

  assert.equal(await service.getSessionByProject('project-a'), null);
  assert.equal(await service.getProjectBySession('session-a'), null);
});

test('getAllBindings returns all current bindings', async () => {
  const service = new BindingService(new InMemoryBindingStore());

  await service.bindProjectToSession('project-a', 'session-a');
  await service.bindProjectToSession('project-b', 'session-b');

  const bindings = await service.getAllBindings();
  assert.equal(bindings.length, 2);
  assert.deepEqual(bindings, [
    { projectInstanceId: 'project-a', sessionId: 'session-a' },
    { projectInstanceId: 'project-b', sessionId: 'session-b' },
  ]);
});

test('getAllBindings returns empty array when no bindings exist', async () => {
  const service = new BindingService(new InMemoryBindingStore());

  const bindings = await service.getAllBindings();
  assert.deepEqual(bindings, []);
});

test('observer receives bound event when project is bound', async () => {
  const service = new BindingService(new InMemoryBindingStore());
  const events: any[] = [];

  service.onBindingChange((event) => events.push(event));

  await service.bindProjectToSession('project-a', 'session-a');

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'bound', projectId: 'project-a', sessionId: 'session-a' });
});

test('observer receives unbound event when project is unbound', async () => {
  const service = new BindingService(new InMemoryBindingStore());
  const events: any[] = [];

  service.onBindingChange((event) => events.push(event));

  await service.bindProjectToSession('project-a', 'session-a');
  await service.unbindProject('project-a');

  assert.equal(events.length, 2);
  assert.deepEqual(events[1], { type: 'unbound', projectId: 'project-a' });
});

test('observer receives session-unbound event when session is unbound', async () => {
  const service = new BindingService(new InMemoryBindingStore());
  const events: any[] = [];

  service.onBindingChange((event) => events.push(event));

  await service.bindProjectToSession('project-a', 'session-a');
  await service.unbindSession('session-a');

  assert.equal(events.length, 2);
  assert.deepEqual(events[1], { type: 'session-unbound', sessionId: 'session-a' });
});

test('multiple observers all receive events', async () => {
  const service = new BindingService(new InMemoryBindingStore());
  const events1: any[] = [];
  const events2: any[] = [];

  service.onBindingChange((event) => events1.push(event));
  service.onBindingChange((event) => events2.push(event));

  await service.bindProjectToSession('project-a', 'session-a');

  assert.equal(events1.length, 1);
  assert.equal(events2.length, 1);
  assert.deepEqual(events1[0], { type: 'bound', projectId: 'project-a', sessionId: 'session-a' });
  assert.deepEqual(events2[0], { type: 'bound', projectId: 'project-a', sessionId: 'session-a' });
});
