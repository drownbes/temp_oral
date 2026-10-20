/** Port: delivery channel (email provider, Slack, ...). */
export interface NotificationSender {
  send(message: { recipient: string; subject: string; body: string }): Promise<void>;
}
