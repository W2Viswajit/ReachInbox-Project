import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSlackSetup } from "../apps/api/src/slack-config.js";
const valid = {
  APP_URL: "https://demo.example.test",
  SLACK_CALLBACK_URL: "https://demo.example.test/auth/slack/callback",
  SLACK_CLIENT_ID: "test-client-id",
  SLACK_CLIENT_SECRET: "test-secret-not-for-output",
};
test("Slack setup accepts configured credentials and a matching HTTPS callback", () => {
  assert.deepEqual(evaluateSlackSetup(valid), { ready: true, issues: [] });
});
test("Slack setup names missing credentials without returning their values", () => {
  const result = evaluateSlackSetup({
    ...valid,
    SLACK_CLIENT_ID: "",
    SLACK_CLIENT_SECRET: "",
  });
  assert.equal(result.ready, false);
  assert.equal(result.issues.length, 2);
  assert.ok(result.issues.some((issue) => issue.includes("SLACK_CLIENT_ID")));
  assert.ok(
    !JSON.stringify(evaluateSlackSetup(valid)).includes(
      valid.SLACK_CLIENT_SECRET,
    ),
  );
});
test("Slack setup explains why a localhost HTTP callback cannot authorize Slack", () => {
  const result = evaluateSlackSetup({
    ...valid,
    APP_URL: "http://localhost:3001",
    SLACK_CALLBACK_URL: "http://localhost:3001/auth/slack/callback",
  });
  assert.equal(result.ready, false);
  assert.ok(result.issues.some((issue) => issue.includes("HTTPS")));
});
test("Slack setup rejects a different origin and incorrect callback route", () => {
  const result = evaluateSlackSetup({
    ...valid,
    SLACK_CALLBACK_URL: "https://old.example.test/wrong-route",
  });
  assert.equal(result.ready, false);
  assert.equal(result.issues.length, 2);
});
test("Slack setup returns a useful issue instead of throwing on malformed URLs", () => {
  const result = evaluateSlackSetup({
    ...valid,
    SLACK_CALLBACK_URL: "not-a-url",
  });
  assert.equal(result.ready, false);
  assert.ok(result.issues[0].includes("valid URLs"));
});
