import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ListNotifications } from '../../application/list-notifications.ts';

const ListQuery = z.object({
  recipient: z.email(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function notificationRoutes(useCases: { list: ListNotifications }): FastifyPluginAsync {
  return async function notificationsHttp(app) {
    app.get('/notifications', async (request) => {
      const { recipient, limit } = ListQuery.parse(request.query);
      const notifications = await useCases.list.execute(recipient, limit);
      return notifications.map((n) => ({
        id: n.id,
        recipient: n.recipient,
        subject: n.subject,
        body: n.body,
        status: n.status,
        createdAt: n.createdAt.toISOString(),
        sentAt: n.sentAt?.toISOString() ?? null,
      }));
    });
  };
}
