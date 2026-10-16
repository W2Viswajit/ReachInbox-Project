# ReachInbox — Full-stack Email Scheduler

A React + Tailwind CSS / TypeScript email scheduler built for the ReachInbox hiring assignment. The UI follows the supplied white/green mailbox references: a narrow sidebar, Scheduled/Sent views, a full-page composer and a send-later popover.

**Delivery status:** source implementation and production builds are prepared. Google/Slack credentials must be supplied by the owner. Live OAuth, Ethereal delivery, database/Redis integration, browser layout verification and the recorded restart demonstration are pending; this repository does not claim those checks have passed.

## Start locally

Requirements: Node.js 22 LTS or newer, npm, Docker Desktop with Compose. Allow roughly 4 GB of available memory for Docker; Elasticsearch is the largest service. Internet access is required for package installation, Google, Slack and Ethereal.

```bash
npm ci
npm run setup
docker compose up -d --wait
npm run db:migrate
```

Edit the generated `.env` using [the account setup guide](docs/SETUP.md). Then:

```bash
npm run dev
```

Open **http://localhost:5173**. The API runs on port 3001, and Vite proxies `/api`, `/auth` and `/admin` to it. The worker is a separate process. Do not stop it when you close the browser.

For a production build served locally without Vite:

```bash
npm run build
npm run start -w apps/api
# In a second terminal:
npm run worker -w apps/api
```

Set `APP_URL=http://localhost:3001` and `GOOGLE_CALLBACK_URL=http://localhost:3001/auth/google/callback`, register that callback in Google, and restart the API before using the built server. Slack OAuth needs HTTPS; see the guide for a temporary tunnel.

## Feature map

| Requirement                          | Implementation                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| TypeScript + Express API             | `apps/api/src/server.ts`                                                                |
| Real Google OAuth                    | Authorization-code exchange, verified Google ID token, Redis sessions                   |
| Name/email/avatar/logout             | Header/sidebar profile and logout endpoint                                              |
| Multiple senders                     | Separate Ethereal test accounts; encrypted SMTP credentials                             |
| CSV/text lead upload                 | Email-column detection, normalization, invalid/duplicate counts                         |
| Subject/body and scheduling controls | Rich-text composer, start time, seconds between sends, hourly limit                     |
| Relational persistence               | PostgreSQL users, senders, batches, emails, Slack integrations, notifications           |
| Persistent scheduling without cron   | BullMQ delayed jobs, Redis AOF and persistent Docker volumes                            |
| Database/queue handoff               | Transactional pending email rows, stable job IDs, durable dispatch/reconciliation loops |
| Idempotency                          | Request key + payload hash, unique database constraints, atomic status transitions      |
| Concurrent workers                   | `WORKER_CONCURRENCY`; shared sender lock and atomic Redis budget                        |
| Hourly limits and send delay         | Per-sender fixed UTC hour window + minimum spacing; deferral instead of dropping        |
| Slack OAuth and live alerts          | OAuth-created incoming webhook, encrypted credentials, durable notifications            |
| Slack disconnect/reconnect           | Revoke token and remove integration; reconnect without restarting services              |
| Scheduled and sent lists             | Status, recipient, subject, time, pagination, loading/empty/error states                |
| Elasticsearch                        | User-scoped text search, versioned documents, indexing retry loop                       |
| Live BullMQ dashboard                | `/admin/queues`, protected by login + `ADMIN_EMAILS`, read-only                         |
| Message details                      | Body, sender, attempts, actual delivery time, errors, Ethereal preview link             |
| Large batches                        | Up to 5,000 recipients, bulk SQL insert, bounded queue dispatch                         |

## Architecture

The browser submits a batch to Express. A PostgreSQL transaction stores the batch and recipient records. A dispatcher adds each recipient to BullMQ with a stable job ID and a delay calculated from the scheduled timestamp. The worker enforces the sender's shared allowance immediately before sending through Ethereal. PostgreSQL records the outcome; a separate indexing loop publishes changes to Elasticsearch. Slack notifications are durable database records processed independently of email delivery.

The database is authoritative. Redis is the scheduler/session/throttling store; Elasticsearch is a derived search index. All data reads are scoped to the logged-in user. SMTP passwords, Slack tokens and webhook URLs use AES-256-GCM encryption. **Keep `ENCRYPTION_KEY` and `SESSION_SECRET` stable across restarts.** Losing the encryption key makes stored credentials unreadable.

### Scheduling and restart behavior

- A batch commits before returning success. No in-memory timer is responsible for an email's due time.
- Pending dispatch rows survive API/worker restarts. Dispatcher row locks support multiple processes.
- If enqueue succeeds but the database update fails, the stable BullMQ job ID deduplicates the next enqueue attempt. Completed queue records are retained for this demo.
- A reconciliation loop repairs missing queue entries for scheduled/deferred database records. It does not resend terminal records.
- Future jobs retain their timestamps. Overdue jobs become eligible after recovery, subject to sender limits. Exact wall-clock delivery is not promised during downtime or backlog.
- Docker persists PostgreSQL, Redis and Elasticsearch in named volumes. Redis uses AOF with `appendfsync everysec`; catastrophic Redis loss may lose the newest second of budget/session data. This is not a zero-data-loss multi-region design.
- Background loops perform outbox transport, reconciliation, indexing and notifications. They are not cron schedulers; all email due times are BullMQ delayed jobs.

