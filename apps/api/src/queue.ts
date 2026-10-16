import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
});
export const emailQueue = new Queue("reachinbox-email", {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: false,
    removeOnFail: false,
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
  },
});
