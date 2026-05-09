/**
 * StripeApiClient — thin HTTP-only adapter for the subset of Stripe's REST
 * API the billing module needs. Uses `fetch` (Node 22+) and form-encoded
 * bodies per Stripe's contract; no SDK dependency, so the production
 * import graph stays clean and unit tests stub `fetch` directly.
 *
 * Coverage (deliberately narrow):
 *   - retrieveSubscription(id)           GET /v1/subscriptions/:id
 *   - retrieveInvoice(id)                GET /v1/invoices/:id
 *   - updateSubscriptionSeats(id, qty)   POST /v1/subscriptions/:id  (proration_behavior=create_prorations)
 *
 * What we DON'T do here:
 *   - Webhook signature verification — that's `stripe-hmac.ts` (no SDK).
 *   - Customer / Price / Product CRUD — done out-of-band by ops at signup.
 *   - PaymentMethod / SetupIntent — handled by Stripe Checkout/Portal in the
 *     UI; we never see card data.
 */
import type { StripeClient, StripeEventLike, StripeSubscriptionLike } from './billing-types';

export interface StripeApiClientOptions {
  /** sk_live_... or sk_test_... */
  apiKey: string;
  /** override fetch for tests */
  fetchImpl?: typeof globalThis.fetch;
  /** override base URL for tests */
  baseUrl?: string;
}

const STRIPE_BASE = 'https://api.stripe.com';
const STRIPE_VERSION = '2024-06-20';

export class StripeApiClient implements StripeClient {
  private readonly apiKey: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly baseUrl: string;

  constructor(opts: StripeApiClientOptions) {
    if (!opts.apiKey) {
      throw new Error('StripeApiClient: apiKey is required');
    }
    this.apiKey = opts.apiKey;
    this.fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = opts.baseUrl ?? STRIPE_BASE;
  }

  /**
   * Webhook verification stays in `stripe-hmac.ts`. This method is here only
   * to satisfy the abstract `StripeClient` contract; production code never
   * calls it through this adapter.
   */
  constructEvent(_rawBody: string, _signatureHeader: string): StripeEventLike {
    throw new Error('Use verifyStripeSignature from stripe-hmac.ts instead');
  }

  async retrieveSubscription(id: string): Promise<StripeSubscriptionLike> {
    const r = await this.get(`/v1/subscriptions/${encodeURIComponent(id)}`);
    return toSubscriptionLike(r);
  }

  /**
   * Stripe Test Clocks let stage rehearsal time-travel a customer's
   * subscription forward to verify trial-end transitions, dunning,
   * renewal, and cancellation behavior without waiting wall-clock days.
   * These methods are no-op'd in prod by ops policy (we never construct
   * a clock against `sk_live_...`); they exist for stage scripts only.
   */
  async createTestClock(args: {
    frozenTime: number;
    name?: string;
  }): Promise<{ id: string; status: string }> {
    const body = new URLSearchParams();
    body.set('frozen_time', String(args.frozenTime));
    if (args.name) body.set('name', args.name);
    const r = (await this.post('/v1/test_helpers/test_clocks', body)) as Record<string, unknown>;
    return { id: String(r.id), status: String(r.status) };
  }

  async advanceTestClock(args: {
    id: string;
    frozenTime: number;
  }): Promise<{ id: string; status: string }> {
    const body = new URLSearchParams();
    body.set('frozen_time', String(args.frozenTime));
    const r = (await this.post(
      `/v1/test_helpers/test_clocks/${encodeURIComponent(args.id)}/advance`,
      body,
    )) as Record<string, unknown>;
    return { id: String(r.id), status: String(r.status) };
  }

