import { decodePaResponse, Cms0057PaError } from '../pa-adapter';

describe('decodePaResponse', () => {
  it('returns unknown defaults on an empty response', () => {
    const out = decodePaResponse({}, ['99497']);
    expect(out).toEqual({ pa_required: null, decision: 'unknown', documentation_codes: [] });
  });

  it('reads pa_required=true when the matching item.authorizationRequired is true', () => {
    const out = decodePaResponse(
      {
        outcome: 'complete',
        insurance: [
          {
            item: [
              {
                productOrService: {
                  coding: [{ system: 'http://www.ama-assn.org/go/cpt', code: '99497' }],
                },
                authorizationRequired: true,
              },
            ],
          },
        ],
      },
      ['99497'],
    );
    expect(out.pa_required).toBe(true);
  });

  it('reads pa_required=false when the matching item.authorizationRequired is false', () => {
    const out = decodePaResponse(
      {
        outcome: 'complete',
        insurance: [
          {
            item: [
              { productOrService: { coding: [{ code: '99497' }] }, authorizationRequired: false },
            ],
          },
        ],
      },
      ['99497'],
    );
    expect(out.pa_required).toBe(false);
  });

  it('most-restrictive wins when multiple items match', () => {
    const out = decodePaResponse(
      {
        outcome: 'complete',
        insurance: [
          {
            item: [
              { productOrService: { coding: [{ code: '99497' }] }, authorizationRequired: false },
              { productOrService: { coding: [{ code: '99497' }] }, authorizationRequired: true },
            ],
          },
        ],
      },
      ['99497'],
    );
    expect(out.pa_required).toBe(true);
  });

  it('ignores items whose codes do not match any requested code', () => {
    const out = decodePaResponse(
      {
        insurance: [
          {
            item: [
              { productOrService: { coding: [{ code: '99213' }] }, authorizationRequired: true },
            ],
          },
        ],
      },
      ['99497'],
    );
    expect(out.pa_required).toBeNull();
  });

  it('extracts and dedupes documentation_codes from authorizationSupporting', () => {
    const out = decodePaResponse(
      {
        insurance: [
          {
            item: [
              {
                productOrService: { coding: [{ code: '99497' }] },
                authorizationRequired: true,
                authorizationSupporting: [
                  { coding: [{ system: 'http://loinc.org', code: '52542-3' }] },
                  { coding: [{ system: 'http://loinc.org', code: '52542-3' }] }, // duplicate
                  { coding: [{ system: 'http://loinc.org', code: '11506-3' }] },
                ],
              },
            ],
          },
        ],
      },
      ['99497'],
    );
    expect(out.documentation_codes).toEqual(['11506-3', '52542-3']);
  });

  it('decodes decision from Da Vinci PAS extension when present', () => {
    const out = decodePaResponse(
      {
        insurance: [
          {
            item: [
              {
                productOrService: { coding: [{ code: '99497' }] },
                authorizationRequired: true,
                extension: [
                  {
                    url: 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/extension-decision',
                    valueString: 'Approved',
                  },
                ],
              },
            ],
          },
        ],
      },
      ['99497'],
    );
    expect(out.decision).toBe('approved');
  });

  it('maps outcome=queued to decision=pending', () => {
    const out = decodePaResponse({ outcome: 'queued' }, []);
    expect(out.decision).toBe('pending');
  });

  it('maps outcome=error to decision=unknown', () => {
    const out = decodePaResponse({ outcome: 'error' }, []);
    expect(out.decision).toBe('unknown');
  });

  it('returns sorted documentation codes for stable output', () => {
    const out = decodePaResponse(
      {
        insurance: [
          {
            item: [
              {
                productOrService: { coding: [{ code: '99497' }] },
                authorizationRequired: true,
                authorizationSupporting: [
                  { coding: [{ code: 'Z' }, { code: 'A' }] },
                  { coding: [{ code: 'M' }] },
                ],
              },
            ],
          },
        ],
      },
      ['99497'],
    );
    expect(out.documentation_codes).toEqual(['A', 'M', 'Z']);
  });

  it('respects empty requestedCodes by treating any matching item as eligible', () => {
    const out = decodePaResponse(
      {
        insurance: [
          {
            item: [
              {
                productOrService: { coding: [{ code: '99497' }] },
                authorizationRequired: true,
              },
            ],
          },
        ],
      },
      [],
    );
    // requestedCodes.length === 0 → no filter, item counts.
    expect(out.pa_required).toBe(true);
  });
});

describe('Cms0057PaError', () => {
  it('preserves status and body and is an Error', () => {
    const e = new Cms0057PaError('boom', 502, 'gateway down');
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(502);
    expect(e.body).toBe('gateway down');
  });
});
