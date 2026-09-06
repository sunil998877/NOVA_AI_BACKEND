# NovaAI Backend

AI-powered email marketing API for **NOVA : EMAIL MARKETER**. Users sign up, create **campaigns**, NOVA writes the email copy, and **n8n** sends mail from the user’s Gmail (`workMail`).

This repo is the backend only. The frontend (Dashboard, Message Crafter, Find Influencers, Your Campaigns) calls these APIs.

## What it does

1. User signs up or signs in (**email/password** or **Google Auth**)
2. User data is stored in **MySQL**
3. User creates a **campaign** (name, sender mailbox, schedule)
4. NOVA (OpenAI) writes the first email and 4 follow-ups
5. Recipients / influencers are stored as mails
6. Optional: campaign copy is synced to Google Sheets
7. Starting a campaign calls n8n, which sends from Gmail
8. Dashboard stats show total, delivered, and opened emails

A **campaign** is one outreach job: sender, copy, recipient list, schedule, and follow-up sequence — not a single email.

## Architecture

```
Frontend (signup, Google login, dashboard)
    ↓
Express API (this repo)
    ↓
┌───────────┬──────────┬──────────────┬─────────┐
│ MySQL     │ OpenAI   │ Google Sheets│  n8n    │
│ users +   │ NOVA copy│ subject/body │  Gmail  │
│ campaigns │          │              │         │
└───────────┴──────────┴──────────────┴─────────┘
```

**This backend does not send email.** It forwards `campaignId`, `workMail`, and `action` to n8n. Recipients see mail **from the campaign `workMail`**, not from NovaAI.

`N8N_USER` and `N8N_PASSWORD` are HTTP Basic Auth for the n8n webhook. They are **not** Gmail credentials.

## Auth (signup form + Google)

The signup screen collects:

| Field | Required | Notes |
|---|---|---|
| Full name | Yes | Stored on the user |
| Organization | Yes | Used in email signature |
| Email address | Yes | Unique login |
| Password | Yes | Hashed in MySQL |
| Confirm password | Yes | Must match password |
| reCAPTCHA | Yes | “I’m not a robot” |
| **Sign in with Google** | Optional | Same user collection, `googleId` |

After login, the API returns a **JWT**. Protected routes use:

```
Authorization: Bearer <jwt>
```

Google Auth flow:

1. Frontend Google button returns an ID token
2. `POST /api/auth/google` with `{ "idToken": "..." }`
3. Backend verifies the token with `GOOGLE_CLIENT_ID`
4. User is created or linked in MySQL
5. API returns the same JWT shape as email login

## MySQL tables

| Table | Purpose |
|---|---|
| `users` | `fullName`, `organization`, `email`, `passwordHash`, `googleId`, `authProvider` |
| `campaigns` | `id`, `title`, `workMail`, `followups`, `camp_status`, `scheduledDate`, `status`, `user_id` |
| `mails` | Recipients: `campaign_id`, `status`, `open_count`, `sent_at` |
| `conversations` / `messages` | NOVA chat (expire after 15 days) |
| `audit_logs` | `user_id`, `action`, `resource_id`, `ip_address` |

## Tech stack

| Layer | Tool |
|---|---|
| API | Node.js, Express |
| Database | MySQL |
| Auth | Email/password + Google OAuth + JWT + reCAPTCHA |
| Email copy | OpenAI Assistants (NOVA) |
| Content sheet | Google Sheets API |
| Sending | n8n → Gmail |

Default port: **3001**.

## Project structure

```
server.ts                 # App entry: auth, OpenAI, Sheets, mails, webhooks
routes/campaigns.ts       # Campaign CRUD
routes/stat.ts            # Performance stats
lib/openai.ts             # NOVA + follow-up generation
lib/audit.ts              # Audit logging
middleware/auth.ts        # Bearer token check
functions/webhook.js      # Optional Netlify webhook proxy
README.md                 # This file
```

## Setup

### 1. Install

```bash
npm install
```

### 2. Environment variables

Create a `.env` file in the project root:

```env
PORT=3001
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:5173

# MySQL
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=nova_ai

# JWT (email/password + Google sessions)
JWT_SECRET=

# Google Auth (OAuth client ID from Google Cloud Console)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# OpenAI (NOVA)
OPENAI_API_KEY=
OPENAI_ASSISTANT_ID=
OPENAI_FOLLOWUP_ASSISTANT_ID=

# Signup CAPTCHA
RECAPTCHA_SECRET_KEY=

# n8n (webhook Basic Auth — not Gmail)
N8N_USER=
N8N_PASSWORD=

# Google Sheets (optional)
GOOGLE_SHEETS_ID=
GOOGLE_SHEETS_NAME=
GCP_PROJECT_ID=
GCP_PRIVATE_KEY_ID=
GCP_PRIVATE_KEY=
GCP_CLIENT_EMAIL=
GCP_CLIENT_ID=
```

