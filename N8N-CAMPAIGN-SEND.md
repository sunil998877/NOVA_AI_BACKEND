# Campaign send → n8n SMTP (POST)

## App flow

```
Frontend Send
  → POST /api/campaigns/:campaignId/send   (JWT)
  → Backend loads mails, sets status=processing
  → POST N8N_WEBHOOK_URL  JSON {
        campaignId, subject, body, html,
        senderEmail: "nova@yourdomain.com",
        senderName: "NOVA AI",
        from: "\"NOVA AI\" <nova@yourdomain.com>",
        recipients: [{ id, email, full_name, subject, body, html }],
        data: [...], accessToken, apiBaseUrl
      }
  → n8n Split Out on `recipients` → Loop Over Items → Send Email (SMTP)
  → PATCH /api/mails/:id  (Bearer accessToken: delivery_status="sent" or "failed")
  → PATCH /api/campaigns/:id/status  (when Loop done: status="completed")
```

**Important:** Use a **POST** Webhook in n8n. The single fixed sender is always `NOVA AI <nova@yourdomain.com>`. All SMTP credentials (Host, Port, User, Pass, SSL/TLS) are configured securely inside n8n credentials and are **never** stored in campaigns or exposed to the frontend.

## Env

```env
N8N_WEBHOOK_URL=https://YOUR-N8N-HOST/webhook/YOUR-PATH
N8N_WEBHOOK_METHOD=POST
N8N_USER=Nova
N8N_PASSWORD=your_password
PUBLIC_API_URL=https://your-public-api-or-ngrok
NOVA_SENDER_EMAIL=nova@yourdomain.com
NOVA_SENDER_NAME=NOVA AI
```

## Ready Workflow File
You can directly import `Backend/n8n-smtp-workflow.json` into your n8n workspace.

## n8n Webhook node

| Setting | Value |
|---|---|
| HTTP Method | **POST** |
| Authentication | Basic Auth (`N8N_USER` / `N8N_PASSWORD`) |
| Path | `nova-campaign-send` (or your chosen path) |
| Respond | Immediately or When Last Node Finishes |

### POST body (from Nova)

```json
{
  "campaignId": 6,
  "senderEmail": "nova@yourdomain.com",
  "senderName": "NOVA AI",
  "from": "\"NOVA AI\" <nova@yourdomain.com>",
  "subject": "...",
  "body": "...",
  "html": "<html>...</html>",
  "action": "start_campaign",
  "totalRecipients": 2,
  "accessToken": "<short-lived JWT for callbacks>",
  "apiBaseUrl": "https://your-api",
  "recipients": [{ "id": 1, "email": "user1@example.com", "full_name": "User", "subject": "...", "body": "...", "html": "..." }],
  "data": [...]
}
```

## Split Out & Loop Over Items

- **Split Out Node:** Field to Split Out: `recipients` (or `body.recipients`)
- **Loop Over Items (Split In Batches):** Batch size: `1`

## Send Email Node (SMTP)

| Field | Value |
|---|---|
| Credential | **SMTP account** (securely created in n8n credentials) |
| From Email | `NOVA AI <{{ $('Webhook').item.json.body.senderEmail || 'nova@yourdomain.com' }}>` |
| To Email | `{{ $json.email }}` |
| Subject | `{{ $json.subject }}` |
| HTML | `{{ $json.html || $json.body }}` |
| Text | `{{ $json.body }}` |
| Ignore SSL Issues | As appropriate for your SMTP host |
| Continue on Fail | **true** (prevents one bad email from halting entire campaign) |

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