### Concurrency, delay and rate limiting

`MIN_DELAY_MS` defaults to 2,000; `MAX_EMAILS_PER_HOUR` defaults to 200; `WORKER_CONCURRENCY` defaults to 5. The composer can choose a stricter sender allowance. The current configuration must remain unchanged while that sender has pending messages, avoiding incompatible rules across overlapping batches.

The Redis Lua script reads Redis's clock, checks the fixed UTC hour, enforces minimum spacing and reserves one send attempt atomically. A shared sender lock ensures one SMTP operation at a time for that sender, while different senders can progress concurrently. Earlier pending messages take precedence. Rate-limited jobs return to delayed state with the next eligible time.

Budgets count **attempt reservations**, not only successful deliveries. Failed or interrupted sends conservatively consume allowance. This prevents retries from bypassing provider-style limits. At the reservation that reaches the limit, a unique sender/hour notification is persisted if Slack is connected. Slack failure does not stop email processing. Notification delivery retries use capped backoff; an uncertain HTTP response can cause an occasional duplicate alert.

### Duplicate prevention and SMTP ambiguity

Repeated API requests with the same idempotency key and payload return the existing batch. A different payload with that key returns 409. Each recipient is unique within a batch. Already sent/failed/uncertain records are never automatically resent.

Plain SMTP has no transactional exactly-once primitive shared with PostgreSQL. If SMTP accepts a message and the process crashes before recording success, the record becomes `uncertain` instead of blindly resending. Inspect Ethereal before scheduling a replacement. Explicit SMTP rejection is `failed`; ambiguous timeouts are `uncertain`. The deterministic Message-ID is useful for investigation but is not a provider deduplication guarantee.

### Search

The worker creates `reachinbox-emails`, indexes searchable text and status with an external document version, and records which version was indexed. Failed indexing retries without changing email outcomes. Results can lag updates by the indexing loop plus Elasticsearch refresh interval. Search failures are reported rather than silently replaced by SQL substring search.

### Security and scope

HTTP-only SameSite cookies, OAuth state checks, session regeneration, CSRF headers, tenant-scoped database/search queries, sanitized rich text, encrypted integration credentials and an admin-only queue dashboard are included. The local database/search ports bind only to loopback. Do not expose them publicly using this development Compose file.

The optional `ALLOW_LOCAL_LOGIN=true` is a clearly labeled development aid, disabled by default and disabled in production. It is not a substitute for the required real Google demo. The reference's password-login, archive/delete and binary-attachment decorations are not implemented: the assignment requires Google login and CSV/text lead upload. The implemented interface does not show nonfunctional controls for those extras.

## Verification

```bash
npm run typecheck
npm test
npm run build
# After docker compose and database migration:
npm run test:integration
```

Unit tests cover lead parsing, server deduplication, input validation, batch size, planned ordering, stable job IDs and bounded retry delay. Integration tests use real Redis/PostgreSQL for concurrent quota reservations, minimum spacing, sender isolation, window rollover, delayed-job recovery, queue deduplication and SQL uniqueness/rollback. They create their own disposable test keys/queue and roll back database fixtures.

The integration suite does not send email or Slack messages. Full acceptance requires [the manual checklist and demo script](docs/DEMO.md). CI runs builds and the Redis/PostgreSQL integration suite when repository Actions are available; it does not prove OAuth, SMTP, Elasticsearch or Slack delivery.

## Project structure

```text
apps/api/src/       Express, auth, database, queue, worker, indexing
apps/web/src/       React mailbox, compose, settings, shared UI
tests/             Unit tests and service integration tests
docs/SETUP.md      Google, Slack, local runtime and tunnel setup
docs/DEMO.md       Acceptance checklist and <=5 minute recording script
samples/leads.csv  Example upload with duplicate and invalid records
compose.yaml      Persistent local PostgreSQL, Redis and Elasticsearch
```

## Submission

Use the private repository `W2Viswajit/ReachInbox-Project`. Grant the assignment reviewers `Mitrajit` and `Yadav036` access yourself, record the demo, and submit the repository/video links through the assignment form. No repository invitation or form submission is performed by this project.

The lockfile is included; use `npm ci`. Never commit `.env`, generated credentials, test-account passwords or Slack webhook URLs. This is an original implementation using published dependencies, with assumptions and verification limits stated above.

## Technical references

- https://docs.bullmq.io/guide/jobs/delayed
- https://docs.bullmq.io/guide/rate-limiting
- https://docs.bullmq.io/patterns/idempotent-jobs
- https://github.com/felixmosh/bull-board
- https://developers.google.com/identity/protocols/oauth2/web-server
- https://docs.slack.dev/authentication/installing-with-oauth/
- https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/
- https://www.elastic.co/docs/manage-data/data-store/near-real-time-search
