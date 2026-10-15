# Trackr.

**Your career search, organised.**

Trackr is a portfolio-ready graduate/internship application tracker with a CRM-style pipeline, dashboard analytics, interview/contact/document views, and intelligent email-driven stage updates.

## Run it

You only need Node.js (Node 18+ recommended).

```bash
node server.js
```

Then open:

```text
http://localhost:3000
```

No `npm install` is required.

## What works immediately

- Dashboard and application statistics
- Add, update and delete applications
- Pipeline stages: Saved → Applying → Applied → Assessment → Interview → Final Stage → Offer / Rejected
- Contacts, documents, interviews and analytics views
- Persistent local JSON storage (`data.json`)
- Email intelligence demo: paste a recruitment email and Trackr detects application confirmations, assessments, interviews, final stages, offers and rejections
- High-confidence messages automatically update matching applications
- Review queue support for uncertain email classifications

## Real Gmail connection

Trackr includes a real Gmail OAuth + Gmail API implementation without external npm packages.

Create a Google Cloud OAuth 2.0 Web Client and enable the Gmail API. Then set these environment variables before running Trackr:

```bash
GOOGLE_CLIENT_ID="your-client-id"
GOOGLE_CLIENT_SECRET="your-client-secret"
GOOGLE_REDIRECT_URI="http://localhost:3000/api/gmail/callback"
node server.js
```

On Windows Command Prompt:

```bat
set GOOGLE_CLIENT_ID=your-client-id
set GOOGLE_CLIENT_SECRET=your-client-secret
set GOOGLE_REDIRECT_URI=http://localhost:3000/api/gmail/callback
node server.js
```

In your Google OAuth client, add this authorised redirect URI:

```text
http://localhost:3000/api/gmail/callback
```

Then open Trackr → **Email Sync** → **Connect Gmail**.

Trackr requests the read-only Gmail scope and keeps OAuth tokens server-side in `data.json`.

## Live Gmail push updates (optional production setup)

For true push notifications rather than manual syncing, Gmail uses Google Cloud Pub/Sub.

Set:

```bash
GOOGLE_PUBSUB_TOPIC="projects/YOUR_PROJECT/topics/trackr-gmail"
PUBLIC_BASE_URL="https://your-public-trackr-domain.com"
WEBHOOK_TOKEN="choose-a-random-secret"
```

Configure your Pub/Sub push subscription endpoint as:

```text
https://your-public-trackr-domain.com/api/gmail/push?token=YOUR_WEBHOOK_TOKEN
```

The Gmail connection flow will call `users.watch` when `GOOGLE_PUBSUB_TOPIC` is present. Gmail watches expire and should be renewed periodically in a production deployment.

## Important privacy note

This is a portfolio project. If you release Trackr publicly, use a proper encrypted database or secrets store for refresh tokens rather than storing them in `data.json`, add user accounts so each user has isolated data, complete Google's OAuth verification requirements as applicable, and implement a production security/privacy review.
