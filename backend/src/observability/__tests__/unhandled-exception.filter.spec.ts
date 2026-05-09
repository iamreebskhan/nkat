import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { UnhandledExceptionFilter } from '../unhandled-exception.filter';

interface CapturedReport {
  error: unknown;
  severity?: string;
  context?: Record<string, unknown>;
}

class FakeReporter {
  events: CapturedReport[] = [];
  capture(e: CapturedReport) {
    this.events.push(e);
  }
  async flush() {}
}

class FakeMetrics {
  incs: Array<{ name: string; tags?: Record<string, string | number> }> = [];
  increment(name: string, _value?: number, tags?: Record<string, string | number>) {
    this.incs.push({ name, tags });
  }
  gauge() {}
  histogram() {}
  timing() {}
}

interface FakeRes {
  status: jest.Mock;
  json: jest.Mock;
  headersSent: boolean;
}

function makeHost(
  opts: {
    path?: string;
    method?: string;
    auth?: { orgId?: string; userId?: string };
    query?: Record<string, unknown>;
  } = {},
) {
  const res: FakeRes = { status: jest.fn().mockReturnThis(), json: jest.fn(), headersSent: false };
  const req = {
    path: opts.path ?? '/v1/x',
    method: opts.method ?? 'GET',
    auth: opts.auth,
    query: opts.query ?? {},
    route: undefined,
  };
  return {
    res,
    req,
    host: {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
    },
  };
}

describe('UnhandledExceptionFilter', () => {
  it('reports + emits 500 on a non-HttpException', () => {
    const reporter = new FakeReporter();
    const metrics = new FakeMetrics();
    const f = new UnhandledExceptionFilter(reporter, metrics as never);
    const { host, res } = makeHost({ path: '/v1/foo', method: 'POST' });
    f.catch(new Error('kaboom'), host as never);

    expect(reporter.events).toHaveLength(1);
    expect((reporter.events[0].error as Error).message).toBe('kaboom');
    expect(reporter.events[0].severity).toBe('error');
    expect(reporter.events[0].context?.path).toBe('/v1/foo');

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    });
    expect(metrics.incs[0].name).toBe('billing_rules.unhandled_exception');
    expect(metrics.incs[0].tags).toMatchObject({ status: '500' });
  });

  it('passes through HttpException 4xx WITHOUT reporting', () => {
    const reporter = new FakeReporter();
    const f = new UnhandledExceptionFilter(reporter);
    const { host, res } = makeHost();
    f.catch(new BadRequestException({ code: 'BAD_THING' }), host as never);

    expect(reporter.events).toHaveLength(0);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ code: 'BAD_THING' });
  });

  it('reports HttpException 5xx (programmer-error 503)', () => {
    const reporter = new FakeReporter();
    const f = new UnhandledExceptionFilter(reporter);
    const { host, res } = makeHost();
    f.catch(new HttpException({ code: 'STRIPE_DOWN' }, 503), host as never);

    expect(reporter.events).toHaveLength(1);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('synthesizes a code field on a HttpException whose payload has none', () => {
    const reporter = new FakeReporter();
    const f = new UnhandledExceptionFilter(reporter);
    const { host, res } = makeHost();
    f.catch(new NotFoundException({ detail: 'gone' }), host as never);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ code: 'NOT_FOUND', detail: 'gone' });
  });

  it('handles a string payload on HttpException (Nest wraps with statusCode + error)', () => {
    const reporter = new FakeReporter();
    const f = new UnhandledExceptionFilter(reporter);
    const { host, res } = makeHost();
    f.catch(new BadRequestException('bad'), host as never);
    // Nest's `new BadRequestException('bad')` auto-wraps to
    // `{statusCode: 400, message: 'bad', error: 'Bad Request'}`. The
    // filter preserves the full payload and synthesizes a `code` key.
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'BAD_REQUEST', message: 'bad' }),
    );
  });

  it('captures auth context (orgId/userId) without leaking it to the response', () => {
    const reporter = new FakeReporter();
    const f = new UnhandledExceptionFilter(reporter);
    const { host, res } = makeHost({
      auth: { orgId: 'o-uuid', userId: 'u-uuid' },
    });
    f.catch(new Error('x'), host as never);
    expect(reporter.events[0].context?.orgId).toBe('o-uuid');
    expect(reporter.events[0].context?.userId).toBe('u-uuid');
    // Response body MUST NOT include those fields.
    const body = res.json.mock.calls[0][0];
    expect(body.orgId).toBeUndefined();
    expect(body.userId).toBeUndefined();
  });

  it('does not double-write when headers are already sent', () => {
    const reporter = new FakeReporter();
    const f = new UnhandledExceptionFilter(reporter);
    const { host, res } = makeHost();
    res.headersSent = true;
    f.catch(new Error('mid-stream'), host as never);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    // The error is still reported.
    expect(reporter.events).toHaveLength(1);
  });
});
