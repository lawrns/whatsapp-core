import { describe, it, expect } from 'vitest';
import { TwilioWhatsAppProvider } from '../src/providers/twilio.js';
import type { FetchLike, TwilioProviderConfig } from '../src/types.js';

function stubFetch(
  responder: (url: string, init?: Parameters<FetchLike>[1]) => {
    ok?: boolean;
    status?: number;
    json?: unknown;
  }
): { fetch: FetchLike; calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> } {
  const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = responder(url, init);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.json ?? {},
      text: async () => JSON.stringify(r.json ?? {}),
    };
  };
  return { fetch, calls };
}

function config(fetchImpl: FetchLike): TwilioProviderConfig {
  return {
    accountSid: 'AC123',
    authToken: 'tok-secret',
    fromNumber: '+14155238886',
    fetchImpl,
  };
}

describe('TwilioWhatsAppProvider.send', () => {
  it('sends a text message form-encoded with whatsapp: prefixes', async () => {
    const { fetch, calls } = stubFetch(() => ({ json: { sid: 'SM_OUT_1' } }));
    const provider = new TwilioWhatsAppProvider(config(fetch));
    const res = await provider.send({ kind: 'text', to: '+5215599998888', body: 'Hola' });

    expect(res).toEqual({ success: true, externalId: 'SM_OUT_1' });
    expect(calls[0]!.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    const form = new URLSearchParams(calls[0]!.init!.body!);
    expect(form.get('From')).toBe('whatsapp:+14155238886');
    expect(form.get('To')).toBe('whatsapp:+5215599998888');
    expect(form.get('Body')).toBe('Hola');
    expect(calls[0]!.init!.headers!.Authorization).toMatch(/^Basic /);
    expect(calls[0]!.init!.headers!['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('renders template params positionally into {{n}} placeholders', async () => {
    const { fetch, calls } = stubFetch(() => ({ json: { sid: 'SM_TMPL' } }));
    const provider = new TwilioWhatsAppProvider(config(fetch));
    await provider.send({
      kind: 'template',
      to: '+5215599998888',
      templateName: 'Hola {{1}}, tu pedido {{2}} va en camino',
      languageCode: 'es_MX',
      parameters: ['Oscar', '#1234'],
    });
    const form = new URLSearchParams(calls[0]!.init!.body!);
    expect(form.get('Body')).toBe('Hola Oscar, tu pedido #1234 va en camino');
  });

  it('sends a media message with MediaUrl + caption Body', async () => {
    const { fetch, calls } = stubFetch(() => ({ json: { sid: 'SM_MED' } }));
    const provider = new TwilioWhatsAppProvider(config(fetch));
    await provider.send({
      kind: 'media',
      to: '+5215599998888',
      mediaKind: 'image',
      url: 'https://cdn.example.com/a.jpg',
      caption: 'mira',
    });
    const form = new URLSearchParams(calls[0]!.init!.body!);
    expect(form.get('MediaUrl')).toBe('https://cdn.example.com/a.jpg');
    expect(form.get('Body')).toBe('mira');
  });

  it('surfaces Twilio API errors', async () => {
    const { fetch } = stubFetch(() => ({
      ok: false,
      status: 401,
      json: { message: 'Authenticate', code: 20003 },
    }));
    const provider = new TwilioWhatsAppProvider(config(fetch));
    const res = await provider.send({ kind: 'text', to: '+1', body: 'hi' });
    expect(res).toEqual({ success: false, error: 'Authenticate', statusCode: 401 });
  });
});

describe('TwilioWhatsAppProvider.parseInbound', () => {
  it('normalizes a text inbound, stripping whatsapp: prefixes', () => {
    const provider = new TwilioWhatsAppProvider(config(stubFetch(() => ({})).fetch));
    const [msg] = provider.parseInbound({
      MessageSid: 'SM_IN_1',
      From: 'whatsapp:+5215599998888',
      To: 'whatsapp:+14155238886',
      Body: 'Hola, ¿precio?',
      ProfileName: 'Oscar',
      NumMedia: '0',
    });
    expect(msg!.provider).toBe('twilio');
    expect(msg!.externalId).toBe('SM_IN_1');
    expect(msg!.from).toBe('+5215599998888');
    expect(msg!.to).toBe('+14155238886');
    expect(msg!.contentType).toBe('text');
    expect(msg!.text).toBe('Hola, ¿precio?');
    expect(msg!.senderName).toBe('Oscar');
  });

  it('normalizes a media inbound into a directly-downloadable url ref', () => {
    const provider = new TwilioWhatsAppProvider(config(stubFetch(() => ({})).fetch));
    const [msg] = provider.parseInbound({
      MessageSid: 'SM_IN_2',
      From: 'whatsapp:+5215599998888',
      To: 'whatsapp:+14155238886',
      Body: 'recibo',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/ME123',
      MediaContentType0: 'image/jpeg',
    });
    expect(msg!.contentType).toBe('image');
    expect(msg!.media).toEqual({
      providerRef: 'https://api.twilio.com/media/ME123',
      refKind: 'url',
      mimeType: 'image/jpeg',
      caption: 'recibo',
    });
  });

  it('normalizes a location inbound', () => {
    const provider = new TwilioWhatsAppProvider(config(stubFetch(() => ({})).fetch));
    const [msg] = provider.parseInbound({
      MessageSid: 'SM_IN_3',
      From: 'whatsapp:+5215599998888',
      To: 'whatsapp:+14155238886',
      Latitude: '19.4326',
      Longitude: '-99.1332',
      Label: 'Zocalo',
    });
    expect(msg!.contentType).toBe('location');
    expect(msg!.location).toEqual({ latitude: 19.4326, longitude: -99.1332, name: 'Zocalo' });
  });

  it('returns [] when required fields are absent', () => {
    const provider = new TwilioWhatsAppProvider(config(stubFetch(() => ({})).fetch));
    expect(provider.parseInbound({ Body: 'orphan' })).toEqual([]);
    expect(provider.parseInbound(null)).toEqual([]);
  });

  it('media resolver returns the url with basic-auth headers', async () => {
    const provider = new TwilioWhatsAppProvider(config(stubFetch(() => ({})).fetch));
    const resolved = await provider.mediaResolver().resolve({
      providerRef: 'https://api.twilio.com/media/ME123',
      refKind: 'url',
    });
    expect(resolved.url).toBe('https://api.twilio.com/media/ME123');
    expect(resolved.headers?.Authorization).toMatch(/^Basic /);
  });
});
