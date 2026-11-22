# TalentBridge – hiring professional talent

TalentBridge is a South African freelance marketplace in the style of Freelancer.com: clients post jobs, professionals bid with a price and timeline, both sides chat in a live inbox, and payment runs through escrow with optional milestones.
Express 5 + SQLite (better-sqlite3), JWT auth, zod validation, helmet, CORS, rate limiting.

## Run it
```bash
npm install
cp .env.example .env      # set JWT_SECRET
npm start                 # http://localhost:3000  (site + API)
npm test                  # 16-step smoke test on an in-memory database
```
On first start the database is seeded with 8 jobs, 6 talent profiles and a client.
Demo logins (password `TalentBridge#2026`): `client@talentbridge.test`, `talent1@talentbridge.test` … `talent6@talentbridge.test`.
Set `SEED_DEMO=false` before going live.

The site in `public/index.html` loads everything from this API: categories, live activity, jobs, professionals, stats and fees. Nothing is hard-coded, so it always shows real data (with a retry message if the API can't be reached).

## Live updates
Signed-in dashboards keep one connection to `GET /api/me/stream` (Server-Sent Events, sent with the `Authorization` header). The server pushes `notification`, `message`, `counts`, `read`, `typing` and `bids` events, so new bids, offers, acceptances, payments and chat messages appear instantly without refreshing. If the connection drops, the dashboard reconnects automatically and polls counters in the meantime.

On a proxy such as Nginx, turn off response buffering for that path (the server already sends `X-Accel-Buffering: no`). Railway works without changes.

## Endpoints (JSON, `Authorization: Bearer <token>` where marked 🔒)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/health`, `/api/meta`, `/api/stats` | status, provinces/categories/types, counts |
| POST | `/api/auth/register` | `{name,email,password,role:'talent'|'client',province?}` |
| POST | `/api/auth/login` | returns `{token,user}` |
| GET | `/api/auth/me` 🔒 | current user |
| GET | `/api/jobs` | `?q&type&category&province&page&limit` |
| GET | `/api/jobs/:id` | |
| POST | `/api/jobs` 🔒 client | create job |
| PATCH / DELETE | `/api/jobs/:id` 🔒 owner | `{status:'open'|'closed'}` / delete |
| POST / PUT / DELETE | `/api/jobs/:id/apply` 🔒 talent | place, edit or withdraw a bid `{bid_amount,delivery_days,message}` |
| GET | `/api/jobs/:id/applications` 🔒 owner | bids, `?sort=price|rating|fast` |
| PATCH | `/api/jobs/:id/applications/:aid` 🔒 owner | shortlist / decline a bid |
| POST | `/api/jobs/:id/applications/:aid/chat` 🔒 owner | open a chat with a bidder |
| POST / DELETE | `/api/jobs/:id/save` 🔒 | save / unsave |
| GET | `/api/talent`, `/api/talent/:id` | `?q&province&verified&limit` |
| POST | `/api/talent/:id/hire-request` | `{from_name,from_email,message}` |
| GET | `/api/me/saved`, `/api/me/applications`, `/api/me/jobs` 🔒 | dashboards |
| PUT | `/api/me/profile` 🔒 talent | headline, bio, skills, hourly_rate, province, city, languages, portfolio |
| GET | `/api/me/feed` 🔒 | dashboard activity feed, to-do items, recommended jobs or latest bids |
| GET | `/api/me/stream` 🔒 | live events (SSE) |
| GET | `/api/me/counts` 🔒 | unread notifications and inbox messages |
| GET / POST | `/api/inbox` 🔒 | conversations / start one `{user_id,job_id?,body?}` |
| GET | `/api/inbox/:id` 🔒 | thread with `?before=` paging |
| POST | `/api/inbox/:id/messages` 🔒 | multipart: `body` and optional `file` (PDF, image, DOCX, ZIP, 10 MB) |
| POST | `/api/inbox/:id/read`, `/api/inbox/:id/typing` 🔒 | read receipts, typing indicator |
| POST | `/api/contracts` 🔒 client | offer, from a bid with `application_id`, optional `milestones[]` |
| POST | `/api/contracts/:id/milestones/:mid/submit` / `approve` 🔒 | milestone progress |
| POST | `/api/talent/:id/message` 🔒 client | message a professional directly |
| GET | `/api/pulse` | public live activity for the homepage |

## What is included
Public site (`/`), Terms (`/terms.html`), Privacy (`/privacy.html`), dashboards (`/app.html`), REST API (`/api`), SEO (`robots.txt`, `sitemap.xml`), 404 page.
Accounts with email verification and password reset, role-based access, document upload for ID checks (deleted after review), contracts with escrow and fees, invoices, accountant CSV export, notifications by email and in-app, contact inbox, audit log, daily backups, graceful shutdown, Dockerfile, CI.

## Email
Set `SMTP_*` and `MAIL_FROM` (any SMTP service works, for example Brevo, Mailgun or Amazon SES). Without SMTP, verification and reset emails are never delivered, so people cannot activate accounts. Posting jobs, applying and making offers require a verified email.

## CI
Copy `docs/ci.yml.example` to `.github/workflows/ci.yml` to run the tests on every push. GitHub only lets you add that file with a token that has the `workflow` scope, or through the GitHub website.

## Backups
In production the database is copied to `<data dir>/backups` daily (last 14 kept). That is on the same disk, so also copy it off-site regularly (`npm run backup` creates one on demand).

## Dashboards (`/app.html`)
One login page, three workspaces based on the account role.
- **Admin**: KPIs (volume, revenue, VAT, escrow), ID verification queue, payments and escrow (confirm EFT, resolve disputes, record payouts), reports, job moderation, users (suspend), hire enquiries, fee settings, audit log.
- **Hirer (client)**: home feed of bids, offers and payments as they happen; post jobs; compare and sort bids; shortlist, decline, chat, award with milestones; fund escrow, approve milestones and work; dispute; review; find and message talent.
- **Professional**: home feed with offers, messages and jobs matching their skills; find work; bid, edit or withdraw; accept offers; complete milestones; deliver; profile with portfolio and languages; verification; earnings.
- **Everyone**: live two-pane inbox (files, read receipts, typing, contract timeline lines), notification bell, POPIA data export and account deletion.

Create the first admin with `ADMIN_EMAIL` / `ADMIN_PASSWORD` (see `.env.example`).

## Money flow
Offer → professional accepts → client funds escrow → work delivered → client approves → payout recorded by admin.
The commission (default 10%) and VAT on it (default 15%) are deducted from the professional's payout and stored on every contract.
`PAYMENTS_MODE=manual` (production default): client pays by EFT with a reference, an admin confirms receipt. `paystack`: card/EFT checkout; set `PAYSTACK_SECRET` and point the Paystack webhook to `/api/webhooks/paystack`.
Payouts to professionals are paid by you (EFT) and then recorded in the dashboard.

## South Africa checklist (confirm each with an attorney or accountant)
- Register the company (CIPC), tax number and, when you pass the threshold, VAT with SARS.
- POPIA: appoint an Information Officer and register with the Information Regulator; publish a Privacy Policy. Sign-up already records consent.
- Publish Terms of Use and company details on the site (ECTA / Consumer Protection Act).
- Employment services: introducing people to jobs may require registration as a private employment agency with the Department of Employment and Labour. Get advice before launch.
- Holding client money in escrow: use a payment provider's escrow/split features or a dedicated trust account, and get advice on the rules that apply.
- Keep financial records (5 years) and add backups for the database.

## Before launch
- Set `NODE_ENV=production`, a strong `JWT_SECRET` and `CORS_ORIGIN`; serve behind HTTPS.
- Set `DATA_KEY` (`openssl rand -hex 32`) and back it up. It encrypts identity documents, ID numbers and bank details; without it they cannot be read. If unset, a key is generated next to the database as `.data_key`, so keep the database volume and that file together.
- Hire requests are stored but not emailed yet: add your mailer/WhatsApp call in `src/routes/talent.js`.
- Verification badges are set in the database (`profiles.verified`); build an admin review step for ID checks.
- Put `data/` on a persistent disk, or move to Postgres if you expect heavy traffic.
- Payments/escrow are not implemented; integrate a South African provider (e.g. Paystack, PayFast) when ready.
