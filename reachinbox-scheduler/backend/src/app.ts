import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import crypto from 'node:crypto';
import { env } from './config/env.js';
import { redis } from './redis.js';
import { prisma } from './prisma.js';
import { encrypt, decrypt } from './services/encryption.js';
import { emailQueue } from './queues.js';
import { normalizeRecipients } from './utils/recipient.js';
import sanitizeHtml from 'sanitize-html';
import { z } from 'zod';

declare global {
  namespace Express {
    interface User { id: string; name: string; email: string; avatarUrl?: string | null }
  }
}

export const app = express();
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(session({
  store: new RedisStore({ client: redis }),
  secret: env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production' },
  proxy: env.NODE_ENV === 'production'
}));
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user: Express.User, done) => done(null, user.id));
passport.deserializeUser(async (id: string, done) => {
  try { done(null, await prisma.user.findUnique({ where: { id } })); } catch (error) { done(error); }
});

if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    callbackURL: env.GOOGLE_CALLBACK_URL || 'http://localhost:5000/api/auth/google/callback'
  }, async (_accessToken, _refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value;
      if (!email) return done(new Error('Google account has no email'));
      const user = await prisma.user.upsert({
        where: { googleId: profile.id },
        update: { name: profile.displayName, email, avatarUrl: profile.photos?.[0]?.value },
        create: { googleId: profile.id, name: profile.displayName, email, avatarUrl: profile.photos?.[0]?.value }
      });
      done(null, user);
    } catch (error) { done(error as Error); }
  }));
}

function auth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}

