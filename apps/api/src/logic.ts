import { z } from "zod";
export const HOUR = 3_600_000;
export const scheduleSchema = z.object({
  senderId: z.uuid(),
  recipients: z.array(z.email().max(254)).min(1).max(5000),
  subject: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(100000),
  startAt: z.iso.datetime({ offset: true }),
  delayMs: z.number().int().min(100).max(HOUR),
  hourlyLimit: z.number().int().min(1).max(100000),
});
export function normalizeRecipients(recipients: string[]) {
  return [...new Set(recipients.map((x) => x.trim().toLowerCase()))];
}
export function plannedTimes(start: number, count: number, delay: number) {
  return Array.from({ length: count }, (_, i) => start + i * delay);
}
export function retryDelay(attempt: number) {
  return Math.min(300_000, 1000 * 2 ** Math.min(attempt, 8));
}
export function queueJobId(id: string) {
  return `email-${id}`;
}
// Atomic shared sender budget + spacing. Redis TIME avoids differences between worker clocks.
export const reserveLua = `
local tm=redis.call('TIME')
local now=tonumber(tm[1])*1000+math.floor(tonumber(tm[2])/1000)
local win=math.floor(now/3600000)
local previous=tonumber(redis.call('HGET',KEYS[1],'window') or '-1')
local count=tonumber(redis.call('HGET',KEYS[1],'count') or '0')
if previous~=win then count=0 end
local last=tonumber(redis.call('HGET',KEYS[1],'last') or '0')
local limit=tonumber(ARGV[1])
local gap=tonumber(ARGV[2])
if count>=limit then return {0,(win+1)*3600000,count,win} end
if last+gap>now then return {0,last+gap,count,win} end
count=count+1
redis.call('HSET',KEYS[1],'window',win,'count',count,'last',now)
redis.call('PEXPIRE',KEYS[1],7200000)
return {1,now,count,win}
`;
