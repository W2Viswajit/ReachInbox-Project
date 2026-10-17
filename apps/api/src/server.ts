import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import session from "express-session";
import { RedisStore } from "connect-redis";
import { createClient } from "redis";
import helmet from "helmet";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import sanitizeHtml from "sanitize-html";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { config, adminEmails } from "./config.js";
import { evaluateSlackSetup } from "./slack-config.js";
import { db, transaction } from "./db.js";
import { emailQueue, redis } from "./queue.js";
import { encrypt, decrypt, hash, token } from "./security.js";
import { normalizeRecipients, plannedTimes, scheduleSchema } from "./logic.js";
import { elastic, searchEmails } from "./search.js";

declare module "express-session" {
  interface SessionData {
    userId?: string;
    csrf?: string;
    googleState?: { value: string; at: number };
    slackState?: { value: string; at: number };
  }
}
const app = express();
if (config.NODE_ENV === "production") app.set("trust proxy", 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "img-src": ["'self'", "data:", "https://lh3.googleusercontent.com"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
      },
    },
  }),
);
app.use(express.json({ limit: "2mb" }));
const sessions = createClient({ url: config.REDIS_URL });
sessions.on("error", () => console.error("Session store unavailable"));
await sessions.connect();
app.use(
  session({
    store: new RedisStore({ client: sessions, prefix: "session:" }),
    secret: config.SESSION_SECRET,
    name: "reachinbox.sid",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 86400000,
    },
  }),
);
const auth = (req: Request, res: Response, next: NextFunction) =>
  req.session.userId
    ? next()
    : res.status(401).json({ error: "Please sign in with Google." });
