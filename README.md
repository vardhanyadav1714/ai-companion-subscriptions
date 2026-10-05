# Eva Subscriptions

Subscription entitlement service for Eva AI Companion.

This service is based on the same production concerns as `hans-ai-subscriptions`, but scoped for the AI girlfriend/companion app:

- Google Play Billing verification for Play Store Android subscriptions
- Razorpay subscription checkout support for web/outside-Play flows where policy permits it
- MongoDB persistence for users, plans, subscriptions, payments, and webhook events
- Idempotent webhook processing
- Durable MongoDB confirmation queue with atomic claims, lease recovery, and exponential retries
- Internal API key protection
- Message limits are controlled by the core API. Its ten-message limit remains disabled until `MESSAGE_LIMIT_ENABLED=true`; plan metadata does not enforce a daily paid limit.

## Important Google Play Note

For a Play Store-distributed Android app that sells digital app features or subscriptions, use Google Play Billing unless a policy exception applies. Keep Razorpay for web or non-Play flows only.

## API Flow

```mermaid
flowchart TD
  A[Android app] --> B[AI Companion backend]
  B --> C[Eva Subscriptions service]
  C --> D[(MongoDB)]
  C --> E[Google Play Developer API]
  C --> F[Razorpay API]
  G[Google Play RTDN] --> C
  H[Razorpay Webhook] --> C
```

## Google Play Subscription Flow

```mermaid
sequenceDiagram
  participant App as Android App
  participant API as AI Companion Backend
  participant Subs as Eva Subscriptions
  participant GP as Google Play Developer API
  participant DB as MongoDB

  App->>App: Launch Play Billing purchase
  App->>API: Send productId + purchaseToken
  API->>Subs: POST /subscriptions/confirm/google-play
  Subs->>GP: purchases.subscriptionsv2.get
  GP-->>Subs: SubscriptionPurchaseV2
  Subs->>DB: Upsert subscription entitlement
  Subs-->>API: active/status/limits
  API-->>App: Premium unlocked or pending
```

## Razorpay Flow

```mermaid
sequenceDiagram
  participant API as AI Companion Backend/Web
  participant Subs as Eva Subscriptions
  participant RP as Razorpay
  participant DB as MongoDB

  API->>Subs: POST /subscriptions/checkout/razorpay
  Subs->>RP: Create subscription
  RP-->>Subs: short_url + subscription id
  Subs->>DB: Store created subscription
  Subs-->>API: checkoutUrl
  RP->>Subs: Webhook payment/subscription lifecycle
  Subs->>DB: Idempotent status update
```

## Environment

Copy `.env.example` to `.env` in Coolify and fill:

```env
SUBSCRIPTIONS_API_KEY=replace_with_a_long_random_secret
MONGODB_URI=mongodb://user:password@host:27017/eva_subscriptions
MONGODB_DATABASE=eva_subscriptions

GOOGLE_PLAY_PACKAGE_NAME=com.eva.ai
GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID=eva_premium_monthly
GOOGLE_PLAY_BASE_PLAN_ID=monthly
GOOGLE_PLAY_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
GOOGLE_PLAY_RTDN_TOKEN=replace_with_a_long_random_secret
PLAN_AMOUNT=49900
```

