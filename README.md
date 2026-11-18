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

## Before launch
- Set `NODE_ENV=production`, a strong `JWT_SECRET` and `CORS_ORIGIN`; serve behind HTTPS.
- Hire requests are stored but not emailed yet: add your mailer/WhatsApp call in `src/routes/talent.js`.
- Verification badges are set in the database (`profiles.verified`); build an admin review step for ID checks.
- Put `data/` on a persistent disk, or move to Postgres if you expect heavy traffic.
- Payments/escrow are not implemented; integrate a South African provider (e.g. Paystack, PayFast) when ready.
