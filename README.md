# Eva Subscriptions

Subscription entitlement service for Eva AI Companion.

This service is based on the same production concerns as `hans-ai-subscriptions`, but scoped for the AI girlfriend/companion app:

- Google Play Billing verification for Play Store Android subscriptions
- Razorpay subscription checkout support for web/outside-Play flows where policy permits it
- MongoDB persistence for users, plans, subscriptions, payments, and webhook events
- Idempotent webhook processing
- Durable MongoDB confirmation queue with atomic claims, lease recovery, and exponential retries
- Internal API key protection
- Free and paid message limits: 10 free messages, 100 paid messages/day

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
job to MongoDB. Run the worker as a separate process so webhook requests stay fast:

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
