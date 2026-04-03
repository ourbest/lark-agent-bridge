import type { IncomingMessage, ServerResponse } from 'node:http';

import type { BindingService } from '../core/binding/binding-service.ts';

export interface ApiDependencies {
  bindingService: BindingService;
}

type JsonValue = Record<string, unknown> | Array<unknown> | string | number | boolean | null;

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') {
    return {};
  }

  return JSON.parse(raw) as Record<string, unknown>;
}

function sendJson(response: ServerResponse, statusCode: number, body: JsonValue): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

function sendEmpty(response: ServerResponse, statusCode: number): void {
  response.statusCode = statusCode;
  response.end();
}

function readPathId(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) {
    return null;
  }

  const id = pathname.slice(prefix.length);
  return id.length > 0 ? decodeURIComponent(id) : null;
}

export function createApiRequestHandler(dependencies: ApiDependencies) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestUrl = request.url ?? '/';
    const url = new URL(requestUrl, 'http://127.0.0.1');

    if (request.method === 'POST' && url.pathname === '/bindings') {
      const body = await readJsonBody(request);
      const projectInstanceId = body.projectInstanceId;
      const sessionId = body.sessionId;

      if (typeof projectInstanceId !== 'string' || typeof sessionId !== 'string') {
        sendJson(response, 400, { error: 'invalid binding payload' });
        return;
      }

      await dependencies.bindingService.bindProjectToSession(projectInstanceId, sessionId);
      sendJson(response, 200, { projectInstanceId, sessionId });
      return;
    }

    if (request.method === 'DELETE') {
      const projectInstanceId = readPathId(url.pathname, '/bindings/project/');
      if (projectInstanceId !== null) {
        await dependencies.bindingService.unbindProject(projectInstanceId);
        sendEmpty(response, 204);
        return;
      }

      const sessionId = readPathId(url.pathname, '/bindings/session/');
      if (sessionId !== null) {
        await dependencies.bindingService.unbindSession(sessionId);
        sendEmpty(response, 204);
        return;
      }
    }

    if (request.method === 'GET') {
      const projectInstanceId = readPathId(url.pathname, '/bindings/project/');
      if (projectInstanceId !== null) {
        const sessionId = await dependencies.bindingService.getSessionByProject(projectInstanceId);
        if (sessionId === null) {
          sendJson(response, 404, { error: 'binding not found' });
          return;
        }

        sendJson(response, 200, { projectInstanceId, sessionId });
        return;
      }

      const sessionLookupId = readPathId(url.pathname, '/bindings/session/');
      if (sessionLookupId !== null) {
        const projectId = await dependencies.bindingService.getProjectBySession(sessionLookupId);
        if (projectId === null) {
          sendJson(response, 404, { error: 'binding not found' });
          return;
        }

        sendJson(response, 200, {
          projectInstanceId: projectId,
          sessionId: sessionLookupId,
        });
        return;
      }
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }

    sendJson(response, 404, { error: 'not found' });
  };
}
