import type { BindingService } from '../core/binding/binding-service.ts';
import type { ProjectRegistry } from './project-registry.ts';

export interface RestoreBoundProjectsOptions {
  bindingService: Pick<BindingService, 'getAllBindings'>;
  projectRegistry: Pick<ProjectRegistry, 'restoreBinding'>;
  onError?: (input: {
    projectInstanceId: string;
    sessionId: string;
    error: unknown;
  }) => void;
}

export async function restoreBoundProjects(options: RestoreBoundProjectsOptions): Promise<void> {
  const bindings = await options.bindingService.getAllBindings();
  for (const binding of bindings) {
    try {
      await options.projectRegistry.restoreBinding(binding.projectInstanceId, binding.sessionId);
    } catch (error) {
      options.onError?.({
        projectInstanceId: binding.projectInstanceId,
        sessionId: binding.sessionId,
        error,
      });
    }
  }
}
