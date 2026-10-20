import { documentsModule } from '#modules/documents/index.ts';
import { notificationsModule } from '#modules/notifications/index.ts';
import type { ModuleDefinition } from '#shared/infrastructure/module.ts';

/** Every bounded context in this deployable. Add new modules here. */
export const modules: readonly ModuleDefinition[] = [documentsModule, notificationsModule];
