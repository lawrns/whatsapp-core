import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyMetaSignature,
  verifyMetaChallenge,
  verifyTwilioSignature,
} from '../src/webhooks.js';

// ── Meta X-Hub-Signature-256 ────────────────────────────────────────────────

const META_SECRET = 'meta-app-secret';
const META_BODY = JSON.stringify({ entry: [{ id: '1' }] });

function metaSig(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('verifyMetaSignature — pass', () => {
  it('accepts a correct sha256= signature', () => {
    expect(verifyMetaSignature(META_BODY, metaSig(META_BODY, META_SECRET), META_SECRET)).toBe(true);
  });

  it('accepts a signature without the sha256= prefix', () => {
    const hex = createHmac('sha256', META_SECRET).update(META_BODY, 'utf8').digest('hex');
    expect(verifyMetaSignature(META_BODY, hex, META_SECRET)).toBe(true);
  });

  it('accepts case-insensitive hex', () => {
    const sig = metaSig(META_BODY, META_SECRET).toUpperCase();
    expect(verifyMetaSignature(META_BODY, sig, META_SECRET)).toBe(true);
  });
});

describe('verifyMetaSignature — fail-closed', () => {
  it('rejects a wrong signature', () => {
    expect(verifyMetaSignature(META_BODY, metaSig(META_BODY, 'other-secret'), META_SECRET)).toBe(false);
  });

  it('rejects a tampered body', () => {
    const sig = metaSig(META_BODY, META_SECRET);
    expect(verifyMetaSignature(META_BODY + 'x', sig, META_SECRET)).toBe(false);
  });

  it('rejects when secret is missing/empty', () => {
    const sig = metaSig(META_BODY, META_SECRET);
    expect(verifyMetaSignature(META_BODY, sig, '')).toBe(false);
    expect(verifyMetaSignature(META_BODY, sig, undefined)).toBe(false);
    expect(verifyMetaSignature(META_BODY, sig, null)).toBe(false);
  });

  it('rejects when signature header is missing/empty', () => {
    expect(verifyMetaSignature(META_BODY, '', META_SECRET)).toBe(false);
    expect(verifyMetaSignature(META_BODY, 'sha256=', META_SECRET)).toBe(false);
    expect(verifyMetaSignature(META_BODY, null, META_SECRET)).toBe(false);
    expect(verifyMetaSignature(META_BODY, undefined, META_SECRET)).toBe(false);
  });

  it('rejects a malformed (length-mismatched) signature without throwing', () => {
    expect(verifyMetaSignature(META_BODY, 'sha256=deadbeef', META_SECRET)).toBe(false);
  });
});

describe('verifyMetaChallenge', () => {
  it('echoes the challenge on a valid subscribe handshake', () => {
    expect(
      verifyMetaChallenge({ mode: 'subscribe', token: 'vt', challenge: 'C123' }, 'vt')
    ).toBe('C123');
  });

  it('rejects a wrong verify token', () => {
    expect(
      verifyMetaChallenge({ mode: 'subscribe', token: 'bad', challenge: 'C123' }, 'vt')
    ).toBeNull();
  });

  it('rejects a non-subscribe mode', () => {
    expect(
      verifyMetaChallenge({ mode: 'unsubscribe', token: 'vt', challenge: 'C123' }, 'vt')
    ).toBeNull();
  });

  it('fails closed when verify token is unset', () => {
    expect(
      verifyMetaChallenge({ mode: 'subscribe', token: 'vt', challenge: 'C123' }, '')
    ).toBeNull();
  });
});

// ── Twilio X-Twilio-Signature ───────────────────────────────────────────────

const TWILIO_TOKEN = '12345678901234567890123456789012';
const TWILIO_URL = 'https://example.com/webhooks/whatsapp';
const TWILIO_PARAMS = {
  Body: 'Hola',
  From: 'whatsapp:+5215512345678',
  To: 'whatsapp:+14155238886',
  MessageSid: 'SM123',
};

/** Reference impl of Twilio's signing algorithm, per their docs. */
function twilioSig(
  token: string,
  url: string,
  params: Record<string, string>
): string {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }
  return createHmac('sha1', token).update(data, 'utf8').digest('base64');
}

describe('verifyTwilioSignature — pass', () => {
  it('accepts a correctly computed signature', () => {
    const sig = twilioSig(TWILIO_TOKEN, TWILIO_URL, TWILIO_PARAMS);
    expect(verifyTwilioSignature(TWILIO_TOKEN, TWILIO_URL, TWILIO_PARAMS, sig)).toBe(true);
  });

  it('is order-independent on params (keys are sorted)', () => {
    const shuffled = {
      To: 'whatsapp:+14155238886',
      MessageSid: 'SM123',
      Body: 'Hola',
      From: 'whatsapp:+5215512345678',
    };
    const sig = twilioSig(TWILIO_TOKEN, TWILIO_URL, TWILIO_PARAMS);
    expect(verifyTwilioSignature(TWILIO_TOKEN, TWILIO_URL, shuffled, sig)).toBe(true);
  });

  it('accepts an empty-params POST (URL only)', () => {
    const sig = twilioSig(TWILIO_TOKEN, TWILIO_URL, {});
    expect(verifyTwilioSignature(TWILIO_TOKEN, TWILIO_URL, {}, sig)).toBe(true);
  });
});

describe('verifyTwilioSignature — fail-closed', () => {
  it('rejects a wrong signature', () => {
    expect(verifyTwilioSignature(TWILIO_TOKEN, TWILIO_URL, TWILIO_PARAMS, 'bogus')).toBe(false);
  });

  it('rejects when a param value was tampered', () => {
    const sig = twilioSig(TWILIO_TOKEN, TWILIO_URL, TWILIO_PARAMS);
    const tampered = { ...TWILIO_PARAMS, Body: 'Adios' };
    expect(verifyTwilioSignature(TWILIO_TOKEN, TWILIO_URL, tampered, sig)).toBe(false);
  });

  it('rejects when the URL differs (signed over full URL)', () => {
    const sig = twilioSig(TWILIO_TOKEN, TWILIO_URL, TWILIO_PARAMS);
    expect(
      verifyTwilioSignature(TWILIO_TOKEN, 'https://evil.com/hook', TWILIO_PARAMS, sig)
    ).toBe(false);
  });

  it('rejects with a wrong auth token', () => {
    const sig = twilioSig('wrong-token-0000000000000000000000', TWILIO_URL, TWILIO_PARAMS);
    expect(verifyTwilioSignature(TWILIO_TOKEN, TWILIO_URL, TWILIO_PARAMS, sig)).toBe(false);
  });

  it('rejects when auth token / url / header missing', () => {
    const sig = twilioSig(TWILIO_TOKEN, TWILIO_URL, TWILIO_PARAMS);
    expect(verifyTwilioSignature('', TWILIO_URL, TWILIO_PARAMS, sig)).toBe(false);
    expect(verifyTwilioSignature(TWILIO_TOKEN, '', TWILIO_PARAMS, sig)).toBe(false);
    expect(verifyTwilioSignature(TWILIO_TOKEN, TWILIO_URL, TWILIO_PARAMS, '')).toBe(false);
    expect(verifyTwilioSignature(undefined, TWILIO_URL, TWILIO_PARAMS, sig)).toBe(false);
  });
});
