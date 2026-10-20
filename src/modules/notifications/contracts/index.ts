/**
 * Published language of the notifications context. Other contexts may import ONLY this
 * file (enforced by dependency-cruiser): plain constants and types, no implementation.
 *
 * Other contexts start the workflow by name on the notifications task queue, so the
 * notifications worker can be deployed and scaled separately.
 */
export const NOTIFICATIONS_TASK_QUEUE = 'notifications';
export const SEND_NOTIFICATION_WORKFLOW = 'sendNotificationWorkflow';

export interface SendNotificationInput {
  /** Same key => same notification; retries and duplicate requests send once. */
  readonly idempotencyKey: string;
  readonly recipient: string;
  readonly subject: string;
  readonly body: string;
}

export interface SendNotificationResult {
  readonly notificationId: string;
}

export type SendNotificationWorkflow = (
  input: SendNotificationInput,
) => Promise<SendNotificationResult>;
