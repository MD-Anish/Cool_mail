import { Worker, DelayedError } from 'bullmq';
import nodemailer from 'nodemailer';
import { redis } from './redis.js';
import { env } from './config/env.js';
import { prisma } from './prisma.js';
import { decrypt } from './services/encryption.js';

const worker = new Worker('email-sending', async job => {
  const emailJobId = job.data.emailJobId as string;
  const email = await prisma.emailJob.findUnique({ where: { id: emailJobId } });
  if (!email || email.status === 'SENT') return;
  await prisma.emailJob.update({ where: { id: emailJobId }, data: { status: 'PROCESSING', attempts: { increment: 1 } } });
  const sender = await prisma.sender.findUnique({ where: { id: email.senderId } });
  if (!sender) throw new Error('Sender no longer exists');

  const now = await redis.time();
  const ms = Number(now[0]) * 1000 + Math.floor(Number(now[1]) / 1000);
  const hourKey = new Date(ms).toISOString().slice(0, 13);
  const senderLimitKey = `rate:${sender.id}:${hourKey}`;
  const campaignLimitKey = `rate:${email.campaignId}:${hourKey}`;
  const senderCount = await redis.incr(senderLimitKey);
  await redis.expire(senderLimitKey, 7200);
  const senderLimit = env.MAX_EMAILS_PER_HOUR_PER_SENDER;
  const campaign = await prisma.campaign.findUnique({ where: { id: email.campaignId } });
  if (!campaign) throw new Error('Campaign no longer exists');
  const campaignCount = await redis.incr(campaignLimitKey);
  await redis.expire(campaignLimitKey, 7200);
  if (senderCount > senderLimit || campaignCount > campaign.hourlyLimit) {
    const next = new Date(ms);
    next.setUTCMinutes(0, 0, 0); next.setUTCHours(next.getUTCHours() + 1);
    await prisma.emailJob.update({ where: { id: emailJobId }, data: { status: 'RATE_LIMITED', nextEligibleAt: next } });
    await job.moveToDelayed(next.getTime(), job.token);
    throw new DelayedError();
  }

  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_PORT === 465,
    auth: { user: sender.smtpUsername, pass: decrypt(sender.encryptedSmtpPassword) }
  });
  try {
    const result = await transport.sendMail({ from: `"${sender.name}" <${sender.email}>`, to: email.recipientEmail, subject: email.subject, text: email.textBody, html: email.htmlBody });
    await prisma.emailJob.update({ where: { id: emailJobId }, data: {
      status: 'SENT', sentAt: new Date(), providerMessageId: result.messageId,
      previewUrl: nodemailer.getTestMessageUrl(result) || null, nextEligibleAt: null
    } });
  } catch (error: any) {
    const uncertain = /socket|econn|timeout|network/i.test(error.message || '');
    await prisma.emailJob.update({ where: { id: emailJobId }, data: {
      status: uncertain ? 'DELIVERY_UNKNOWN' : 'FAILED',
      failureReason: String(error.message || error).slice(0, 1000)
    } });
  }
}, { connection: redis, concurrency: env.WORKER_CONCURRENCY });

worker.on('completed', job => console.log(`Job ${job.id} completed`));
worker.on('failed', (job, error) => console.error(`Job ${job?.id} failed`, error.message));

async function shutdown() { await worker.close(); await redis.quit(); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
