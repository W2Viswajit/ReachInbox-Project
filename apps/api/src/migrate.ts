import { db } from "./db.js";
await db.query(`
CREATE TABLE IF NOT EXISTS users(
 id uuid PRIMARY KEY, google_id text UNIQUE, email text UNIQUE NOT NULL, name text NOT NULL, avatar text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS senders(
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), name text NOT NULL, email text NOT NULL,
 smtp_user text NOT NULL, smtp_password text NOT NULL,
 delay_ms integer NOT NULL CHECK(delay_ms>=100), hourly_limit integer NOT NULL CHECK(hourly_limit>0), created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS batches(
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), sender_id uuid NOT NULL REFERENCES senders(id),
 idempotency_key text NOT NULL, request_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS emails(
 id uuid PRIMARY KEY,batch_id uuid NOT NULL REFERENCES batches(id),user_id uuid NOT NULL REFERENCES users(id),sender_id uuid NOT NULL REFERENCES senders(id),
 recipient text NOT NULL,subject text NOT NULL,body text NOT NULL,scheduled_at timestamptz NOT NULL,next_attempt_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','deferred','sending','sent','failed','uncertain')),
 sequence integer NOT NULL,queued_at timestamptz,sent_at timestamptz,started_at timestamptz,attempts integer NOT NULL DEFAULT 0,
 error text,preview_url text,message_id text,starred boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 1,indexed_version bigint NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(batch_id,recipient)
);
CREATE INDEX IF NOT EXISTS emails_user_status ON emails(user_id,status,scheduled_at);
CREATE INDEX IF NOT EXISTS emails_pending ON emails(sender_id,scheduled_at,sequence) WHERE status IN ('scheduled','deferred','sending');
CREATE TABLE IF NOT EXISTS slack_integrations(
 user_id uuid PRIMARY KEY REFERENCES users(id),webhook text NOT NULL,access_token text NOT NULL,team_name text,channel_name text,connected_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notifications(
 id text PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),sender_id uuid NOT NULL REFERENCES senders(id),hour_window bigint NOT NULL,
 limit_value integer NOT NULL,status text NOT NULL DEFAULT 'pending',attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz DEFAULT now(),last_error text
);
`);
console.log("Database schema is ready.");
await db.end();
