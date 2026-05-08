import { StripeApiClient, StripeApiError } from '../stripe-api-client';

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const SUB_FIXTURE = {
  id: 'sub_1',
  customer: 'cus_1',
  status: 'active',
  current_period_start: 1_700_000_000,
  current_period_end: 1_702_592_000,
  trial_end: null,
  cancel_at_period_end: false,
  metadata: {
    org_id: '11111111-1111-4111-8111-111111111111',
    tier: 'org',
    seats: '15',
  },
};

describe('StripeApiClient', () => {
  it('throws on construction without apiKey', () => {
    expect(() => new StripeApiClient({ apiKey: '' })).toThrow(/apiKey is required/);
  });

  it('retrieveSubscription performs an authorized GET', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(SUB_FIXTURE));
    const client = new StripeApiClient({ apiKey: 'sk_test_xxx', fetchImpl: fetchMock });
    const r = await client.retrieveSubscription('sub_1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/subscriptions/sub_1');
    expect(init.method).toBe('GET');
    expect(init.headers.authorization).toBe('Bearer sk_test_xxx');
    expect(init.headers['stripe-version']).toBeDefined();

    expect(r.id).toBe('sub_1');
    expect(r.customer).toBe('cus_1');
    expect(r.status).toBe('active');
    expect(r.metadata.tier).toBe('org');
    expect(r.metadata.seats).toBe('15');
  });

  it('retrieveSubscription URL-encodes the id', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(SUB_FIXTURE));
    const client = new StripeApiClient({ apiKey: 'k', fetchImpl: fetchMock });
    await client.retrieveSubscription('sub with space');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.stripe.com/v1/subscriptions/sub%20with%20space',
    );
  });

  it('throws StripeApiError on non-2xx', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse({ error: 'not_found' }, 404));
    const client = new StripeApiClient({ apiKey: 'k', fetchImpl: fetchMock });
    await expect(client.retrieveSubscription('sub_x')).rejects.toBeInstanceOf(StripeApiError);
  });

  it('updateSubscriptionSeats POSTs proration form-encoded', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse({ ...SUB_FIXTURE, metadata: { ...SUB_FIXTURE.metadata, seats: '25' } }));
    const client = new StripeApiClient({ apiKey: 'k', fetchImpl: fetchMock });
    await client.updateSubscriptionSeats({
      subscriptionId: 'sub_1',
      subscriptionItemId: 'si_1',
      quantity: 25,
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const body = String(init.body);
    expect(body).toContain('items%5B0%5D%5Bid%5D=si_1');
    expect(body).toContain('items%5B0%5D%5Bquantity%5D=25');
    expect(body).toContain('proration_behavior=create_prorations');
  });

  it('updateSubscriptionSeats with prorate=false sets proration_behavior=none', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(SUB_FIXTURE));
    const client = new StripeApiClient({ apiKey: 'k', fetchImpl: fetchMock });
    await client.updateSubscriptionSeats({
      subscriptionId: 'sub_1',
      subscriptionItemId: 'si_1',
      quantity: 8,
      prorate: false,
    });
    const body = String(fetchMock.mock.calls[0][1].body);
    expect(body).toContain('proration_behavior=none');
  });

  it('retrieveInvoice returns the small typed slice we use', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      mockResponse({
        id: 'in_1',
        subscription: 'sub_1',
        status: 'paid',
        amount_paid: 5900,
        amount_due: 0,
        extra: 'ignored',
      }),
    );
    const client = new StripeApiClient({ apiKey: 'k', fetchImpl: fetchMock });
    const r = await client.retrieveInvoice('in_1');
    expect(r.id).toBe('in_1');
    expect(r.subscription).toBe('sub_1');
    expect(r.amount_paid).toBe(5900);
  });

  it('createCheckoutSession POSTs price + quantity + URLs + metadata', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      mockResponse({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/cs_test_1' }),
    );
    const client = new StripeApiClient({ apiKey: 'k', fetchImpl: fetchMock });
    const r = await client.createCheckoutSession({
      priceId: 'price_team',
      quantity: 5,
      successUrl: 'https://app.example.com/onboarding/success',
      cancelUrl: 'https://app.example.com/onboarding/cancel',
      orgId: '11111111-1111-4111-8111-111111111111',
      tier: 'team',
      states: ['OH', 'NC'],
      specialty_packs: ['palliative'],
      trialDays: 14,
      customerEmail: 'admin@customer.com',
    });

    expect(r.id).toBe('cs_test_1');
    expect(r.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(init.method).toBe('POST');
    const body = String(init.body);
    expect(body).toContain('mode=subscription');
    expect(body).toContain('line_items%5B0%5D%5Bprice%5D=price_team');
    expect(body).toContain('line_items%5B0%5D%5Bquantity%5D=5');
    expect(body).toContain('metadata%5Borg_id%5D=11111111-1111-4111-8111-111111111111');
    expect(body).toContain('subscription_data%5Bmetadata%5D%5Btier%5D=team');
    expect(body).toContain('subscription_data%5Bmetadata%5D%5Bseats%5D=5');
    expect(body).toContain('subscription_data%5Bmetadata%5D%5Bstates%5D=OH%2CNC');
    expect(body).toContain('subscription_data%5Bmetadata%5D%5Bspecialty_packs%5D=palliative');
    expect(body).toContain('subscription_data%5Btrial_period_days%5D=14');
    expect(body).toContain('customer_email=admin%40customer.com');
    expect(body).toContain('billing_address_collection=required');
    expect(body).toContain('allow_promotion_codes=true');
  });

  it('createCheckoutSession forwards Idempotency-Key when supplied', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse({ id: 'cs_idem', url: 'https://x' }));
    const client = new StripeApiClient({ apiKey: 'k', fetchImpl: fetchMock });
    await client.createCheckoutSession({
      priceId: 'price_team',
      quantity: 5,
      successUrl: 'https://x/y',
      cancelUrl: 'https://x/z',
      orgId: '11111111-1111-4111-8111-111111111111',
      tier: 'team',
      idempotencyKey: 'client-retry-abc-1234',
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('client-retry-abc-1234');
  });

  it('createCheckoutSession omits Idempotency-Key when not supplied', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse({ id: 'cs_x', url: 'https://x' }));
    const client = new StripeApiClient({ apiKey: 'k', fetchImpl: fetchMock });
    await client.createCheckoutSession({
      priceId: 'p',
      quantity: 1,
      successUrl: 'https://x/y',
      cancelUrl: 'https://x/z',
      orgId: '11111111-1111-4111-8111-111111111111',
      tier: 'solo',
    });
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect('idempotency-key' in headers).toBe(false);
  });

  it('updateSubscriptionSeats forwards Idempotency-Key', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse(SUB_FIXTURE));
    const client = new StripeApiClient({ apiKey: 'k', fetchImpl: fetchMock });
    await client.updateSubscriptionSeats({
      subscriptionId: 'sub_1',
      subscriptionItemId: 'si_1',
      quantity: 8,
      idempotencyKey: 'seats-retry-xyz-1234',
    });
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('seats-retry-xyz-1234');
  });

  it('createPortalSession forwards Idempotency-Key', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      mockResponse({ id: 'bps_x', url: 'https://x', expires_at: 0 }),
    );
    const client = new StripeApiClient({ apiKey: 'k', fetchImpl: fetchMock });
    await client.createPortalSession({
      customerId: 'cus_x',
      returnUrl: 'https://x',
      idempotencyKey: 'portal-retry-abc-1234',
    });
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('portal-retry-abc-1234');
  });

  it('createCheckoutSession omits trial + email + states when not provided', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      mockResponse({ id: 'cs_2', url: 'https://checkout.stripe.com/c/cs_2' }),
    );
    const client = new StripeApiClient({ apiKey: 'k', fetchImpl: fetchMock });
    await client.createCheckoutSession({
      priceId: 'price_solo',
      quantity: 1,
      successUrl: 'https://x/y',
      cancelUrl: 'https://x/z',
      orgId: '11111111-1111-4111-8111-111111111111',
      tier: 'solo',
    });
    const body = String(fetchMock.mock.calls[0][1].body);
    expect(body).not.toContain('trial_period_days');
    expect(body).not.toContain('customer_email');
    expect(body).not.toContain('states');
    expect(body).not.toContain('specialty_packs');
  });

  it('createPortalSession POSTs customer + return_url, returns url', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      mockResponse({ id: 'bps_1', url: 'https://billing.stripe.com/session_xyz', expires_at: 1_700_000_900 }),
    );
    const client = new StripeApiClient({ apiKey: 'k', fetchImpl: fetchMock });
    const r = await client.createPortalSession({
      customerId: 'cus_1',
      returnUrl: 'https://app.example.com/settings',
    });
    expect(r.id).toBe('bps_1');
    expect(r.url).toMatch(/^https:\/\/billing\.stripe\.com\//);
    expect(r.expires_at).toBe(1_700_000_900);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/billing_portal/sessions');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toContain('customer=cus_1');
    expect(String(init.body)).toContain('return_url=https');
  });

  it('createTestClock POSTs frozen_time + optional name', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse({ id: 'clock_1', status: 'ready' }));
    const client = new StripeApiClient({ apiKey: 'k', fetchImpl: fetchMock });
    const r = await client.createTestClock({ frozenTime: 1_700_000_000, name: 'rehearsal' });
    expect(r).toEqual({ id: 'clock_1', status: 'ready' });
    const body = String(fetchMock.mock.calls[0][1].body);
    expect(body).toContain('frozen_time=1700000000');
    expect(body).toContain('name=rehearsal');
  });

  it('advanceTestClock POSTs to /advance', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse({ id: 'clock_1', status: 'advancing' }));
    const client = new StripeApiClient({ apiKey: 'k', fetchImpl: fetchMock });
    const r = await client.advanceTestClock({ id: 'clock_1', frozenTime: 1_701_000_000 });
    expect(r.status).toBe('advancing');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.stripe.com/v1/test_helpers/test_clocks/clock_1/advance');
  });

  it('deleteTestClock DELETEs and returns { id, deleted }', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse({ id: 'clock_1', deleted: true }));
    const client = new StripeApiClient({ apiKey: 'k', fetchImpl: fetchMock });
    const r = await client.deleteTestClock('clock_1');
    expect(r).toEqual({ id: 'clock_1', deleted: true });
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });

  it('constructEvent throws — verification belongs in stripe-hmac.ts', () => {
    const client = new StripeApiClient({ apiKey: 'k' });
    expect(() => client.constructEvent('{}', 'sig')).toThrow(/stripe-hmac/);
  });
});
