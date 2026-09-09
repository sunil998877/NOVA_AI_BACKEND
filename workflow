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
       │ OpenAI      │            │ n8n
       │ draft copy  │            │ Loop + SMTP Send Email
       └─────────────┘            └──────────────┘
                                         │
                                         ▼
                                    Recipients’ inbox
                                    From: NOVA AI <nova@yourdomain.com>