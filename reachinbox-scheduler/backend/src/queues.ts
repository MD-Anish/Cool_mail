import { Queue } from 'bullmq';
import { redis } from './redis.js';

export const emailQueue = new Queue('email-sending', {
  connection: redis,
  defaultJobOptions: { removeOnComplete: false, removeOnFail: false, attempts: 3, backoff: { type: 'exponential', delay: 3000 } }
});
