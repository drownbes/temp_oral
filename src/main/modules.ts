import { digestsModule } from '#modules/digests/index.ts';
import { notificationsModule } from '#modules/notifications/index.ts';
import { sourcesModule } from '#modules/sources/index.ts';
import type { ModuleDefinition } from '#shared/infrastructure/module.ts';

/** Every bounded context in this deployable. Add new modules here. */
export const modules: readonly ModuleDefinition[] = [
  notificationsModule,
  sourcesModule,
  digestsModule,
];