If you store the Google service account as base64, put the base64 string in `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.

## Endpoints

Public:

- `GET /health`
- `GET /api/v1/plans`

Internal backend-only:

- `GET /api/v1/subscriptions/:userId`
- `POST /api/v1/subscriptions/confirm/google-play`
- `POST /api/v1/subscriptions/checkout/razorpay`
- `POST /api/v1/subscriptions/confirm/razorpay`
- `POST /api/v1/subscriptions/sync`

Webhook:

- `POST /api/v1/webhooks/google-play/rtdn?token=<GOOGLE_PLAY_RTDN_TOKEN>`
- `POST /api/v1/webhooks/razorpay`

Queue operations:

- `POST /api/v1/internal/queue/process` (internal key; useful for a manual sweep or health check)

After a subscription or payment is verified, the service writes a `payment_confirmation`
job to MongoDB. The API processes due MongoDB jobs by default with
`QUEUE_WORKER_ENABLED=true`. For a separately monitored worker, set that flag
to `false` on the API and run:

```bash
npm run start:worker
```

The worker POSTs this payload to `PAYMENT_CONFIRMATION_URL` after the entitlement has
been persisted:

```json
{
  "type": "payment_confirmation",
  "data": {
    "eventId": "razorpay:payment:pay_...",
    "userId": "user-id",
    "provider": "razorpay",
    "eventType": "payment.captured",
    "planId": "eva_premium_monthly",
    "active": true,
    "status": "active",
    "amount": 49900,
    "currency": "INR",
    "providerSubscriptionId": "sub_...",
    "currentEnd": "2026-10-20T00:00:00.000Z"
  }
}
```

## Release Setup: INR 499 Monthly

The code supports Google Play, web Razorpay, and Google user-choice billing.
Alternative billing remains disabled until enrollment is approved. The free
message limit remains disabled independently of whether subscriptions are sold.
No real purchase, refund, or provider-console change is performed by the tests.

### Play Console

1. Use the Android package `com.eva.ai` and upload a signed app bundle to an
   internal testing track. Install it through Google Play for billing tests.
2. Create subscription product `eva_premium_monthly`, base plan `monthly`,
   auto-renewing every month. Set the India price to INR 499, enable the intended
   countries, and activate the base plan. No offer is required for this plan.
3. Add license testers and internal-track testers. Test purchase, pending
   payment, restore, cancellation, renewal, expiry, account hold, and refund.
4. Enable the Google Play Android Developer API in the Google Cloud project.
   Create a backend service account and grant it access to Eva in Play Console
   with the order/subscription permissions needed to verify and acknowledge
   purchases. Put its JSON credential in Coolify's private runtime environment,
   as `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`, only on the subscriptions service.
5. Configure RTDN using the topic and authenticated push subscription below.
   Send the Play Console test notification and verify its queue job completes.

The app attaches a SHA-256 account identifier to Play checkout. The service
checks that identifier, persists immutable token ownership, and preserves
ownership across linked replacements and expiry. Old clients lacking an account
identifier use a verified first claim; existing stored ownership still wins.

Configure the Android upload signing key privately using `EVA_UPLOAD_STORE_FILE`,
`EVA_UPLOAD_STORE_PASSWORD`, `EVA_UPLOAD_KEY_ALIAS`, and `EVA_UPLOAD_KEY_PASSWORD`.
The Gradle release config signs the bundle when all four are supplied; a partial
configuration fails immediately. With none supplied, the local release bundle
is unsigned and is only build verification. Do not upload an unsigned bundle or
commit the keystore/passwords. Set `EVA_VERSION_CODE` or `-PevaVersionCode=N` to a
number greater than the latest uploaded version code, and optionally set
`EVA_VERSION_NAME` or `-PevaVersionName=...`.

### Pub/Sub

Create one topic, for example `eva-play-rtdn`, and grant Pub/Sub Publisher on it
to `google-play-developer-notifications@system.gserviceaccount.com`.
Enter `projects/PROJECT_ID/topics/eva-play-rtdn` in Eva's Play Console RTDN setup.
The app currently uses Firebase project `ai-companion-6ab69`; that existing
Google Cloud project is a suitable choice if you administer it.

Create a separate push identity such as
`eva-play-push@PROJECT_ID.iam.gserviceaccount.com`. Configure a push subscription:

```bash
gcloud pubsub subscriptions create eva-play-rtdn-push \
  --project=PROJECT_ID \
  --topic=eva-play-rtdn \
  --push-endpoint=https://billing.merigf.com/api/v1/webhooks/google-play/rtdn \
  --push-auth-service-account=eva-play-push@PROJECT_ID.iam.gserviceaccount.com \
  --push-auth-token-audience=https://billing.merigf.com/api/v1/webhooks/google-play/rtdn \
  --ack-deadline=60
