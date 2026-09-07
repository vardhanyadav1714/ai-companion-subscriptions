# Eva Subscriptions

Subscription entitlement service for Eva AI Companion.

This service is based on the same production concerns as `hans-ai-subscriptions`, but scoped for the AI girlfriend/companion app:

- Google Play Billing verification for Play Store Android subscriptions
- Razorpay subscription checkout support for web/outside-Play flows where policy permits it
- MongoDB persistence for users, plans, subscriptions, payments, and webhook events
- Idempotent webhook processing
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
