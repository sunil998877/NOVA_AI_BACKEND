# NOVA n8n workflow (step by step)

This backend **does not send email**. The app calls `/api/webhook`; Express forwards a **GET** to n8n. n8n should:

1. Receive `campaignId`, `action`, `workMail`
2. Load recipients from this API (`/api/mails`)
3. Append those rows to **Google Sheets**
4. Send Gmail to **all recipients in one workflow run**

```
Frontend / Postman
    → POST or GET /api/webhook   (JWT)
    → n8n Webhook GET + Basic Auth
    → HTTP GET /api/mails
    → Google Sheets append
    → Gmail send (one item per recipient)
```

n8n Cloud **cannot** reach `http://localhost:3000`. For the HTTP Request node you need a **public** API URL (deployed backend or a tunnel such as ngrok).

---

## 1. What this repo already sends to n8n

File: `Backend/src/controllers/Webhook/proxy.controller.js`

- Method: **GET**
- Query: `campaignId`, `action`, `timestamp`, optional `workMail`
- Header: `Authorization: Basic ...` from `N8N_USER` and `N8N_PASSWORD`

Actions:

| `action` | Meaning |
|---|---|
| `start_campaign` | Send first email to all mails |
| `stop_campaign` | Do not send |
| `get_status` | Optional status only |
| `send_followup_1` … `send_followup_4` | Follow-up copy |

n8n Webhook **HTTP Method must be GET**. POST on the n8n node will 404.

**JWT** is only for the **Nova API** (`Authorization: Bearer <jwt>`). Do not put the user login JWT on the n8n Webhook. Use **Basic Auth** on n8n, matching `.env`.

---

## 2. Env vars (`Backend/.env`)

```env
N8N_USER=Nova
N8N_PASSWORD=your_webhook_password
N8N_MAIN_WEBHOOK=https://YOUR-N8N-HOST/webhook/YOUR-PATH-ID
```

Optional (otherwise they use `N8N_MAIN_WEBHOOK`):

```env
N8N_FOLLOWUP_1_WEBHOOK=
N8N_FOLLOWUP_2_WEBHOOK=
N8N_FOLLOWUP_3_WEBHOOK=
N8N_FOLLOWUP_4_WEBHOOK=
```

Copy the **Production** URL from the Webhook node (path `/webhook/...`).  
Do **not** put `/webhook-test/...` here. The test URL only works while the editor is listening.

Sheet used by this project (optional to keep using the same file):

- Spreadsheet ID: from `VITE_GOOGLE_SHEETS_ID` in `.env`
- Tab name: `NOVA` (`VITE_GOOGLE_SHEETS_NAME`)

---

## 3. Google Sheet headers (row 1)

Create or open the spreadsheet, tab **NOVA**:

| campaignId | email | full_name | workMail | action | subject | body | status | sent_at |
|---|---|---|---|---|---|---|---|---|

Share the sheet with the Google account used in n8n (Editor).

---

## 4. Publish vs Test (404 “webhook is not registered”)

New n8n UI uses **Publish** (top right), not always an “Active” switch.

| You click | URL that works | Backend uses it? |
|---|---|---|
| Execute / “Waiting for Test URL” | `/webhook-test/<path>` | **No** |
| **Publish** | `/webhook/<path>` | **Yes** |

If the API returns:

`The requested webhook "GET …" is not registered`

→ Cancel the test wait, click **Publish**, then call `/api/webhook` again.

Production runs appear under **Executions**, not as a live ping on the canvas.

---

## 5. Create the workflow (nodes)

Open your n8n host (example from this repo: `https://damnart-ai-guladab.n8n-wsk.com`) → **Create workflow** → name it `NOVA campaign send`.

### Node 1 — Webhook

1. Add **Webhook**.
2. **HTTP Method:** `GET`
3. **Path:** leave **Fixed** (the UUID is fine). Do not switch to Expression.
4. **Authentication:** `Basic Auth`
5. Credential: user = `N8N_USER`, password = `N8N_PASSWORD`
6. **Respond:** `Immediately` is OK for a first test. After Gmail/Sheets exist, prefer **When Last Node Finishes**.
7. Save. Copy **Production URL** into `N8N_MAIN_WEBHOOK`.

Webhook output query fields (confirm in a test execution):

- `{{ $json.query.campaignId }}`
- `{{ $json.query.action }}`
- `{{ $json.query.workMail }}`

If your n8n version nests JSON differently, pick the fields from the execution panel.

### Node 2 — Switch (optional)

Add **Switch**. Value: `{{ $json.query.action }}`

