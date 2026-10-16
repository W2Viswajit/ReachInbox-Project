import { randomUUID } from "node:crypto";
import { Worker, DelayedError, UnrecoverableError, type Job } from "bullmq";
import nodemailer from "nodemailer";
import { db, transaction } from "./db.js";
import { redis, emailQueue } from "./queue.js";
import { config } from "./config.js";
import { decrypt } from "./security.js";
import { reserveLua, queueJobId, retryDelay } from "./logic.js";
import { initSearch, indexPending } from "./search.js";

async function defer(job: Job, id: string, time: number, reason: string) {
  await db.query(
    "UPDATE emails SET status='deferred',next_attempt_at=$2,error=$3,version=version+1 WHERE id=$1 AND status IN ('scheduled','deferred')",
    [id, new Date(time), reason],
  );
  await job.moveToDelayed(time, job.token);
  throw new DelayedError();
}
async function notifyLimit(row: any, window: number) {
  await db.query(
    `INSERT INTO notifications(id,user_id,sender_id,hour_window,limit_value)
 SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM slack_integrations WHERE user_id=$2)
 ON CONFLICT(id) DO NOTHING`,
    [
      `limit-${row.sender_id}-${window}`,
      row.user_id,
      row.sender_id,
      window,
      row.hourly_limit,
    ],
  );
}

const worker = new Worker(
  "reachinbox-email",
  async (job) => {
    const id = String(job.data.emailId);
    const result = await db.query(
      `SELECT e.*,s.email AS sender_email,s.name AS sender_name,s.smtp_user,s.smtp_password,s.delay_ms,s.hourly_limit
 FROM emails e JOIN senders s ON e.sender_id=s.id WHERE e.id=$1`,
      [id],
    );
    const row = result.rows[0];
    if (!row || ["sent", "failed", "uncertain"].includes(row.status)) return;
    if (row.status === "sending") {
      await db.query(
        "UPDATE emails SET status='uncertain',error='Worker interrupted during SMTP. Inspect Ethereal before attempting another send.',version=version+1 WHERE id=$1 AND status='sending'",
        [id],
      );
      return;
    }
    const lockKey = `sender-lock:${row.sender_id}`,
      lockValue = randomUUID();
    if (!(await redis.set(lockKey, lockValue, "PX", 120000, "NX")))
      return defer(job, id, Date.now() + 1000, "Waiting for the sender");
    try {
      // Earlier eligible messages from this sender take precedence across batches and workers.
      const ahead = await db.query(
        `SELECT 1 FROM emails WHERE sender_id=$1 AND id<>$2 AND status IN ('scheduled','deferred','sending')
   AND (scheduled_at,created_at,sequence,id)<($3,$4,$5,$2::uuid) LIMIT 1`,
        [row.sender_id, id, row.scheduled_at, row.created_at, row.sequence],
      );
      if (ahead.rowCount)
        return defer(
          job,
          id,
          Date.now() + 2000,
          "Waiting for earlier emails from this sender",
        );
      const [allowed, next, count, window] = (await redis.eval(
        reserveLua,
        1,
        `sender-budget:${row.sender_id}`,
        row.hourly_limit,
        row.delay_ms,
      )) as number[];
      if (count >= row.hourly_limit) await notifyLimit(row, window);
      if (!allowed)
        return defer(
          job,
          id,
          next,
          count >= row.hourly_limit
            ? "Hourly sender limit reached"
            : "Minimum send delay",
        );
      const claim = await db.query(
        "UPDATE emails SET status='sending',started_at=now(),attempts=attempts+1,error=NULL,version=version+1 WHERE id=$1 AND status IN ('scheduled','deferred') RETURNING id",
        [id],
      );
      if (!claim.rowCount) return;
      const transport = nodemailer.createTransport({
        host: "smtp.ethereal.email",
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: row.smtp_user, pass: decrypt(row.smtp_password) },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 30000,
      });
      let info: nodemailer.SentMessageInfo;
      try {
        info = await transport.sendMail({
          from: { name: row.sender_name, address: row.sender_email },
          to: row.recipient,
          subject: row.subject,
          html: row.body,
          text: row.body.replace(/<[^>]+>/g, " "),
          messageId: `<${id}@reachinbox.local>`,
        });
      } catch (error: any) {
        // A response explicitly rejecting the send is safe to classify as failed. Timeouts can be ambiguous.
        const rejected =
          ["EAUTH", "EENVELOPE", "ECONNECTION", "EDNS"].includes(error.code) ||
          Number(error.responseCode) >= 400;
        await db.query(
          "UPDATE emails SET status=$2,error=$3,version=version+1 WHERE id=$1",
          [
            id,
            rejected ? "failed" : "uncertain",
            rejected
              ? "SMTP rejected or could not establish delivery. Check sender credentials and Ethereal."
              : "SMTP outcome is unknown. Inspect Ethereal before sending again.",
          ],
        );
        throw new UnrecoverableError(
          rejected
            ? "SMTP delivery failed"
            : "Ambiguous SMTP outcome; automatic resend blocked",
        );
      } finally {
        transport.close();
      }
      // If this write fails after SMTP accepted the message, the next execution preserves uncertainty instead of resending.
      await db.query(
        "UPDATE emails SET status='sent',sent_at=now(),preview_url=$2,message_id=$3,error=NULL,version=version+1 WHERE id=$1",
        [id, nodemailer.getTestMessageUrl(info) || null, info.messageId],
      );
    } finally {
      await redis.eval(
        "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",
        1,
        lockKey,
        lockValue,
      );
    }
  },
  {
    connection: redis,
    concurrency: config.WORKER_CONCURRENCY,
    lockDuration: 120000,
  },
);
worker.on("error", () =>
  console.error("Worker connection error; check Redis."),
);
worker.on("failed", async (job) => {
  console.error(`Job ${job?.id} failed; inspect queue dashboard.`);
  if (job && job.attemptsMade >= Number(job.opts.attempts || 1)) {
    await db
      .query(
        "UPDATE emails SET status=CASE WHEN status='sending' THEN 'uncertain' ELSE 'failed' END,error='Worker retries exhausted; inspect queue dashboard',version=version+1 WHERE id=$1 AND status NOT IN ('sent','failed','uncertain')",
        [job.data.emailId],
      )
      .catch(() => {});
  }
});

