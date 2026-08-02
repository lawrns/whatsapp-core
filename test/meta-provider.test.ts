import { describe, it, expect } from 'vitest';
import { MetaWhatsAppProvider } from '../src/providers/meta.js';
import type { FetchLike, MetaProviderConfig } from '../src/types.js';

/** Capture-and-respond fetch stub. */
function stubFetch(
  responder: (url: string, init?: Parameters<FetchLike>[1]) => {
    ok?: boolean;
    status?: number;
    json?: unknown;
    text?: string;
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
      text: async () => r.text ?? JSON.stringify(r.json ?? {}),
    };
  };
  return { fetch, calls };
}

function config(fetchImpl: FetchLike): MetaProviderConfig {
  return {
    phoneNumberId: '111222333',
    accessToken: 'EAAG-token',
    appSecret: 'app-secret',
    fetchImpl,
  };
}

describe('MetaWhatsAppProvider.send', () => {
  it('sends a text message and returns the wamid', async () => {
    const { fetch, calls } = stubFetch(() => ({
      json: { messages: [{ id: 'wamid.TEXT' }] },
    }));
    const provider = new MetaWhatsAppProvider(config(fetch));
    const res = await provider.send({ kind: 'text', to: '5215599998888', body: 'Hola' });

    expect(res).toEqual({ success: true, externalId: 'wamid.TEXT' });
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v20.0/111222333/messages');
    const body = JSON.parse(calls[0]!.init!.body!);
    expect(body).toMatchObject({
      messaging_product: 'whatsapp',
      to: '5215599998888',
      type: 'text',
      text: { body: 'Hola' },
    });
    expect(calls[0]!.init!.headers!.Authorization).toBe('Bearer EAAG-token');
  });

  it('sends a template message with positional params', async () => {
    const { fetch, calls } = stubFetch(() => ({ json: { messages: [{ id: 'wamid.TMPL' }] } }));
    const provider = new MetaWhatsAppProvider(config(fetch));
    const res = await provider.send({
      kind: 'template',
      to: '5215599998888',
      templateName: 'order_update',
      languageCode: 'es_MX',
      parameters: ['Oscar', '#1234'],
    });

    expect(res.success).toBe(true);
    const body = JSON.parse(calls[0]!.init!.body!);
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('order_update');
    expect(body.template.language.code).toBe('es_MX');
    expect(body.template.components[0].parameters).toEqual([
      { type: 'text', text: 'Oscar' },
      { type: 'text', text: '#1234' },
    ]);
  });

  it('sends a media (image) message', async () => {
    const { fetch, calls } = stubFetch(() => ({ json: { messages: [{ id: 'wamid.IMG' }] } }));
    const provider = new MetaWhatsAppProvider(config(fetch));
    await provider.send({
      kind: 'media',
      to: '5215599998888',
      mediaKind: 'image',
      url: 'https://cdn.example.com/a.jpg',
      caption: 'mira',
    });
    const body = JSON.parse(calls[0]!.init!.body!);
    expect(body.type).toBe('image');
    expect(body.image).toEqual({ link: 'https://cdn.example.com/a.jpg', caption: 'mira' });
  });

  it('surfaces API errors with status code', async () => {
    const { fetch } = stubFetch(() => ({
      ok: false,
      status: 400,
      json: { error: { message: 'Invalid recipient' } },
    }));
    const provider = new MetaWhatsAppProvider(config(fetch));
    const res = await provider.send({ kind: 'text', to: 'x', body: 'hi' });
    expect(res).toEqual({ success: false, error: 'Invalid recipient', statusCode: 400 });
  });
});

