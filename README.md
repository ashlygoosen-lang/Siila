# SIIRA – hiring professional talent

Node.js backend for the SIIRA marketplace: jobs, talent profiles, applications, saved jobs and hire requests.
Express 5 + SQLite (better-sqlite3), JWT auth, zod validation, helmet, CORS, rate limiting.

## Run it
```bash
npm install
cp .env.example .env      # set JWT_SECRET
npm start                 # http://localhost:3000  (site + API)
npm test                  # 10-step smoke test on an in-memory database
```
On first start the database is seeded with 8 jobs, 6 talent profiles and a client.
Demo logins (password `Siira#2026`): `client@siira.test`, `talent1@siira.test` … `talent6@siira.test`.
Set `SEED_DEMO=false` before going live.

The site in `public/index.html` loads jobs and talent from this API (and keeps working with sample data if the API is down).

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
| POST | `/api/jobs/:id/apply` 🔒 talent | `{message}`; one application per job |
| GET | `/api/jobs/:id/applications` 🔒 owner | applicants |
| POST / DELETE | `/api/jobs/:id/save` 🔒 | save / unsave |
| GET | `/api/talent`, `/api/talent/:id` | `?q&province&verified&limit` |
| POST | `/api/talent/:id/hire-request` | `{from_name,from_email,message}` |
| GET | `/api/me/saved`, `/api/me/applications`, `/api/me/jobs` 🔒 | dashboards |
| PUT | `/api/me/profile` 🔒 talent | headline, bio, skills, hourly_rate, province, city |

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
- **Client**: post jobs, review applicants, make offers, fund escrow, approve work, dispute, review, find talent.
- **Professional**: find and save jobs, apply, accept offers, deliver work, profile, verification, earnings, notifications.
- **Everyone**: contract messaging, notifications, POPIA data export and account deletion.

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
- Hire requests are stored but not emailed yet: add your mailer/WhatsApp call in `src/routes/talent.js`.
- Verification badges are set in the database (`profiles.verified`); build an admin review step for ID checks.
- Put `data/` on a persistent disk, or move to Postgres if you expect heavy traffic.
- Payments/escrow are not implemented; integrate a South African provider (e.g. Paystack, PayFast) when ready.
