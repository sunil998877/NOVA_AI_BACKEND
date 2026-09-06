┌─────────────────────────────────────────────────────────┐
│  Frontend (Dashboard, Crafter, Influencers, Campaigns)  │
└──────────────────────────┬──────────────────────────────┘
                           │ JWT
                           ▼
┌─────────────────────────────────────────────────────────┐
│  This backend (Express + MySQL)                         │
│  users, campaigns, mails, conversations, audit          │
│  OpenAI (NOVA copy)                                     │
│  /api/webhook → n8n GET + Basic Auth                    │
└────────────┬───────────────────────────┬────────────────┘
             │                           │
             ▼                           ▼
      ┌─────────────┐            ┌──────────────┐
      │ OpenAI      │            │ n8n (WebSpaceKit)
      │ draft copy  │            │ Sheets + Gmail send
      └─────────────┘            └──────────────┘
                                        │
                                        ▼
                                   Recipients’ inbox
                                   From: campaign workMail