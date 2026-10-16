import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
test(
  "database enforces batch idempotency and transaction rollback",
  { timeout: 15000 },
  async () => {
    const client = new pg.Client({
      connectionString:
        process.env.DATABASE_URL ||
        "postgres://reachinbox:reachinbox@localhost:5432/reachinbox",
    });
    await client.connect();
    try {
      await client.query("BEGIN");
      const uid = randomUUID(),
        sid = randomUUID(),
        bid = randomUUID();
      await client.query("INSERT INTO users(id,email,name) VALUES($1,$2,$3)", [
        uid,
        `${uid}@example.test`,
        "Integration Test",
      ]);
      await client.query(
        "INSERT INTO senders(id,user_id,name,email,smtp_user,smtp_password,delay_ms,hourly_limit) VALUES($1,$2,$3,$4,$4,$5,2000,5)",
        [sid, uid, "Test", `${sid}@example.test`, "test-only-not-a-secret"],
      );
      await client.query(
        "INSERT INTO batches(id,user_id,sender_id,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5)",
        [bid, uid, sid, "test-key", "hash"],
      );
      await assert.rejects(
        client.query(
          "INSERT INTO batches(id,user_id,sender_id,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5)",
          [randomUUID(), uid, sid, "test-key", "hash"],
        ),
        (e: any) => e.code === "23505",
      );
      await client.query("ROLLBACK");
      const result = await client.query("SELECT 1 FROM users WHERE id=$1", [
        uid,
      ]);
      assert.equal(result.rowCount, 0);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }
  },
);
