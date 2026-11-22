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

### PayFast (recommended)
Set `PAYMENTS_MODE=payfast`. The client is sent to PayFast's secure page (card, Instant EFT and the other methods on your PayFast account).
PayFast then posts an ITN to `/api/webhooks/payfast`; the contract is marked funded only after all four checks pass:
the MD5 signature (with your passphrase), the request coming from a PayFast server (DNS of www/sandbox/w1w/w2w.payfast.co.za),
the amount matching the contract, and PayFast confirming the data at `/eng/query/validate`. Repeated ITNs are harmless.

1. Test: create a free sandbox account at https://sandbox.payfast.co.za, set a passphrase in it (Settings > Developer settings) and set
   `PAYFAST_SANDBOX=true`, `PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY`, `PAYFAST_PASSPHRASE`. Then open `/api/payfast/selftest`:
   it sends a R5 sandbox payment and shows whether the ITN was verified on your server. (PayFast's shared demo account rejects signed requests.)
2. Go live: in the PayFast dashboard set a passphrase (Settings > Developer settings), then set `PAYFAST_MERCHANT_ID`,
   `PAYFAST_MERCHANT_KEY`, `PAYFAST_PASSPHRASE`, `PAYFAST_SANDBOX=false` and `APP_URL=https://your-domain`.
PayFast's transaction fees are deducted from your PayFast settlement, not from the client or the professional.

Other modes: `manual` (client pays by EFT with a reference, an admin confirms receipt), `sandbox` (simulated, development), `paystack`.
Payouts to professionals are paid by you (EFT) and then recorded in the dashboard; payouts are held automatically for open fraud flags,
recent bank changes and AML reviews.

## South Africa checklist (confirm each with an attorney or accountant)
- Register the company (CIPC), tax number and, when you pass the threshold, VAT with SARS.
- POPIA: appoint an Information Officer and register with the Information Regulator; publish a Privacy Policy. Sign-up already records consent.
- Publish Terms of Use and company details on the site (ECTA / Consumer Protection Act).
- Employment services: introducing people to jobs may require registration as a private employment agency with the Department of Employment and Labour. Get advice before launch.
- Holding client money in escrow: use a payment provider's escrow/split features or a dedicated trust account, and get advice on the rules that apply.
- Keep financial records (5 years) and add backups for the database.

## Before launch
The admin overview shows a **Launch checklist** that reads your live settings; the server also prints it on start-up in production.
- Railway: add a **Volume** to the service (e.g. mount `/data`). The app detects it and keeps the database, uploads, backups and keys there.
  `railway.json` sets the health check (`/api/health`) and restart policy. Run a single instance (SQLite).
- Set `NODE_ENV=production`, `APP_URL`, a strong `JWT_SECRET` (`openssl rand -hex 48`) and `SEED_DEMO=false`.
- Set `DATA_KEY` (`openssl rand -hex 32`) and back it up offline. It encrypts identity documents, ID numbers and bank details.
- Configure SMTP so verification, password-reset and notification emails are delivered.
- Set `COMPANY_ADDRESS`, `INFO_OFFICER`, `SUPPORT_PHONE` (and `VAT_NUMBER`) so the legal pages and invoices are complete.
- Payments: PayFast as above. Copy the daily backups off-site regularly.

## Remote work

- **Escrow-first remote jobs.** A remote job is created as `awaiting_funding` and stays hidden until the client pays at least one pay period at the top of the budget (project, one month, five days or a 40-hour week) into escrow, through PayFast, EFT (admin confirms) or the sandbox. Offers must fit within the balance, an accepted offer is paid from it at once, and the client can ask for the unused balance back (admin records the refund under Payments & escrow).
- **International companies.** Sign-up takes a country, a display currency and a company name. Prices are always charged in rand; other currencies are shown for reference using daily rates from ExchangeRate-API (`/api/fx`, cached).
- **Partner listings.** `src/remotefeed.js` pulls remote jobs from Remotive, Jobicy and Arbeitnow at most every six hours, stores them in `feed_jobs`, credits the source on every listing and links to the original posting. Public page: `/remote.html`; professionals get suggested remote jobs from their skills (`/api/remote/suggestions`).