| Output | Equals |
|---|---|
| start | `start_campaign` |
| follow1 | `send_followup_1` |
| … | … |
| stop | `stop_campaign` |

Build **start** first. Connect Webhook → Switch.

### Node 3 — HTTP Request (all mails)

On the **start** branch, add **HTTP Request**.

| Field | Value |
|---|---|
| Method | `GET` |
| URL | `https://YOUR-PUBLIC-API/api/mails?campaignId={{ $('Webhook').item.json.query.campaignId }}` |
| Header | `Authorization` = `Bearer` + a JWT from `POST /api/auth/signin` |

Response shape: `{ "data": [ { "email", "full_name", "campaign_id", ... } ] }`

`localhost` will fail from n8n Cloud.

### Node 4 — Split Out

- **Field to Split Out:** `data`

Each item is one recipient.

### Node 5 — Edit Fields (Set)

Map:

| Name | Expression |
|---|---|
| campaignId | `{{ $('Webhook').item.json.query.campaignId }}` |
| email | `{{ $json.email }}` |
| full_name | `{{ $json.full_name }}` |
| workMail | `{{ $('Webhook').item.json.query.workMail }}` |
| action | `{{ $('Webhook').item.json.query.action }}` |
| subject | campaign subject (or a test string) |
| body | campaign body (or a test string) |
| status | `queued` |

Subject/body: `/api/google-sheets/*` on this backend is still **501**. Put copy in n8n Variables, another sheet tab, or `GET /api/campaigns/:id` plus your own copy store.

### Node 6 — Google Sheets (save all mails)

- Credential: Google Sheets OAuth2  
- Operation: **Append Row**  
- Document: spreadsheet ID  
- Sheet: `NOVA`  
- Map columns to the Set fields  

Split Out makes **one row per user**.

### Node 7 — Split In Batches (recommended)

- Batch size: `10`  
- After Gmail, loop back into this node until done.  
- Optional **Wait** 2 seconds between batches (Gmail limits).

For 2–3 test emails you can skip this and go straight to Gmail.

### Node 8 — Gmail (send to everyone in one run)

- Credential: Gmail OAuth2 for the campaign **workMail** account  
- Operation: **Send**  
- **To:** `{{ $json.email }}`  
- **Subject:** `{{ $json.subject }}`  
- **Message:** `{{ $json.body }}`  

n8n runs this once per item = all users, one workflow.

### Node 9 — Google Sheets Update (optional)

- Match on `email` (and campaignId if possible)  
- `status` = `sent`  
- `sent_at` = `{{ $now.toISO() }}`

### Node 10 — Publish

**Save** → **Publish**. Workflow must stay published for production URL.

---

## 6. Canvas (start branch)

```
Webhook (GET + Basic Auth)
  → Switch (action)
       start → HTTP GET /api/mails
            → Split Out (data)
            → Set
            → Google Sheets Append
            → Split In Batches
            → Gmail Send
            → Sheets Update status
            → loop batches
       stop / status → (no Gmail)
```

---

## 7. Test from this API

1. Create a campaign: `POST /api/campaigns/create` (JWT).  
2. Add recipients: `POST /api/mails/batch` with `campaignId` and `mails: [{ "email", "full_name" }]`.  
3. Sign in, copy JWT.  
4. Call webhook:

```http
POST http://localhost:3000/api/webhook
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "campaignId": "1",
  "action": "start_campaign",
  "workMail": "you@gmail.com"
}
```

**Only Webhook node published:**

```json
{ "success": true, "data": { "message": "Workflow was started" } }
```

That means the trigger worked. No rows and no inbox until Sheets + Gmail nodes exist and are published.

**Full workflow:** check n8n **Executions**, the Google Sheet, and recipient inboxes.

---

## 8. Quick failures

| Result | Cause |
|---|---|
| `webhook is not registered` / 404 | Not **Published**, or path/method mismatch (must be GET) |
| 401 / 403 from n8n | Basic Auth ≠ `N8N_USER` / `N8N_PASSWORD` |
| 503 `n8n webhook URL is not configured` | Empty `N8N_MAIN_WEBHOOK` |
| HTTP Request node fails | n8n cannot reach localhost; need public API |
| No emails | Gmail node missing, or workflow only has Webhook |
| Gmail quota | Personal Gmail daily cap; use batches |

---

## 9. Follow-ups

Reuse the same workflow with Switch outputs `send_followup_1` … `4` and different subject/body, or set `N8N_FOLLOWUP_*_WEBHOOK` to other webhook URLs.

This API still only forwards `campaignId`, `action`, and `workMail`. n8n must load recipients and send mail.