```

The Pub/Sub service agent
`service-PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com` needs
Service Account Token Creator on the push identity, and the administrator
creating the subscription needs permission to act as that identity. Set:

```env
GOOGLE_PLAY_RTDN_AUDIENCE=https://billing.merigf.com/api/v1/webhooks/google-play/rtdn
GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL=eva-play-push@PROJECT_ID.iam.gserviceaccount.com
```

Set both values together. With these configured, the endpoint verifies Google's
JWT signature, audience, service-account email, and verified-email claim. A
query token cannot bypass that verification. The legacy shared query token is
supported only when both OIDC settings are absent. Request URLs and bodies are
not logged by the billing API.

### Razorpay And Alternative Billing

Keep the configured plan `plan_TgMvWQzlmT0eVZ` only if it belongs to the same
Razorpay mode/account as the API keys and has INR 499/month pricing. The service
checks the provider plan before opening checkout. For test mode, create an
equivalent test plan and override the ID with that test plan's ID.

Use this webhook URL:

```text
https://billing.merigf.com/api/v1/webhooks/razorpay
```

Subscribe to subscription lifecycle events, including activated, charged,
pending, halted, cancelled, completed, and updated, plus `payment.captured`,
`payment.failed`, and `refund.processed`. Configure its secret as
`RAZORPAY_WEBHOOK_SECRET`. Enable web checkout with `RAZORPAY_ENABLED=true`
after both API keys, the matching plan, and webhook are configured.

The app's Android payment button launches Google Billing. Once Google has
approved user-choice billing for Eva and the intended countries, enable:

```env
GOOGLE_PLAY_ALTERNATIVE_BILLING_ENABLED=true
```

Build the Android release with `-PalternativeBillingEnabled=true` as well.
Selecting developer billing through Google's screen provides the external
transaction token used for Razorpay checkout. Do not create this token manually.
The backend reports captured initial and renewal payments and processed refunds
through Google's external-transactions API. Set `GOOGLE_PLAY_TAX_RATE_BPS` and
`GOOGLE_PLAY_TAX_REGION` from the actual business tax treatment before enabling
this flow; zero is not a declaration that no tax applies.

### Coolify Connections

Subscriptions API runtime environment:

```env
MONGODB_DATABASE=eva_subscriptions
PLAN_ID=eva_premium_monthly
PLAN_AMOUNT=49900
PLAN_CURRENCY=INR
PLAN_INTERVAL=monthly
GOOGLE_PLAY_PACKAGE_NAME=com.eva.ai
GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID=eva_premium_monthly
GOOGLE_PLAY_BASE_PLAN_ID=monthly
PAYMENT_CONFIRMATION_URL=https://api.merigf.com/internal/payment-confirmation
QUEUE_WORKER_ENABLED=true
```

Also supply `MONGODB_URI`, `SUBSCRIPTIONS_API_KEY`, and
`PAYMENT_CONFIRMATION_TOKEN` privately. The confirmation URL has no `/api/v1`
prefix. Its token authenticates the worker to Eva's core API; it is separate
from Razorpay's webhook secret and Google's credentials.

Core API runtime environment:

```env
SUBSCRIPTIONS_SERVICE_URL=https://billing.merigf.com
MESSAGE_LIMIT_ENABLED=false
RAZORPAY_SUBSCRIPTION_PLAN_ID=plan_TgMvWQzlmT0eVZ
RAZORPAY_SUBSCRIPTION_AMOUNT=49900
RAZORPAY_SUBSCRIPTION_CURRENCY=INR
```

Set `SUBSCRIPTIONS_SERVICE_API_KEY` to the subscriptions service's
`SUBSCRIPTIONS_API_KEY`, and match `PAYMENT_CONFIRMATION_TOKEN` between both
services. The website needs only its core API URL and authentication settings;
never put Razorpay secrets or Google service-account JSON in browser variables.
For payment push notifications, give the core API `FCM_SERVICE_ACCOUNT_JSON`
or `FCM_SERVICE_ACCOUNT_B64` from the same Firebase project used by the app.
For receipt emails, configure `RESEND_API_KEY` and `RESEND_FROM_EMAIL` with a
verified sender domain on the core API. An app-side `google-services.json`
alone does not configure the backend's Firebase Admin credentials.

Redis is optional: MongoDB is the durable job store, and the default API worker
polls it. For a dedicated worker deploy the same image with
`npm run start:worker`, give it the same MongoDB/provider/confirmation settings,
and optionally set `REDIS_URL` for BullMQ dispatch. Disable the API's embedded
worker only after that worker is running. MongoDB atomic claims allow multiple
workers, and expired leases allow recovery after a process crash.
The worker also queues provider reconciliation for stale subscriptions every
15 minutes by default (`RECONCILIATION_INTERVAL_SECONDS=900`). This recovers
state changes after a missed notification. Reconciliation and webhook jobs
share the same durable queue and operator retry controls.

### Operations And Release Evidence

- Run `npm test` and `npm run build`. Integration tests start an isolated MongoDB
  and cover competing ownership claims, token replacement, duplicate events,
  pending purchases, expiry, voided orders, worker claims, cancellation, and
  current-cycle full refunds. They do not access production databases.
- Check `GET /api/v1/internal/queue/status` with the internal key. Investigate
  failed or growing retrying jobs; use `POST /api/v1/internal/queue/:id/retry`
  after fixing the underlying credential or provider issue.
- Keep an authenticated MongoDB deployment and backups. The API waits for its
  subscription, payment, webhook, and queue indexes before accepting requests.
  If old sparse indexes conflict, inspect and apply the existing
  `scripts/migrate-billing-indexes.mjs` migration with the API/worker stopped
  and a verified backup. Do not drop unrelated indexes.
- Confirm actual provider test transactions, acknowledgement, RTDN delivery,
  external reporting, and refunds before enabling live collection. A passing
  local suite cannot verify Play Console permissions or real bank mandates.
- Subscription cancellation preserves the paid period. A full refund of the
  current INR 499 Razorpay cycle revokes that period; syncing cannot restore
  it, while a later paid cycle can. Partial or old-cycle refunds do not revoke
  a newer paid period. Authorization-only payments are not treated as paid
  subscription cycles.
- Payment confirmations re-read the current entitlement in the core API, so
  delayed events cannot restore old access or send stale lifecycle notices.
  Payment receipt emails are sent only for captured/charged Razorpay payments,
  not failure or refund notices. Play issues its own receipts. Known Razorpay
  amounts are recorded; the service does not invent regional Play prices.

Official setup references:
[Play lifecycle](https://developer.android.com/google/play/billing/lifecycle/subscriptions),
[RTDN](https://developer.android.com/google/play/billing/rtdn-reference),
[authenticated Pub/Sub push](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions),
[external transactions](https://developer.android.com/google/play/billing/outside-gpb-backend),
[external refund API](https://developers.google.com/android-publisher/api-ref/rest/v3/externaltransactions/refundexternaltransaction).

For the Eva deployment, point the callback at the backend receiver:

```env
PAYMENT_CONFIRMATION_URL=https://your-eva-api.example.com/internal/payment-confirmation
PAYMENT_CONFIRMATION_TOKEN=the-same-random-secret-in-both-services
```

This URL/token is an Eva internal callback, not a Google Play setting. Failed deliveries
are retried with exponential backoff up to `QUEUE_MAX_ATTEMPTS`; a worker restart or
crash does not lose a claimed job because leases expire.

Set `REDIS_URL` to a managed Redis instance in production. The worker also performs
MongoDB due-job sweeps, so a temporary Redis outage does not lose confirmations.
For local development, `docker compose up --build` starts MongoDB, Redis, the API,
and the worker together.

Google Play verification is configured independently with
`GOOGLE_PLAY_PACKAGE_NAME`, `GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID`,
`GOOGLE_PLAY_BASE_PLAN_ID`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`, and
`GOOGLE_PLAY_RTDN_TOKEN`.

