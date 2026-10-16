import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRecipients,
  plannedTimes,
  scheduleSchema,
  queueJobId,
  retryDelay,
} from "../apps/api/src/logic.js";
import { parseLeads } from "../apps/web/src/leads.js";
const valid = {
  senderId: "33d132fd-7e86-4624-b033-4aebf7562e1c",
  recipients: ["sarah@example.test"],
  subject: "Hello",
  body: "<p>Message</p>",
  startAt: "2026-10-17T10:00:00+05:30",
  delayMs: 2000,
  hourlyLimit: 10,
};
test("CSV recognizes the email column and separates invalid and duplicate addresses", () => {
  const result = parseLeads(
    'Name,Email\n"Wilson, Sarah",SARAH@example.test\nJohn,john@example.test\nAgain,sarah@example.test\nBad,invalid',
  );
  assert.deepEqual(result, {
    emails: ["sarah@example.test", "john@example.test"],
    duplicates: 1,
    invalid: 1,
  });
});
test("text imports support line, comma and semicolon separators", () => {
  assert.deepEqual(
    parseLeads("a@example.test; b@example.test\nc@example.test,d@example.test")
      .emails,
    ["a@example.test", "b@example.test", "c@example.test", "d@example.test"],
  );
});
test("server deduplicates recipients independently of the browser", () =>
  assert.deepEqual(
    normalizeRecipients([
      " A@example.test ",
      "a@example.test",
      "b@example.test",
    ]),
    ["a@example.test", "b@example.test"],
  ));
test("scheduling validates positive limits and minimum spacing", () => {
  assert.equal(scheduleSchema.safeParse(valid).success, true);
  for (const changes of [
    { delayMs: 0 },
    { hourlyLimit: 0 },
    { hourlyLimit: 1.5 },
    { recipients: [] },
    { recipients: ["invalid"] },
    { subject: "" },
    { senderId: "not-a-uuid" },
    { startAt: "tomorrow" },
  ])
    assert.equal(
      scheduleSchema.safeParse({ ...valid, ...changes }).success,
      false,
    );
});
test("requests cannot exceed the documented 5000 recipient cap", () =>
  assert.equal(
    scheduleSchema.safeParse({
      ...valid,
      recipients: Array(5001).fill("a@example.test"),
    }).success,
    false,
  ));
test("1000 planned jobs preserve their intended order and delay", () => {
  const times = plannedTimes(1700000000000, 1000, 2000);
  assert.equal(times.length, 1000);
  assert.equal(times[999], 1700001998000);
  for (let i = 1; i < times.length; i++)
    assert.equal(times[i] - times[i - 1], 2000);
});
test("job identities remain stable for retries and outbox recovery", () => {
  assert.equal(queueJobId("abc-123"), queueJobId("abc-123"));
  assert.notEqual(queueJobId("abc-123"), queueJobId("abc-124"));
  assert.ok(!queueJobId("abc-123").includes(":"));
});
test("notification backoff is bounded during prolonged Slack outages", () => {
  assert.equal(retryDelay(1), 2000);
  assert.ok(retryDelay(100) <= 300000);
});
