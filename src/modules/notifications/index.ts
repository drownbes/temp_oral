import { fileURLToPath } from 'node:url';
import type { ModuleDefinition, ModuleDeps } from '#shared/infrastructure/module.ts';
import { systemClock } from '#shared/kernel/clock.ts';
import { ListNotifications } from './application/list-notifications.ts';
import { SendNotification } from './application/send-notification.ts';
import { NOTIFICATIONS_TASK_QUEUE } from './contracts/index.ts';
import { KyselyNotificationRepository } from './infrastructure/persistence/kysely-notification-repository.ts';
import {
  NOTIFICATIONS_SCHEMA,
  type NotificationsTables,
} from './infrastructure/persistence/tables.ts';
import { LogNotificationSender } from './infrastructure/sender/log-notification-sender.ts';
import { notificationRoutes } from './interface/http/routes.ts';
import { createNotificationActivities } from './interface/temporal/activities.ts';

const repository = (deps: ModuleDeps) =>
  new KyselyNotificationRepository(deps.db.withTables<NotificationsTables>());

export const notificationsModule: ModuleDefinition = {
  name: 'notifications',
  migrations: {
    schema: NOTIFICATIONS_SCHEMA,
    folder: fileURLToPath(new URL('./infrastructure/persistence/migrations', import.meta.url)),
  },
  http(deps) {
    return notificationRoutes({ list: new ListNotifications(repository(deps)) });
  },
  worker(deps) {
    const sender = new LogNotificationSender(deps.logger.child({ module: 'notifications' }));
    return {
      taskQueue: NOTIFICATIONS_TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL('./interface/temporal/workflows.ts', import.meta.url)),
      activities: createNotificationActivities({
        sendNotification: new SendNotification({
          repository: repository(deps),
          sender,
          clock: systemClock,
        }),
      }),
    };
  },
};