async function dispatch() {
  await transaction(async (c) => {
    const { rows } = await c.query(
      "SELECT id,next_attempt_at FROM emails WHERE queued_at IS NULL AND status IN ('scheduled','deferred') ORDER BY scheduled_at,sequence LIMIT 100 FOR UPDATE SKIP LOCKED",
    );
    for (const row of rows) {
      await emailQueue.add(
        "send",
        { emailId: row.id },
        {
          jobId: queueJobId(row.id),
          delay: Math.max(
            0,
            new Date(row.next_attempt_at).getTime() - Date.now(),
          ),
        },
      );
      await c.query("UPDATE emails SET queued_at=now() WHERE id=$1", [row.id]);
    }
  });
}
async function reconcile() {
  // Recover missing queue records, e.g. Redis data loss. Database state remains authoritative.
  const { rows } = await db.query(
    "SELECT id FROM emails WHERE status IN ('scheduled','deferred') AND queued_at IS NOT NULL ORDER BY queued_at LIMIT 100",
  );
  for (const row of rows) {
    if (!(await emailQueue.getJob(queueJobId(row.id))))
      await db.query("UPDATE emails SET queued_at=NULL WHERE id=$1", [row.id]);
    else
      await db.query("UPDATE emails SET queued_at=now() WHERE id=$1", [row.id]);
  }
  await db.query(
    "UPDATE emails SET status='uncertain',error='Send interrupted; check Ethereal before retrying',version=version+1 WHERE status='sending' AND started_at<now()-interval '5 minutes'",
  );
}
async function slackNotifications() {
  await transaction(async (c) => {
    const { rows } =
      await c.query(`SELECT n.*,s.email AS sender_email,i.webhook FROM notifications n JOIN senders s ON s.id=n.sender_id
  LEFT JOIN slack_integrations i ON i.user_id=n.user_id WHERE n.status='pending' AND n.next_attempt_at<=now() ORDER BY n.next_attempt_at LIMIT 1 FOR UPDATE OF n SKIP LOCKED`);
    const row = rows[0];
    if (!row) return;
    if (!row.webhook) {
      await c.query("UPDATE notifications SET status='skipped' WHERE id=$1", [
        row.id,
      ]);
      return;
    }
    try {
      const resume = new Date(
        (Number(row.hour_window) + 1) * 3600000,
      ).toISOString();
      const response = await fetch(decrypt(row.webhook), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `ReachInbox: ${row.sender_email} reached its hourly send-attempt limit (${row.limit_value}). Remaining emails are queued for ${resume}.`,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`Slack HTTP ${response.status}`);
      await c.query(
        "UPDATE notifications SET status='sent',last_error=NULL WHERE id=$1",
        [row.id],
      );
    } catch {
      await c.query(
        "UPDATE notifications SET attempts=attempts+1,next_attempt_at=$2,last_error='Slack request failed; will retry' WHERE id=$1",
        [row.id, new Date(Date.now() + retryDelay(row.attempts + 1))],
      );
    }
  });
}
let stopping = false;
async function loop(name: string, run: () => Promise<void>, delay: number) {
  while (!stopping) {
    try {
      await run();
    } catch {
      console.error(`${name} unavailable; retrying without dropping records`);
    }
    await new Promise((r) => setTimeout(r, delay));
  }
}
// These loops transport durable outbox/search/notification records. Email due times use BullMQ delayed jobs exclusively.
const loops = [
  loop("outbox", dispatch, 500),
  loop("reconciliation", reconcile, 10000),
  loop(
    "search",
    async () => {
      await initSearch();
      await indexPending();
    },
    2000,
  ),
  loop("Slack", slackNotifications, 500),
];
console.log(`Worker ready with concurrency ${config.WORKER_CONCURRENCY}.`);
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await worker.close();
  await Promise.all(loops);
  await emailQueue.close();
  await redis.quit();
  await db.end();
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