### 3. Run MySQL

Make sure MySQL Server is running locally, then create the database:

```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS nova_ai;"
```

Or connect to a remote MySQL host and set the credentials in your `.env`.

### 4. Google Auth (Google Cloud Console)

1. Create an OAuth 2.0 Client ID (Web application)
2. Add authorized JavaScript origins (e.g. `http://localhost:5173`)
3. Add authorized redirect URIs if you use a redirect flow
4. Put the client ID in `GOOGLE_CLIENT_ID`

### 5. Start the API

```bash
npm run dev      # development (nodemon + tsx)
npm run build    # compile to dist/
npm start        # production: node dist/server.js
```

Health checks:

- `GET /health` → `Backend is running`
- `GET /api/health` → `{ "ok": true }`

## Product workflow (UI)

```
Find Influencers → My Influencers → Message Crafter → Add Email Campaign → Dashboard
```

1. **Sign up / Google login** — full name, organization, email, password, CAPTCHA
2. **Find Influencers** — search people to contact
3. **My Influencers** — saved recipient list
4. **Message Crafter** — NOVA writes subject, body, follow-ups
5. **+ Add Email Campaign** — `workMail` is the Gmail From address
6. **Dashboard** — campaigns, mails, delivered, opened

You do not need a fixed number of influencers. Use 2–3 to test sending, then scale (Gmail daily limits apply).

## API overview

Protected routes need:

```
Authorization: Bearer <jwt>
```

### Auth

| Method | Path | Body |
|---|---|---|
| POST | `/api/auth/signup` | `fullName`, `organization`, `email`, `password`, `confirmPassword`, `captchaToken` |
| POST | `/api/auth/signin` | `email`, `password`, `captchaToken` |
| POST | `/api/auth/google` | `idToken` |
| POST | `/api/auth/reset-password` | `email`, `redirectTo` |
| POST | `/api/auth/update-user` | `attributes` (name, organization, password) |
| POST | `/api/auth/signout` | Client discards the JWT |

Signup passwords must match. Google users are stored in the same `users` collection.

### Campaigns

| Method | Path |
|---|---|
| GET | `/api/campaigns/list` |
| GET | `/api/campaigns/:id` |
| POST | `/api/campaigns/create` |
| PUT / PATCH | `/api/campaigns/:id` |
| DELETE | `/api/campaigns/:id` |

Create body (minimum): `title` or `campaign_name`, optional `workMail`, `scheduledDate`, `followups`, `status`.

### OpenAI

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/openai/generate-message` | Draft email (`conversationId` required) |
| POST | `/api/openai/generate-followups` | 4 follow-ups from original subject + body |

Rate limit: 100 requests per IP per 15 minutes.

### Conversations

| Method | Path |
|---|---|
| POST | `/api/conversations` |
| GET | `/api/conversations` |
| GET | `/api/conversations/:id/messages` |
| POST | `/api/conversations/:id/messages` |
| PATCH | `/api/conversations/:id` |
| DELETE | `/api/conversations/:id` |
| POST | `/api/conversations/cleanup` |

### Mails (recipients)

| Method | Path |
|---|---|
| GET | `/api/mails` |
| POST | `/api/mails/batch` |
| DELETE | `/api/mails/campaign/:id` |

### Google Sheets

| Method | Path |
|---|---|
| POST | `/api/google-sheets/append-campaign` |
| POST | `/api/google-sheets/update-followups` |
| POST | `/api/google-sheets/get-campaign` |
| POST | `/api/google-sheets/get-existing-followups` |

### Sending (n8n proxy)

| Method | Path |
|---|---|
| GET / POST | `/api/webhook` |

Query or body: `campaignId`, `action`, optional `workMail`, `timestamp`.

Actions: `start_campaign`, `stop_campaign`, `get_status`, `send_followup_1` … `send_followup_4`.

### Stats

| Method | Path |
|---|---|
| GET | `/api/stats/performance` |

Returns `total`, `delivered`, `opened`, `campaigns`.

## Rebuild order

Do not start with Gmail sending.

| Phase | Build |
|---|---|
| 0 | Express + `/health` |
| 1 | MySQL connection + `users` table |
| 2 | Email/password signup (form fields + CAPTCHA) + JWT |
| 3 | Google Auth |
| 4 | Campaigns + mails + audit |
| 5 | NOVA + conversations |
| 6 | n8n + Gmail |
| 7 | Dashboard stats |

## Gmail notes

- Gmail is the **From** address (`workMail`), sent by **n8n**, not by this API
- `N8N_USER` / `N8N_PASSWORD` only protect the n8n webhook
- Test with a few recipients before sending ~100
- Personal Gmail daily caps are low; count follow-ups too

## Scripts

```bash
npm run dev
npm run build
npm start
```
# NOVA_AI
# NOVA_AI_BACKEND