describe('MetaWhatsAppProvider.parseInbound', () => {
  const metaTextPayload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15551234567', phone_number_id: '111222333' },
              contacts: [{ profile: { name: 'Oscar' }, wa_id: '5215599998888' }],
              messages: [
                {
                  from: '5215599998888',
                  id: 'wamid.IN1',
                  timestamp: '1718625600',
                  type: 'text',
                  text: { body: 'Hola, ¿precio?' },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  it('normalizes a text message', () => {
    const provider = new MetaWhatsAppProvider(config(stubFetch(() => ({})).fetch));
    const [msg] = provider.parseInbound(metaTextPayload);
    expect(msg).toBeDefined();
    expect(msg!.provider).toBe('meta');
    expect(msg!.externalId).toBe('wamid.IN1');
    expect(msg!.from).toBe('5215599998888');
    expect(msg!.to).toBe('15551234567');
    expect(msg!.contentType).toBe('text');
    expect(msg!.text).toBe('Hola, ¿precio?');
    expect(msg!.senderName).toBe('Oscar');
    expect(msg!.channelId).toBe('111222333');
    expect(msg!.timestamp.getTime()).toBe(1718625600 * 1000);
  });

  it('normalizes an image message into a media ref (refKind=id)', () => {
    const payload = structuredClone(metaTextPayload);
    payload.entry[0]!.changes[0]!.value.messages = [
      {
        from: '5215599998888',
        id: 'wamid.IMG1',
        timestamp: '1718625600',
        type: 'image',
        image: { id: 'MEDIA_ID_42', mime_type: 'image/jpeg', caption: 'recibo' },
      } as never,
    ];
    const provider = new MetaWhatsAppProvider(config(stubFetch(() => ({})).fetch));
    const [msg] = provider.parseInbound(payload);
    expect(msg!.contentType).toBe('image');
    expect(msg!.text).toBe('recibo');
    expect(msg!.media).toEqual({
      providerRef: 'MEDIA_ID_42',
      refKind: 'id',
      mimeType: 'image/jpeg',
      caption: 'recibo',
    });
  });

  it('normalizes a location message', () => {
    const payload = structuredClone(metaTextPayload);
    payload.entry[0]!.changes[0]!.value.messages = [
      {
        from: '5215599998888',
        id: 'wamid.LOC1',
        timestamp: '1718625600',
        type: 'location',
        location: { latitude: 19.4326, longitude: -99.1332, name: 'Zocalo' },
      } as never,
    ];
    const provider = new MetaWhatsAppProvider(config(stubFetch(() => ({})).fetch));
    const [msg] = provider.parseInbound(payload);
    expect(msg!.contentType).toBe('location');
    expect(msg!.location).toEqual({ latitude: 19.4326, longitude: -99.1332, name: 'Zocalo' });
  });

  it('returns an empty array for status-only webhooks (no messages)', () => {
    const provider = new MetaWhatsAppProvider(config(stubFetch(() => ({})).fetch));
    const statusPayload = {
      entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.x', status: 'read' }] } }] }],
    };
    expect(provider.parseInbound(statusPayload)).toEqual([]);
  });

  it('normalizes a button_reply interactive message', () => {
    const payload = structuredClone(metaTextPayload);
    payload.entry[0]!.changes[0]!.value.messages = [
      {
        from: '5215599998888',
        id: 'wamid.BTN1',
        timestamp: '1718625600',
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: { id: 'yes_confirm', title: 'Sí, confirmar' },
        },
      } as never,
    ];
    const provider = new MetaWhatsAppProvider(config(stubFetch(() => ({})).fetch));
    const [msg] = provider.parseInbound(payload);
    expect(msg!.contentType).toBe('interactive');
    expect(msg!.text).toBe('Sí, confirmar');
    expect(msg!.interaction).toEqual({
      type: 'button_reply',
      id: 'yes_confirm',
      title: 'Sí, confirmar',
    });
  });

  it('normalizes a list_reply interactive message', () => {
    const payload = structuredClone(metaTextPayload);
    payload.entry[0]!.changes[0]!.value.messages = [
      {
        from: '5215599998888',
        id: 'wamid.LST1',
        timestamp: '1718625600',
        type: 'interactive',
        interactive: {
          type: 'list_reply',
          list_reply: { id: 'row_3', title: 'Carnitas por kilo' },
        },
      } as never,
    ];
    const provider = new MetaWhatsAppProvider(config(stubFetch(() => ({})).fetch));
    const [msg] = provider.parseInbound(payload);
    expect(msg!.interaction).toEqual({
      type: 'list_reply',
      id: 'row_3',
      title: 'Carnitas por kilo',
    });
  });

  it('normalizes a flow_reply with response_json payload', () => {
    const payload = structuredClone(metaTextPayload);
    payload.entry[0]!.changes[0]!.value.messages = [
      {
        from: '5215599998888',
        id: 'wamid.FLW1',
        timestamp: '1718625600',
        type: 'interactive',
        interactive: {
          type: 'flow_reply',
          flow_reply: {
            id: 'flow_btn_1',
            response_json: '{"street":"Av Reforma 123"}',
          },
        },
      } as never,
    ];
    const provider = new MetaWhatsAppProvider(config(stubFetch(() => ({})).fetch));
    const [msg] = provider.parseInbound(payload);
    expect(msg!.interaction).toEqual({
      type: 'flow_reply',
      id: 'flow_btn_1',
      responseJson: '{"street":"Av Reforma 123"}',
    });
    expect(msg!.text).toBe('');
  });

  it('normalizes an unrecognized interactive type as unknown', () => {
    const payload = structuredClone(metaTextPayload);
    payload.entry[0]!.changes[0]!.value.messages = [
      {
        from: '5215599998888',
        id: 'wamid.UNK1',
        timestamp: '1718625600',
        type: 'interactive',
        interactive: { type: 'catalog_reply', catalog_reply: { id: 'cat_1' } },
      } as never,
    ];
    const provider = new MetaWhatsAppProvider(config(stubFetch(() => ({})).fetch));
    const [msg] = provider.parseInbound(payload);
    expect(msg!.interaction?.type).toBe('unknown');
    expect(msg!.interaction?.id).toBeUndefined();
  });
});

describe('MetaWhatsAppProvider.mediaResolver', () => {
  it('resolves a media id to a CDN url via the Graph API with auth headers', async () => {
    const { fetch, calls } = stubFetch((url) => {
      expect(url).toBe('https://graph.facebook.com/v20.0/MEDIA_ID_42');
      return { json: { url: 'https://lookaside.fbcdn.net/asset.bin' } };
    });
    const provider = new MetaWhatsAppProvider(config(fetch));
    const resolved = await provider.mediaResolver().resolve({
      providerRef: 'MEDIA_ID_42',
      refKind: 'id',
    });
    expect(resolved.url).toBe('https://lookaside.fbcdn.net/asset.bin');
    expect(resolved.headers?.Authorization).toBe('Bearer EAAG-token');
    expect(calls[0]!.init?.headers?.Authorization).toBe('Bearer EAAG-token');
  });
});