  async deleteTestClock(id: string): Promise<{ id: string; deleted: boolean }> {
    const r = await this.fetch(
      `${this.baseUrl}/v1/test_helpers/test_clocks/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
        headers: this.headers(),
      },
    );
    if (!r.ok) {
      const text = await r.text();
      throw new StripeApiError(r.status, `/v1/test_helpers/test_clocks/${id}`, text);
    }
    const j = (await r.json()) as Record<string, unknown>;
    return { id: String(j.id), deleted: Boolean(j.deleted) };
  }

  async retrieveInvoice(id: string): Promise<{
    id: string;
    subscription: string | null;
    status: string;
    amount_paid: number;
    amount_due: number;
  }> {
    const r = (await this.get(`/v1/invoices/${encodeURIComponent(id)}`)) as Record<string, unknown>;
    return {
      id: String(r.id),
      subscription: typeof r.subscription === 'string' ? r.subscription : null,
      status: String(r.status),
      amount_paid: typeof r.amount_paid === 'number' ? r.amount_paid : 0,
      amount_due: typeof r.amount_due === 'number' ? r.amount_due : 0,
    };
  }

  /**
   * Create a Stripe Checkout session for self-serve onboarding. Single
   * recurring price per tier; the seat count is supplied as the line-item
   * `quantity`. Stripe collects payment method + creates the Customer +
   * Subscription server-side, and emits `checkout.session.completed`
   * + `customer.subscription.created` webhooks our existing pipeline
   * already handles.
   *
   * `metadata.org_id` is stamped onto the session AND the subscription
   * (via subscription_data.metadata) so our webhook controller can route
   * the resulting subscription back to the correct tenant — webhook
   * bodies are untrusted, but Stripe-shipped metadata is the contract.
   */
  async createCheckoutSession(args: {
    priceId: string;
    quantity: number;
    successUrl: string;
    cancelUrl: string;
    customerEmail?: string;
    orgId: string;
    tier: string;
    states?: string[];
    specialty_packs?: string[];
    trialDays?: number;
    idempotencyKey?: string;
  }): Promise<{ id: string; url: string }> {
    const body = new URLSearchParams();
    body.set('mode', 'subscription');
    body.set('line_items[0][price]', args.priceId);
    body.set('line_items[0][quantity]', String(args.quantity));
    body.set('success_url', args.successUrl);
    body.set('cancel_url', args.cancelUrl);
    body.set('metadata[org_id]', args.orgId);
    body.set('subscription_data[metadata][org_id]', args.orgId);
    body.set('subscription_data[metadata][tier]', args.tier);
    body.set('subscription_data[metadata][seats]', String(args.quantity));
    if (args.states && args.states.length > 0) {
      body.set('subscription_data[metadata][states]', args.states.join(','));
    }
    if (args.specialty_packs && args.specialty_packs.length > 0) {
      body.set('subscription_data[metadata][specialty_packs]', args.specialty_packs.join(','));
    }
    if (args.customerEmail) body.set('customer_email', args.customerEmail);
    if (args.trialDays && args.trialDays > 0) {
      body.set('subscription_data[trial_period_days]', String(args.trialDays));
    }
    body.set('billing_address_collection', 'required');
    body.set('allow_promotion_codes', 'true');

    const r = (await this.post('/v1/checkout/sessions', body, args.idempotencyKey)) as Record<
      string,
      unknown
    >;
    return { id: String(r.id), url: String(r.url) };
  }

  /**
   * Create a Stripe Billing Customer Portal session. The portal lets the
   * customer update payment methods, view invoices, and manage their
   * subscription within a Stripe-hosted UI we don't have to build. We
   * pass the customer id + a return URL; Stripe replies with `url`.
   */
  async createPortalSession(args: {
    customerId: string;
    returnUrl: string;
    idempotencyKey?: string;
  }): Promise<{ id: string; url: string; expires_at: number }> {
    const body = new URLSearchParams();
    body.set('customer', args.customerId);
    body.set('return_url', args.returnUrl);
    const r = (await this.post('/v1/billing_portal/sessions', body, args.idempotencyKey)) as Record<
      string,
      unknown
    >;
    return {
      id: String(r.id),
      url: String(r.url),
      expires_at: Number(r.expires_at ?? 0),
    };
  }

  async updateSubscriptionSeats(args: {
    subscriptionId: string;
    subscriptionItemId: string;
    quantity: number;
    prorate?: boolean;
    idempotencyKey?: string;
  }): Promise<StripeSubscriptionLike> {
    const body = new URLSearchParams();
    body.set(`items[0][id]`, args.subscriptionItemId);
    body.set(`items[0][quantity]`, String(args.quantity));
    body.set('proration_behavior', args.prorate === false ? 'none' : 'create_prorations');
    const r = await this.post(
      `/v1/subscriptions/${encodeURIComponent(args.subscriptionId)}`,
      body,
      args.idempotencyKey,
    );
    return toSubscriptionLike(r);
  }

  // -------------------------------------------------------------------------
  // HTTP plumbing
  // -------------------------------------------------------------------------

  private async get(path: string): Promise<unknown> {
    const r = await this.fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: this.headers(),
    });
    return this.handle(r, path);
  }

  /**
   * `idempotencyKey` is forwarded to Stripe in the `Idempotency-Key`
   * header. Stripe guarantees that a retried POST with the same key
   * returns the same response within a 24h window — we surface that
   * guarantee end-to-end so a customer's transport-level retry against
   * our `POST /v1/admin/billing/seats` produces ONE Stripe-side seat
   * change instead of two.
   *
   * Per Stripe spec: keys must be 64..255 chars. Our internal validator
   * already requires 8..255, so we send the caller's key verbatim and
   * let Stripe reject if it's malformed.
   */
  private async post(
    path: string,
    body: URLSearchParams,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const r = await this.fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        ...this.headers(),
        'content-type': 'application/x-www-form-urlencoded',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: body.toString(),
    });
    return this.handle(r, path);
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`,
      'stripe-version': STRIPE_VERSION,
      accept: 'application/json',
    };
  }

  private async handle(r: Response, path: string): Promise<unknown> {
    if (!r.ok) {
      const text = await r.text();
      throw new StripeApiError(r.status, path, text);
    }
    return r.json();
  }
}

export class StripeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`Stripe API ${status} on ${path}: ${body.slice(0, 200)}`);
    this.name = 'StripeApiError';
  }
}

function toSubscriptionLike(raw: unknown): StripeSubscriptionLike {
  const r = raw as Record<string, unknown>;
  const md = (r.metadata ?? {}) as Record<string, unknown>;
  return {
    id: String(r.id),
    customer: typeof r.customer === 'string' ? r.customer : '',
    status: r.status as StripeSubscriptionLike['status'],
    current_period_start: Number(r.current_period_start),
    current_period_end: Number(r.current_period_end),
    trial_end: r.trial_end == null ? null : Number(r.trial_end),
    cancel_at_period_end: Boolean(r.cancel_at_period_end),
    metadata: Object.fromEntries(Object.entries(md).map(([k, v]) => [k, String(v ?? '')])),
  };
}
