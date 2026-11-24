import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(5000),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  BACKEND_URL: z.string().default('http://localhost:5000'),
  DATABASE_URL: z.string().default('postgresql://postgres:ZogAbBgnpKkhbfDCpOnhEjXMAQcUuHHO@postgres.railway.internal:5432/railway'),
  REDIS_URL: z.string().default('redis://default:SIypedzztCkanZhYMBvQhgBwcFxEJLHs@redis.railway.internal:6379'),
  ELASTICSEARCH_URL: z.string().default('http://localhost:9200'),
  ELASTICSEARCH_INDEX: z.string().default('emails'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().optional(),
  SESSION_SECRET: z.string().default('local-development-session-secret-change-me'),
  ENCRYPTION_KEY: z.string().default('0123456789abcdef0123456789abcdef'),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_REDIRECT_URI: z.string().optional(),
  SMTP_HOST: z.string().default('smtp.ethereal.email'),
  SMTP_PORT: z.coerce.number().default(587),
  WORKER_CONCURRENCY: z.coerce.number().default(5),
  MIN_EMAIL_DELAY_MS: z.coerce.number().default(2000),
  MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().default(200),
  MAX_EMAIL_ATTEMPTS: z.coerce.number().default(3),
  MAX_RECIPIENTS_PER_CAMPAIGN: z.coerce.number().default(5000),
  ADMIN_EMAILS: z.string().default('')
});

export const env = schema.parse(process.env);