app.get('/health/live', (_req, res) => res.json({ ok: true }));
app.get('/health/ready', async (_req, res) => {
  try { await prisma.$queryRaw`SELECT 1`; await redis.ping(); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});

app.get('/api/auth/google', (req, res, next) => {
  if (!env.GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google OAuth is not configured' });
  passport.authenticate('google', { scope: ['profile', 'email'], state: crypto.randomBytes(24).toString('hex') })(req, res, next);
});
app.get('/api/auth/google/callback', passport.authenticate('google', { failureRedirect: `${env.FRONTEND_URL}/login?error=oauth` }), (req, res) => {
  req.session.regenerate(error => {
    if (error) return res.redirect(`${env.FRONTEND_URL}/login?error=session`);
    req.session.save(() => res.redirect(env.FRONTEND_URL));
  });
});
app.get('/api/auth/me', (req, res) => res.json(req.user ?? null));
app.get('/api/auth/csrf', (req, res) => res.json({ csrf: req.session.id }));
app.post('/api/auth/logout', (req, res, next) => req.logout(error => error ? next(error) : req.session.destroy(() => res.json({ ok: true }))));

// Development-only test authentication; never enabled in production.
if (env.NODE_ENV !== 'production') {
  app.post('/api/auth/dev-login', async (_req, res) => {
    const user = await prisma.user.upsert({
      where: { email: 'oliver.brown@example.com' },
      update: { name: 'Oliver Brown' },
      create: { googleId: 'dev-oliver-brown', name: 'Oliver Brown', email: 'oliver.brown@example.com', avatarUrl: 'https://i.pravatar.cc/80?img=12' }
    });
    reqLogin(res, reqForLogin(res), user);
  });
}

function reqForLogin(res: express.Response) { return (res as any).req as express.Request; }
function reqLogin(res: express.Response, req: express.Request, user: Express.User) {
  req.login(user, error => {
    if (error) return res.status(500).json({ error: 'Login failed' });
    req.session.save(() => res.json(user));
  });
}

app.get('/api/senders', auth, async (req, res) => {
  const senders = await prisma.sender.findMany({ where: { userId: (req.user as Express.User).id, active: true }, orderBy: { createdAt: 'asc' } });
  res.json(senders.map((sender: any) => {
    const { encryptedSmtpPassword: _password, ...safe } = sender;
    return safe;
  }));
});
app.post('/api/senders', auth, async (req, res) => {
  const body = z.object({ name: z.string().min(1), email: z.string().email(), smtpUsername: z.string().min(1), smtpPassword: z.string().min(1) }).parse(req.body);
  const sender = await prisma.sender.create({ data: {
    userId: (req.user as Express.User).id, name: body.name, email: body.email,
    smtpUsername: body.smtpUsername, encryptedSmtpPassword: encrypt(body.smtpPassword)
  } });
  const { encryptedSmtpPassword, ...safe } = sender;
  res.status(201).json(safe);
});

const scheduleSchema = z.object({
  senderId: z.string().min(1),
  recipients: z.array(z.string()).min(1).max(5000),
  subject: z.string().min(1).max(500),
  textBody: z.string().default(''),
  htmlBody: z.string().default(''),
  startTime: z.string().datetime().optional(),
  delayBetweenEmailsMs: z.coerce.number().int().min(0).default(2000),
  hourlyLimit: z.coerce.number().int().min(1).default(100)
});

app.post('/api/emails/schedule', auth, async (req, res) => {
  const body = scheduleSchema.parse(req.body);
  const user = req.user as Express.User;
  const sender = await prisma.sender.findFirst({ where: { id: body.senderId, userId: user.id, active: true } });
  if (!sender) return res.status(404).json({ error: 'Sender not found' });
  const normalized = normalizeRecipients(body.recipients);
  if (!normalized.recipients.length) return res.status(400).json({ error: 'No valid recipients' });
  const effectiveDelay = Math.max(body.delayBetweenEmailsMs, env.MIN_EMAIL_DELAY_MS);
  const hourlyLimit = Math.min(body.hourlyLimit, env.MAX_EMAILS_PER_HOUR_PER_SENDER);
  const idempotencyKey = String(req.headers['idempotency-key'] || crypto.randomUUID());
  const requestHash = crypto.createHash('sha256').update(JSON.stringify({ ...body, recipients: normalized.recipients })).digest('hex');
  const existing = await prisma.campaign.findUnique({ where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } } });
  if (existing) {
    if (existing.requestHash !== requestHash) return res.status(409).json({ error: 'Idempotency key reused with a different payload' });
    return res.json({ campaign: existing, scheduledRecipientCount: existing.totalRecipients, duplicate: true });
  }
  const startTime = body.startTime ? new Date(body.startTime) : new Date();
  const htmlBody = sanitizeHtml(body.htmlBody, { allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img']), allowedAttributes: { '*': ['style'], a: ['href', 'name', 'target'], img: ['src', 'alt'] } });
  const textBody = body.textBody || htmlBody.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const campaign = await prisma.$transaction(async (tx: any) => {
    const created = await tx.campaign.create({ data: {
      userId: user.id, senderId: sender.id, subject: body.subject, textBody, htmlBody,
      startTime, delayBetweenEmailsMs: effectiveDelay, hourlyLimit, totalRecipients: normalized.recipients.length,
      idempotencyKey, requestHash
    } });
    await tx.emailJob.createMany({ data: normalized.recipients.map((recipientEmail, index) => ({
      campaignId: created.id, userId: user.id, senderId: sender.id, recipientEmail, subject: body.subject,
      textBody, htmlBody, scheduledAt: new Date(startTime.getTime() + index * effectiveDelay),
      bullJobId: `email:${created.id}:${index}`
    })) });
    await tx.outboxEvent.create({ data: { eventType: 'campaign.created', entityId: created.id, payload: { campaignId: created.id } } });
    return created;
  });
  const jobs = await prisma.emailJob.findMany({ where: { campaignId: campaign.id }, orderBy: { scheduledAt: 'asc' } });
  for (const job of jobs) {
    await emailQueue.add('send-email', { emailJobId: job.id }, {
      jobId: job.bullJobId,
      delay: Math.max(0, job.scheduledAt.getTime() - Date.now())
    });
  }
  res.status(201).json({ campaign, scheduledRecipientCount: jobs.length, duplicatesRemoved: normalized.duplicates, invalidRecipients: normalized.invalid });
});

app.get('/api/emails/counts', auth, async (req, res) => {
  const userId = (req.user as Express.User).id;
  const [scheduled, sent] = await Promise.all([
    prisma.emailJob.count({ where: { userId, status: { in: ['SCHEDULED', 'PROCESSING', 'RATE_LIMITED', 'RETRYING'] } } }),
    prisma.emailJob.count({ where: { userId, status: 'SENT' } })
  ]);
  res.json({ scheduled, sent });
});

app.get('/api/emails/scheduled', auth, async (req, res) => {
  const userId = (req.user as Express.User).id;
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
  const search = String(req.query.search || '').trim();
  const where: any = { userId, status: { in: ['SCHEDULED', 'PROCESSING', 'RATE_LIMITED', 'RETRYING'] } };
  if (search) where.OR = [{ recipientEmail: { contains: search, mode: 'insensitive' } }, { subject: { contains: search, mode: 'insensitive' } }, { textBody: { contains: search, mode: 'insensitive' } }];
  const [items, total] = await Promise.all([prisma.emailJob.findMany({ where, orderBy: { scheduledAt: 'asc' }, skip: (page - 1) * limit, take: limit }), prisma.emailJob.count({ where })]);
  res.json({ items, total, page, limit });
});

app.get('/api/emails/sent', auth, async (req, res) => {
  const userId = (req.user as Express.User).id;
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
  const search = String(req.query.search || '').trim();
  const where: any = { userId, status: { in: ['SENT', 'FAILED', 'DELIVERY_UNKNOWN'] } };
  if (search) where.OR = [{ recipientEmail: { contains: search, mode: 'insensitive' } }, { subject: { contains: search, mode: 'insensitive' } }];
  const [items, total] = await Promise.all([prisma.emailJob.findMany({ where, orderBy: { sentAt: 'desc' }, skip: (page - 1) * limit, take: limit }), prisma.emailJob.count({ where })]);
  res.json({ items, total, page, limit });
});

app.get('/api/emails/search', auth, async (req, res) => {
  const userId = (req.user as Express.User).id;
  const search = String(req.query.q || '').trim();
  const status = String(req.query.status || '');
  const where: any = { userId };
  if (search) where.OR = [{ recipientEmail: { contains: search, mode: 'insensitive' } }, { subject: { contains: search, mode: 'insensitive' } }, { textBody: { contains: search, mode: 'insensitive' } }];
  if (status) where.status = status;
  const items = await prisma.emailJob.findMany({ where, take: 100, orderBy: { updatedAt: 'desc' } });
  res.json({ items, source: 'postgres-fallback', elasticsearchConfigured: false });
});

app.get('/api/emails/:id', auth, async (req, res) => {
  const emailId = String(req.params.id);
  const job = await prisma.emailJob.findFirst({ where: { id: emailId, userId: (req.user as Express.User).id } });
  if (!job) return res.status(404).json({ error: 'Email not found' });
  res.json(job);
});

app.get('/api/slack/status', auth, async (req, res) => {
  const integration = await prisma.slackIntegration.findUnique({ where: { userId: (req.user as Express.User).id } });
  res.json({ connected: integration?.connected ?? false, workspaceName: integration?.workspaceName, channelName: integration?.channelName });
});
app.get('/api/slack/connect', auth, (req, res) => {
  const clientId = env.SLACK_CLIENT_ID;
  const redirectUri = env.SLACK_REDIRECT_URI || '';
  if (!clientId || !env.SLACK_CLIENT_SECRET) return res.status(503).json({ error: 'Slack OAuth is not configured' });
  const state = crypto.randomBytes(24).toString('hex');
  req.session.save(() => res.redirect(`https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(clientId)}&scope=incoming-webhook&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`));
});
app.post('/api/slack/disconnect', auth, async (req, res) => {
  await prisma.slackIntegration.deleteMany({ where: { userId: (req.user as Express.User).id } });
  res.json({ ok: true });
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err.status || (err.name === 'ZodError' ? 400 : 500);
  res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message || 'Request failed' });
});