Internal requests must include either:

```text
X-Subscriptions-Key: <SUBSCRIPTIONS_API_KEY>
```

or:

```text
Authorization: Bearer <SUBSCRIPTIONS_API_KEY>
```

## Coolify

Build:

```bash
npm install
npm run build
```

Start:

```bash
npm start
```

Run a second Coolify service from the same image with the start command
`npm run start:worker`. Both services must share the same MongoDB database and queue
environment variables. Do not expose the worker publicly.

Healthcheck:

```text
GET /health
Expected 200
```

## Main Backend Env

Add these to the AI Companion backend when you wire it as the entitlement source:

```env
SUBSCRIPTIONS_SERVICE_ENABLED=true
SUBSCRIPTIONS_SERVICE_URL=https://your-subscriptions-domain.com
SUBSCRIPTIONS_SERVICE_API_KEY=same_value_as_SUBSCRIPTIONS_API_KEY
FREE_MESSAGE_LIMIT=10
PAID_DAILY_MESSAGE_LIMIT=100
```

## Safety

- Do not put `SUBSCRIPTIONS_API_KEY` in the Android app.
- Store service account JSON only in server/Coolify env.
- Verify Google Play purchases on the backend.
- Verify Razorpay webhooks using the raw request body and `RAZORPAY_WEBHOOK_SECRET`.
- Webhook events are idempotent, so duplicate provider retries do not double-grant access.
