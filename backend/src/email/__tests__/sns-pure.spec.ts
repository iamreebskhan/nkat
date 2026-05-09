import {
  buildCanonicalString,
  isAllowedCertUrl,
  isAllowedTopicArn,
  parseSesFeedbackPayload,
  type SnsEnvelope,
} from '../sns-pure';

describe('buildCanonicalString — Notification with Subject', () => {
  const env: SnsEnvelope = {
    Type: 'Notification',
    MessageId: 'mid-1',
    TopicArn: 'arn:aws:sns:us-east-1:123:Topic',
    Subject: 'Amazon SES Email Event Notification',
    Message: '{"notificationType":"Bounce"}',
    Timestamp: '2026-05-06T09:30:15.123Z',
    SignatureVersion: '1',
    Signature: 'XYZ',
    SigningCertURL: 'https://sns.us-east-1.amazonaws.com/x.pem',
  };

  it('includes Subject in the documented field order', () => {
    const c = buildCanonicalString(env);
    expect(c).toBe(
      [
        'Message',
        '{"notificationType":"Bounce"}',
        'MessageId',
        'mid-1',
        'Subject',
        'Amazon SES Email Event Notification',
        'Timestamp',
        '2026-05-06T09:30:15.123Z',
        'TopicArn',
        'arn:aws:sns:us-east-1:123:Topic',
        'Type',
        'Notification',
      ]
        .map((s) => s + '\n')
        .join(''),
    );
  });

  it('omits Subject when not present', () => {
    const { Subject: _drop, ...rest } = env;
    void _drop;
    const c = buildCanonicalString(rest as SnsEnvelope);
    expect(c).not.toContain('Subject');
    expect(c).toContain('MessageId\nmid-1\n');
  });
});

describe('buildCanonicalString — SubscriptionConfirmation', () => {
  it('includes SubscribeURL + Token fields', () => {
    const env: SnsEnvelope = {
      Type: 'SubscriptionConfirmation',
      MessageId: 'mid-2',
      TopicArn: 'arn:t',
      Token: 'tok',
      Message: 'You requested to subscribe',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&...',
      Timestamp: 't',
      SignatureVersion: '1',
      Signature: 'X',
      SigningCertURL: 'https://sns.us-east-1.amazonaws.com/x.pem',
    };
    const c = buildCanonicalString(env);
    expect(c).toContain(
      'SubscribeURL\nhttps://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&...\n',
    );
    expect(c).toContain('Token\ntok\n');
  });
});

describe('isAllowedCertUrl', () => {
  it.each([
    ['https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem', true],
    ['https://sns.eu-west-1.amazonaws.com/x.pem', true],
    ['https://sns.cn-north-1.amazonaws.com.cn/x.pem', true],
    ['http://sns.us-east-1.amazonaws.com/x.pem', false], // not https
    ['https://attacker.com/x.pem', false], // wrong host
    ['https://evil.sns.us-east-1.amazonaws.com/x.pem', false], // subdomain trick
    ['https://sns.us-east-1.amazonaws.com.attacker.com/x.pem', false], // suffix trick
    ['https://sns.us-east-1.amazonaws.com/x.txt', false], // wrong ext
    ['not-a-url', false],
  ])('%s → %s', (url, expected) => {
    expect(isAllowedCertUrl(url)).toBe(expected);
  });
});

describe('isAllowedTopicArn', () => {
  it('only permits configured ARNs', () => {
    const allow = new Set(['arn:a', 'arn:b']);
    expect(isAllowedTopicArn('arn:a', allow)).toBe(true);
    expect(isAllowedTopicArn('arn:c', allow)).toBe(false);
  });
});

describe('parseSesFeedbackPayload — Bounce', () => {
  it('classifies permanent bounce', () => {
    const r = parseSesFeedbackPayload(
      JSON.stringify({
        notificationType: 'Bounce',
        bounce: {
          bounceType: 'Permanent',
          bounceSubType: 'General',
          bouncedRecipients: [{ emailAddress: 'Alice@example.com' }],
        },
      }),
      1_700_000_000_000,
    );
    expect(r).not.toBeNull();
    expect(r!.emails).toEqual(['alice@example.com']);
    expect(r!.reason).toBe('bounce_permanent');
    expect(r!.expiresAt).toBeNull();
    expect(r!.detail).toContain('bounceType=Permanent');
  });

  it('classifies transient bounce with 24h expiry', () => {
    const now = 1_700_000_000_000;
    const r = parseSesFeedbackPayload(
      JSON.stringify({
        notificationType: 'Bounce',
        bounce: {
          bounceType: 'Transient',
          bounceSubType: 'MailboxFull',
          bouncedRecipients: [{ emailAddress: 'b@example.com' }],
        },
      }),
      now,
    );
    expect(r!.reason).toBe('bounce_transient');
    expect(r!.expiresAt!.getTime()).toBe(now + 24 * 3600 * 1000);
  });
});

describe('parseSesFeedbackPayload — Complaint', () => {
  it('classifies complaint, no expiry', () => {
    const r = parseSesFeedbackPayload(
      JSON.stringify({
        notificationType: 'Complaint',
        complaint: {
          complaintFeedbackType: 'abuse',
          complainedRecipients: [{ emailAddress: 'c@example.com' }],
        },
      }),
    );
    expect(r!.reason).toBe('complaint');
    expect(r!.expiresAt).toBeNull();
    expect(r!.detail).toContain('feedbackType=abuse');
  });
});

describe('parseSesFeedbackPayload — guards', () => {
  it('returns null on non-JSON', () => {
    expect(parseSesFeedbackPayload('not json')).toBeNull();
  });
  it('returns null on missing notificationType', () => {
    expect(parseSesFeedbackPayload(JSON.stringify({}))).toBeNull();
  });
  it('returns null on empty bounced recipients', () => {
    expect(
      parseSesFeedbackPayload(
        JSON.stringify({
          notificationType: 'Bounce',
          bounce: { bounceType: 'Permanent', bouncedRecipients: [] },
        }),
      ),
    ).toBeNull();
  });
  it('ignores unknown notification types (e.g. Delivery)', () => {
    expect(parseSesFeedbackPayload(JSON.stringify({ notificationType: 'Delivery' }))).toBeNull();
  });
});
