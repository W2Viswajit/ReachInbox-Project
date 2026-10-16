let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
      ...options.headers,
    },
  });
  const data = await response
    .json()
    .catch(() => ({ error: `Request failed (${response.status})` }));
  if (!response.ok)
    throw Object.assign(new Error(data.error || "Something went wrong"), {
      status: response.status,
    });
  return data;
}
export type User = {
  id: string;
  name: string;
  email: string;
  avatar?: string;
  csrf: string;
  isAdmin: boolean;
};
export type Config = {
  googleReady: boolean;
  slackReady: boolean;
  localLogin: boolean;
  minDelayMs: number;
  maxHourlyLimit: number;
};
export type Sender = {
  id: string;
  name: string;
  email: string;
  delay_ms: number;
  hourly_limit: number;
  used: number;
};
export type Email = {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  scheduled_at: string;
  next_attempt_at: string;
  sent_at: string | null;
  status: string;
  error: string | null;
  sender_name: string;
  sender_email: string;
  attempts: number;
  preview_url: string | null;
  starred: boolean;
};
export type Slack = {
  connected: boolean;
  team_name?: string;
  channel_name?: string;
  alerts: { status: string; count: number }[];
};
