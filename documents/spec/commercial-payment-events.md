# Signed sandbox payment evidence

`POST /api/commercial-events/stripe-test` verifies the raw body using the official
Stripe SDK, endpoint signature and five-minute timestamp tolerance. It requires
the configured test endpoint secret and expected provider account, and rejects
live events. No Stripe API key or outbound payment request is used.

Only `payment_intent.succeeded` is currently supported. The signed metadata must
bind the contract UUID, owner UUID and quote hash. The current owner must exist,
the quote must be accepted_unpaid, and received JPY must exactly equal the stored
monthly quote with no one-time fees. Caller-supplied paid flags are never used.

The event ledger stores only identifiers, body digest, amount and event type,
not the body, credentials or payment method. Account/event identity is unique;
identical redelivery is acknowledged, changed content conflicts. Resource locks
serialize concurrent deliveries and retirement. The ledger cascades with the
contract and account. Out-of-order evidence does not mutate entitlements.

This is sandbox payment evidence intake, not completed payment fulfillment.
Contracts remain accepted_unpaid with paid and entitlementsGranted false.
Refund and cancellation events are rejected until their product authorization
and period policies are implemented. Duplicate refunds cannot be executed here
because this endpoint never performs a refund.

Verification so far uses locally signed synthetic events through real HTTP and
PostgreSQL. Official sandbox delivery is not yet verified. The current explicit
event.account requirement also needs reconciliation with direct-account events,
which may omit a Connect account field. `PASSSHARE_STRIPE_TEST_ENDPOINT_SCOPE`
defaults to `connect`, which requires exact event.account equality. Explicit
`direct` scope requires event.account to be absent/null and rejects Connect
events even from the configured account. In direct mode, account provenance
comes from the dedicated endpoint secret provisioned in that verified account's
sandbox, not from caller metadata or an omitted field. Never share a secret
between accounts or endpoint scopes. The Dashboard's “Your account” selection
must be recorded before direct provisioning. Do not configure production intake or
claim provider integration success until the actual endpoint scope is verified.

References: https://docs.stripe.com/webhooks and
https://docs.stripe.com/events/manage-webhook-endpoints.
