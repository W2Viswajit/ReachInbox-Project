import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { z } from "zod";
dotenv.config({
  path: fileURLToPath(new URL("../../../.env", import.meta.url)),
  quiet: true,
});
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  APP_URL: z.url().default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  ELASTICSEARCH_URL: z.url().default("http://localhost:9200"),
  SESSION_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().regex(/^[a-f\d]{64}$/i),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GOOGLE_CALLBACK_URL: z
    .string()
    .default("http://localhost:5173/auth/google/callback"),
  SLACK_CLIENT_ID: z.string().default(""),
  SLACK_CLIENT_SECRET: z.string().default(""),
  SLACK_CALLBACK_URL: z
    .string()
    .default("http://localhost:5173/auth/slack/callback"),
  ADMIN_EMAILS: z.string().default(""),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  MIN_DELAY_MS: z.coerce.number().int().min(100).default(2000),
  MAX_EMAILS_PER_HOUR: z.coerce.number().int().positive().default(200),
  ALLOW_LOCAL_LOGIN: z.string().default("false"),
  LOCAL_LOGIN_EMAIL: z.email().default("developer@example.test"),
});
export const config = schema.parse(process.env);
export const adminEmails = config.ADMIN_EMAILS.split(",")
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);
