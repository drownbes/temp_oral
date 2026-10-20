// Runs in Temporal's deterministic sandbox: import only @temporalio/workflow, contracts
// and types. dependency-cruiser enforces this.
import { proxyActivities } from '@temporalio/workflow';
import type { SendNotificationWorkflow } from '../../contracts/index.ts';
import type { NotificationActivities } from './activities.ts';

const { sendNotification } = proxyActivities<NotificationActivities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 10, maximumInterval: '1 minute' },
});

/** Implements the published contract; the export name must equal SEND_NOTIFICATION_WORKFLOW. */
export const sendNotificationWorkflow: SendNotificationWorkflow = (input) =>
  sendNotification(input);