function validState(actual: unknown, saved?: { value: string; at: number }) {
  return (
    typeof actual === "string" &&
    !!saved &&
    Date.now() - saved.at < 600000 &&
    actual.length === saved.value.length &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(saved.value))
  );
}
async function login(req: Request, id: string) {
  await new Promise<void>((resolve, reject) =>
    req.session.regenerate((e) => (e ? reject(e) : resolve())),
  );
  req.session.userId = id;
  req.session.csrf = token();
  await new Promise<void>((resolve, reject) =>
    req.session.save((e) => (e ? reject(e) : resolve())),
  );
}
app.get("/api/config", (_req, res) =>
  res.json({
    googleReady: !!(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET),
    slackReady: evaluateSlackSetup(config).ready,
    slackIssues: evaluateSlackSetup(config).issues,
    localLogin:
      config.NODE_ENV === "development" && config.ALLOW_LOCAL_LOGIN === "true",
    minDelayMs: config.MIN_DELAY_MS,
    maxHourlyLimit: config.MAX_EMAILS_PER_HOUR,
  }),
);
app.post("/api/local-login", async (req, res) => {
  if (config.NODE_ENV !== "development" || config.ALLOW_LOCAL_LOGIN !== "true")
    return res.sendStatus(404);
  if (req.get("Origin") !== new URL(config.APP_URL).origin)
    return res.sendStatus(403);
  const { rows } = await db.query(
    "INSERT INTO users(id,email,name) VALUES($1,$2,'Local Developer') ON CONFLICT(email) DO UPDATE SET name=users.name RETURNING id",
    [randomUUID(), config.LOCAL_LOGIN_EMAIL],
  );
  await login(req, rows[0].id);
  res.json({ ok: true });
});
app.get("/auth/google", async (req, res) => {
  if (!config.GOOGLE_CLIENT_ID)
    return res.redirect(`${config.APP_URL}/?error=google_not_configured`);
  req.session.googleState = { value: token(), at: Date.now() };
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: config.GOOGLE_CALLBACK_URL,
    response_type: "code",
    scope: "openid email profile",
    state: req.session.googleState.value,
  });
  await new Promise<void>((resolve, reject) =>
    req.session.save((e) => (e ? reject(e) : resolve())),
  );
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});
app.get("/auth/google/callback", async (req, res) => {
  const state = req.session.googleState;
  delete req.session.googleState;
  if (!validState(req.query.state, state) || typeof req.query.code !== "string")
    return res.redirect(`${config.APP_URL}/?error=google_authorization_failed`);
  try {
    const client = new OAuth2Client(
      config.GOOGLE_CLIENT_ID,
      config.GOOGLE_CLIENT_SECRET,
      config.GOOGLE_CALLBACK_URL,
    );
    const { tokens } = await client.getToken(req.query.code);
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token!,
      audience: config.GOOGLE_CLIENT_ID,
    });
    const p = ticket.getPayload();
    if (!p?.email || !p.email_verified)
      throw new Error("Verified email required");
    const { rows } = await db.query(
      `INSERT INTO users(id,google_id,email,name,avatar) VALUES($1,$2,$3,$4,$5)
   ON CONFLICT(email) DO UPDATE SET google_id=EXCLUDED.google_id,name=EXCLUDED.name,avatar=EXCLUDED.avatar RETURNING id`,
      [
        randomUUID(),
        p.sub,
        p.email.toLowerCase(),
        p.name || p.email,
        p.picture || null,
      ],
    );
    await login(req, rows[0].id);
    res.redirect(config.APP_URL);
  } catch {
    res.redirect(`${config.APP_URL}/?error=google_authorization_failed`);
  }
});
app.get("/auth/slack", auth, async (req, res) => {
  if (!evaluateSlackSetup(config).ready)
    return res.redirect(`${config.APP_URL}/?error=slack_not_configured`);
  req.session.slackState = { value: token(), at: Date.now() };
  const params = new URLSearchParams({
    client_id: config.SLACK_CLIENT_ID,
    scope: "incoming-webhook",
    redirect_uri: config.SLACK_CALLBACK_URL,
    state: req.session.slackState.value,
  });
  await new Promise<void>((resolve, reject) =>
    req.session.save((e) => (e ? reject(e) : resolve())),
  );
  res.redirect(`https://slack.com/oauth/v2/authorize?${params}`);
});
app.get("/auth/slack/callback", auth, async (req, res) => {
  const state = req.session.slackState;
  delete req.session.slackState;
  if (!validState(req.query.state, state) || typeof req.query.code !== "string")
    return res.redirect(`${config.APP_URL}/?error=slack_authorization_failed`);
  try {
    const r = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      body: new URLSearchParams({
        client_id: config.SLACK_CLIENT_ID,
        client_secret: config.SLACK_CLIENT_SECRET,
        code: req.query.code,
        redirect_uri: config.SLACK_CALLBACK_URL,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = (await r.json()) as any;
    if (!data.ok || !data.incoming_webhook?.url || !data.access_token)
      throw new Error("Slack authorization failed");
    if (new URL(data.incoming_webhook.url).hostname !== "hooks.slack.com")
      throw new Error("Unexpected webhook host");
    await db.query(
      `INSERT INTO slack_integrations(user_id,webhook,access_token,team_name,channel_name) VALUES($1,$2,$3,$4,$5)
  ON CONFLICT(user_id) DO UPDATE SET webhook=EXCLUDED.webhook,access_token=EXCLUDED.access_token,team_name=EXCLUDED.team_name,channel_name=EXCLUDED.channel_name,connected_at=now()`,
      [
        req.session.userId,
        encrypt(data.incoming_webhook.url),
        encrypt(data.access_token),
        data.team?.name,
        data.incoming_webhook.channel,
      ],
    );
    res.redirect(`${config.APP_URL}/?connected=slack`);
  } catch {
    res.redirect(`${config.APP_URL}/?error=slack_authorization_failed`);
  }
});
app.use("/api", auth, (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("Origin") && req.get("Origin") !== new URL(config.APP_URL).origin)
    return res.status(403).json({ error: "Origin not allowed" });
  if (!req.session.csrf || req.get("X-CSRF-Token") !== req.session.csrf)
    return res
      .status(403)
      .json({ error: "Refresh the page before trying again." });
  next();
});
app.get("/api/me", async (req, res) => {
  const { rows } = await db.query(
    "SELECT id,name,email,avatar FROM users WHERE id=$1",
    [req.session.userId],
  );
  res.json({
    ...rows[0],
    csrf: req.session.csrf,
    isAdmin: adminEmails.includes(rows[0]?.email),
  });
});
app.post("/api/logout", (req, res, next) =>
  req.session.destroy((e) => {
    if (e) return next(e);
    res.clearCookie("reachinbox.sid");
    res.json({ ok: true });
  }),
);
app.get("/api/senders", async (req, res) => {
  const { rows } = await db.query(
    "SELECT id,name,email,delay_ms,hourly_limit FROM senders WHERE user_id=$1 ORDER BY created_at",
    [req.session.userId],
  );
  const time = await redis.time();
  const window = Math.floor(Number(time[0]) / 3600);
  res.json(
    await Promise.all(
      rows.map(async (s) => {
        const budget = await redis.hgetall(`sender-budget:${s.id}`);
        return {
          ...s,
          used:
            Number(budget.window) === window ? Number(budget.count || 0) : 0,
        };
      }),
    ),
  );
});
app.post("/api/senders", async (req, res) => {
  const data = z
    .object({ name: z.string().trim().min(1).max(100) })
    .parse(req.body);
  const n = await db.query(
    "SELECT count(*)::int AS count FROM senders WHERE user_id=$1",
    [req.session.userId],
  );
  if (n.rows[0].count >= 10)
    return res
      .status(400)
      .json({ error: "This demo supports up to 10 senders per account." });
  // Request a fresh account: Nodemailer's createTestAccount() caches one account per process.
  const response = await fetch("https://api.nodemailer.com/user", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestor: "nodemailer", version: "7.0.0" }),
    signal: AbortSignal.timeout(20000),
  });
  const account = z
    .object({
      status: z.literal("success"),
      user: z.email(),
      pass: z.string().min(1),
    })
    .parse(await response.json());
  const { rows } = await db.query(
    "INSERT INTO senders(id,user_id,name,email,smtp_user,smtp_password,delay_ms,hourly_limit) VALUES($1,$2,$3,$4,$4,$5,$6,$7) RETURNING id,name,email,delay_ms,hourly_limit",
    [
      randomUUID(),
      req.session.userId,
      data.name,
      account.user,
      encrypt(account.pass),
      config.MIN_DELAY_MS,
      config.MAX_EMAILS_PER_HOUR,
    ],
  );
  res.status(201).json(rows[0]);
});
app.get("/api/slack", async (req, res) => {
  const { rows } = await db.query(
    "SELECT team_name,channel_name,connected_at FROM slack_integrations WHERE user_id=$1",
    [req.session.userId],
  );
  const alerts = await db.query(
    "SELECT status,count(*)::int AS count FROM notifications WHERE user_id=$1 GROUP BY status",
    [req.session.userId],
  );
  res.json({ connected: !!rows[0], ...rows[0], alerts: alerts.rows });
});
app.delete("/api/slack", async (req, res) => {
  const { rows } = await db.query(
    "SELECT access_token FROM slack_integrations WHERE user_id=$1",
    [req.session.userId],
  );
  if (rows[0]) {
    try {
      const r = await fetch("https://slack.com/api/auth.revoke", {
        method: "POST",
        headers: { Authorization: `Bearer ${decrypt(rows[0].access_token)}` },
        signal: AbortSignal.timeout(10000),
      });
      const data = (await r.json()) as any;
      if (
        !data.ok &&
        !["invalid_auth", "token_revoked", "token_expired"].includes(data.error)
      )
        throw new Error("Revoke failed");
    } catch {
      return res.status(502).json({
        error: "Slack could not confirm revocation. Retry disconnect shortly.",
      });
    }
  }
  await db.query("DELETE FROM slack_integrations WHERE user_id=$1", [
    req.session.userId,
  ]);
  res.json({ ok: true });
});
app.post("/api/schedules", async (req, res) => {
  const data = scheduleSchema.parse(req.body);
  const key = z.string().min(8).max(100).parse(req.get("Idempotency-Key"));
  const recipients = normalizeRecipients(data.recipients);
  const fingerprint = hash({ ...data, recipients });
  const result = await transaction(async (c) => {
    const sender = await c.query(
      "SELECT * FROM senders WHERE id=$1 AND user_id=$2 FOR UPDATE",
      [data.senderId, req.session.userId],
    );
    if (!sender.rowCount)
      throw Object.assign(
        new Error("Choose a sender belonging to your account."),
        { status: 404 },
      );
    const old = await c.query(
      "SELECT id,request_hash FROM batches WHERE user_id=$1 AND idempotency_key=$2",
      [req.session.userId, key],
    );
    if (old.rows[0]) {
      if (old.rows[0].request_hash !== fingerprint)
        throw Object.assign(
          new Error(
            "This request key was already used with different content.",
          ),
          { status: 409 },
        );
      return {
        batchId: old.rows[0].id,
        count: recipients.length,
        replayed: true,
      };
    }
    const start = new Date(data.startAt).getTime();
    if (start < Date.now() - 60000)
      throw Object.assign(new Error("Choose a start time in the future."), {
        status: 400,
      });
    if (
      data.delayMs < config.MIN_DELAY_MS ||
      data.hourlyLimit > config.MAX_EMAILS_PER_HOUR
    )
      throw Object.assign(
        new Error(
          `Use at least ${config.MIN_DELAY_MS / 1000}s delay and at most ${config.MAX_EMAILS_PER_HOUR} emails/hour.`,
        ),
        { status: 400 },
      );
    const active = await c.query(
      "SELECT 1 FROM emails WHERE sender_id=$1 AND status IN ('scheduled','deferred','sending') LIMIT 1",
      [data.senderId],
    );
    if (
      active.rowCount &&
      (sender.rows[0].delay_ms !== data.delayMs ||
        sender.rows[0].hourly_limit !== data.hourlyLimit)
    )
      throw Object.assign(
        new Error(
          "This sender has pending emails. Keep its existing delay and hourly limit until they finish.",
        ),
        { status: 409 },
      );
    const body = sanitizeHtml(data.body, {
      allowedTags: [
        "p",
        "br",
        "strong",
        "em",
        "u",
        "s",
        "ul",
        "ol",
        "li",
        "blockquote",
        "h2",
        "h3",
        "a",
      ],
      allowedAttributes: { a: ["href", "target", "rel"] },
      allowedSchemes: ["https", "http", "mailto"],
    });
    if (!body.replace(/<[^>]*>/g, "").trim())
      throw Object.assign(new Error("Enter an email message."), {
        status: 400,
      });
    await c.query(
      "UPDATE senders SET delay_ms=$2,hourly_limit=$3 WHERE id=$1",
      [data.senderId, data.delayMs, data.hourlyLimit],
    );
    const batchId = randomUUID();
    await c.query(
      "INSERT INTO batches(id,user_id,sender_id,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5)",
      [batchId, req.session.userId, data.senderId, key, fingerprint],
    );
    const times = plannedTimes(
      Math.max(start, Date.now()),
      recipients.length,
      data.delayMs,
    );
    // Bulk insertion keeps a 1000+ recipient request bounded to one SQL operation.
    await c.query(
      `INSERT INTO emails(id,batch_id,user_id,sender_id,recipient,subject,body,scheduled_at,next_attempt_at,sequence)
   SELECT x.id,$1,$2,$3,x.recipient,$4,$5,x.at,x.at,x.seq FROM jsonb_to_recordset($6::jsonb) AS x(id uuid,recipient text,at timestamptz,seq integer)`,
      [
        batchId,
        req.session.userId,
        data.senderId,
        data.subject,
        body,
        JSON.stringify(
          recipients.map((recipient, i) => ({
            id: randomUUID(),
            recipient,
            at: new Date(times[i]).toISOString(),
            seq: i,
          })),
        ),
      ],
    );
    return { batchId, count: recipients.length, replayed: false };
  });
  res.status(result.replayed ? 200 : 201).json(result);
});
app.get("/api/emails", async (req, res) => {
  const section = req.query.section === "sent" ? "sent" : "scheduled";
  const statuses =
    section === "sent"
      ? ["sent", "failed", "uncertain"]
      : ["scheduled", "deferred", "sending"];
  const q =
    typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
  const page = Math.min(400, Math.max(1, Number(req.query.page) || 1));
  if (q) {
    const found = await searchEmails(req.session.userId!, q, statuses, page);
    const ids = found.hits.hits.map((h: any) => h._id);
    const { rows } = await db.query(
      "SELECT e.*,s.email AS sender_email,s.name AS sender_name FROM emails e JOIN senders s ON s.id=e.sender_id WHERE e.user_id=$1 AND e.id=ANY($2::uuid[]) AND e.status=ANY($3::text[]) ORDER BY e.scheduled_at DESC",
      [req.session.userId, ids, statuses],
    );
    return res.json({
      items: rows,
      total: found.hits.total.value,
      page,
      source: "elasticsearch",
    });
  }
  const { rows } = await db.query(
    "SELECT e.*,s.email AS sender_email,s.name AS sender_name FROM emails e JOIN senders s ON s.id=e.sender_id WHERE e.user_id=$1 AND e.status=ANY($2::text[]) ORDER BY e.scheduled_at DESC LIMIT 25 OFFSET $3",
    [req.session.userId, statuses, (page - 1) * 25],
  );
  const total = await db.query(
    "SELECT count(*)::int AS total FROM emails WHERE user_id=$1 AND status=ANY($2::text[])",
    [req.session.userId, statuses],
  );
  res.json({
    items: rows,
    total: total.rows[0].total,
    page,
    source: "database",
  });
});
app.get("/api/stats", async (req, res) => {
  const { rows } = await db.query(
    "SELECT status,count(*)::int AS count FROM emails WHERE user_id=$1 GROUP BY status",
    [req.session.userId],
  );
  res.json(Object.fromEntries(rows.map((r) => [r.status, r.count])));
});
app.patch("/api/emails/:id/star", async (req, res) => {
  const id = z.uuid().parse(req.params.id);
  const starred = z.boolean().parse(req.body.starred);
  const r = await db.query(
    "UPDATE emails SET starred=$3 WHERE id=$1 AND user_id=$2 RETURNING id,starred",
    [id, req.session.userId, starred],
  );
  if (!r.rowCount) return res.sendStatus(404);
  res.json(r.rows[0]);
});
app.get("/api/health", async (_req, res) => {
  const results = await Promise.allSettled([
    db.query("SELECT 1"),
    redis.ping(),
    elastic("_cluster/health"),
  ]);
  res.json(
    Object.fromEntries(
      ["database", "redis", "search"].map((k, i) => [
        k,
        results[i].status === "fulfilled",
      ]),
    ),
  );
});
const boardAdapter = new ExpressAdapter();
boardAdapter.setBasePath("/admin/queues");
createBullBoard({
  queues: [new BullMQAdapter(emailQueue, { readOnlyMode: true })],
  serverAdapter: boardAdapter,
  options: {
    uiConfig: {
      boardTitle: "Bull Dashboard",
      boardLogo: { path: "" },
      favIcon: {
        default:
          'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 1 1%22/%3E',
        alternative:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7uoAAAAASUVORK5CYII=",
      },
    },
  },
});
app.use(
  "/admin/queues",
  auth,
  async (req, res, next) => {
    const { rows } = await db.query("SELECT email FROM users WHERE id=$1", [
      req.session.userId,
    ]);
    if (!adminEmails.includes(rows[0]?.email))
      return res
        .status(403)
        .send("Queue monitoring is restricted to configured administrators.");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'",
    );
    next();
  },
  boardAdapter.getRouter(),
);
const staticDir = fileURLToPath(new URL("../../web/dist", import.meta.url));
if (existsSync(staticDir)) {
  app.use(express.static(staticDir));
  app.get("/{*path}", (_req, res) => res.sendFile(`${staticDir}/index.html`));
}
app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError)
    return res.status(400).json({
      error: error.issues
        .map((x) => `${x.path.join(".")}: ${x.message}`)
        .join("; "),
    });
  const status = error.status >= 400 && error.status < 500 ? error.status : 503;
  res.status(status).json({
    error:
      status === 503
        ? "A required service is unavailable. Check the API and worker terminals, then retry."
        : error.message,
  });
});
const server = app.listen(config.PORT, () =>
  console.log(`API ready at http://localhost:${config.PORT}`),
);
async function stop() {
  server.close();
  await sessions.quit();
  await emailQueue.close();
  await redis.quit();
  await db.end();
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
