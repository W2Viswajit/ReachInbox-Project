type SlackSettings = {
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  SLACK_CALLBACK_URL: string;
  APP_URL: string;
};

// Return actionable configuration checks without exposing credentials or tokens.
export function evaluateSlackSetup(settings: SlackSettings) {
  const issues: string[] = [];
  if (!settings.SLACK_CLIENT_ID.trim())
    issues.push("Add SLACK_CLIENT_ID to your local .env file.");
  if (!settings.SLACK_CLIENT_SECRET.trim())
    issues.push("Add SLACK_CLIENT_SECRET to your local .env file.");
  try {
    const callback = new URL(settings.SLACK_CALLBACK_URL);
    if (callback.protocol !== "https:")
      issues.push(
        "Set SLACK_CALLBACK_URL to your HTTPS tunnel URL followed by /auth/slack/callback.",
      );
    if (callback.pathname.replace(/\/$/, "") !== "/auth/slack/callback")
      issues.push("The SLACK_CALLBACK_URL path must be /auth/slack/callback.");
    if (callback.origin !== new URL(settings.APP_URL).origin)
      issues.push(
        "APP_URL and SLACK_CALLBACK_URL must use the same hostname and protocol. Open the app at that address.",
      );
  } catch {
    issues.push(
      "Set APP_URL and SLACK_CALLBACK_URL to valid URLs using your current HTTPS tunnel hostname.",
    );
  }
  return { ready: issues.length === 0, issues };
}
