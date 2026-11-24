# ReachInbox Email Scheduler

Local monorepo for the ReachInbox email job scheduler.

## Local startup

```powershell
npm install
npm run infra:up
npm run db:generate
npm run db:migrate
npm run dev
```

Copy `backend/.env.example` to `backend/.env` and `frontend/.env.example` to `frontend/.env.local`.
Configure Google OAuth and Ethereal sender accounts before the complete browser workflow.
