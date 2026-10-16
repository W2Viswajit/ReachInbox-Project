import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { Queue, Worker, QueueEvents } from "bullmq";
import { reserveLua } from "../../apps/api/src/logic.js";
const url = process.env.REDIS_URL || "redis://localhost:6379";
test(
  "atomic sender limits hold under 100 simultaneous reservations",
  { timeout: 15000 },
  async () => {
    const redis = new Redis(url, { maxRetriesPerRequest: null });
    const key = `integration-${randomUUID()}`;
    try {
      const results = await Promise.all(
        Array.from(
          { length: 100 },
          () => redis.eval(reserveLua, 1, key, 5, 0) as Promise<number[]>,
        ),
      );
      assert.equal(results.filter((r) => r[0] === 1).length, 5);
      assert.equal(Number(await redis.hget(key, "count")), 5);
    } finally {
      await redis.del(key);
      await redis.quit();
    }
  },
);
test(
  "minimum spacing is shared, and independent senders retain capacity",
  { timeout: 15000 },
  async () => {
    const redis = new Redis(url, { maxRetriesPerRequest: null });
    const key = `integration-${randomUUID()}`,
      other = `integration-${randomUUID()}`;
    try {
      const results = await Promise.all(
        Array.from(
          { length: 30 },
          () => redis.eval(reserveLua, 1, key, 100, 60000) as Promise<number[]>,
        ),
      );
      assert.equal(results.filter((r) => r[0] === 1).length, 1);
      assert.equal(
        ((await redis.eval(reserveLua, 1, other, 100, 60000)) as number[])[0],
        1,
      );
    } finally {
      await redis.del(key, other);
      await redis.quit();
    }
  },
);
test(
  "hourly budget rolls over without discarding minimum spacing",
  { timeout: 15000 },
  async () => {
    const redis = new Redis(url, { maxRetriesPerRequest: null });
    const key = `integration-${randomUUID()}`;
    try {
      const [s] = await redis.time();
      const now = Number(s) * 1000,
        window = Math.floor(now / 3600000);
      await redis.hset(key, "window", window - 1, "count", 5, "last", now);
      const blocked = (await redis.eval(
        reserveLua,
        1,
        key,
        5,
        60000,
      )) as number[];
      assert.equal(blocked[0], 0);
      await redis.hset(key, "last", 0);
      const allowed = (await redis.eval(
        reserveLua,
        1,
        key,
        5,
        60000,
      )) as number[];
      assert.equal(allowed[0], 1);
      assert.equal(allowed[2], 1);
    } finally {
      await redis.del(key);
      await redis.quit();
    }
  },
);
test(
  "delayed jobs survive producer restart and stable IDs prevent duplicate queue entries",
  { timeout: 15000 },
  async () => {
    const connection = new Redis(url, { maxRetriesPerRequest: null });
    const name = `integration-${randomUUID()}`;
    let queue = new Queue(name, { connection });
    const events = new QueueEvents(name, { connection });
    await events.waitUntilReady();
    let worker: Worker | undefined;
    let sent = 0;
    try {
      await queue.add("test", {}, { jobId: "one", delay: 500 });
      await queue.close();
      queue = new Queue(name, { connection });
      await queue.add("test", {}, { jobId: "one", delay: 500 });
      assert.equal(await queue.count(), 1);
      worker = new Worker(
        name,
        async () => {
          sent++;
        },
        { connection, concurrency: 5 },
      );
      const job = await queue.getJob("one");
      await job!.waitUntilFinished(events, 10000);
      assert.equal(sent, 1);
    } finally {
      await worker?.close();
      await events.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await connection.quit();
    }
  },
);
