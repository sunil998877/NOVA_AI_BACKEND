# Campaign send → n8n (POST)

## App flow

```
Frontend Send
  → POST /api/campaigns/:campaignId/send   (JWT)
  → Backend loads mails, sets status=processing
  → POST N8N_WEBHOOK_URL  JSON {
        campaignId, subject, body, workMail,
        recipients: [{ id, email, full_name }],
        data: [...], accessToken, apiBaseUrl
      }
  → n8n Split Out on `data` or `recipients` → Loop → Gmail
  → PATCH /api/mails/:id  (Bearer accessToken or n8n Basic Auth)
  → PATCH /api/campaigns/:id/status  (when done)
```

**Important:** Use a **POST** Webhook in n8n. GET cannot carry recipients or email body, so Gmail never gets anyone to send to.

## Env

```env
N8N_WEBHOOK_URL=https://YOUR-N8N-HOST/webhook/YOUR-PATH
N8N_WEBHOOK_METHOD=POST
N8N_USER=Nova
N8N_PASSWORD=your_password
PUBLIC_API_URL=https://your-public-api-or-ngrok
```

`N8N_MAIN_WEBHOOK` still works as a fallback.

## n8n Webhook node

| Setting | Value |
|---|---|
| HTTP Method | **POST** (required for recipients + body) |
| Authentication | Basic Auth (`N8N_USER` / `N8N_PASSWORD`) |
| Path | your production path |
| Respond | Immediately or When Last Node Finishes |

### POST body (from Nova)

```json
{
  "campaignId": 6,
  "workMail": "you@gmail.com",
  "subject": "...",
  "body": "...",
  "action": "start_campaign",
  "totalRecipients": 2,
  "accessToken": "<short-lived JWT for callbacks>",
  "apiBaseUrl": "https://your-api",
  "recipients": [{ "id": 1, "email": "a@x.com", "full_name": "" }],
  "data": [{ "id": 1, "email": "a@x.com", "full_name": "", "campaign_id": 6, "subject": "...", "body": "..." }]
}
```

Read fields as `{{ $json.body.subject }}` / `{{ $json.subject }}` depending on n8n version.

## Split Out (preferred — no HTTP back to API)

**Field to Split Out:** `data` (or `recipients`)  
→ one item per recipient. Gmail To = `{{ $json.email }}`.

## Optional HTTP Request — fetch recipients

Only needed if you keep a GET webhook (not recommended):

| Field | Value |
|---|---|
| Method | GET |
| URL | `{{ $json.apiBaseUrl }}/api/mails/campaign/{{ $json.campaignId }}` |
| Header | `Authorization: Bearer {{ $json.accessToken }}` |

## Gmail (loop branch)

| Field | Value |
|---|---|
| To | `{{ $json.email }}` |
| Subject | `{{ $('Webhook').item.json.body.subject }}` or `{{ $json.subject }}` |
| Message | `{{ $('Webhook').item.json.body.body }}` or `{{ $json.body }}` |

One recipient per iteration — never put all emails in To.

## Per-recipient tracking

`PATCH {{ $json.apiBaseUrl || 'https://YOUR-API' }}/api/mails/{{ $json.id }}`

Header: `Authorization: Bearer {{ $('Webhook').item.json.body.accessToken }}`

Success:

```json
{ "status": true, "delivery_status": "sent", "sent_at": "2026-09-03T12:00:00.000Z" }
```

Failure:

```json
{ "failed": true, "delivery_status": "failed" }
```

## Final campaign status (done branch)

`PATCH .../api/campaigns/{{ campaignId }}/status`

```json
{
  "campaignId": 6,
  "total": 100,
  "sent": 95,
  "failed": 5,
  "status": "completed"
}
```

If n8n never calls this, the UI stays on **Processing**. Then either:

1. Add the PATCH on the Loop **done** branch (preferred), or  
2. In NOVA click **Mark completed** → `POST /api/campaigns/:id/complete`

Listing campaigns also auto-reconciles when every mail is already `sent` / `failed`.

## Publish

Workflow must be **Published**. App uses production `/webhook/...`, not test listen mode.
