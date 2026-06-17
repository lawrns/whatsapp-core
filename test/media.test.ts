import { describe, it, expect } from 'vitest';
import { persistInboundMedia, InMemoryMediaStore } from '../src/media.js';
import type { MediaResolver, MediaStore, FetchedAsset, StoredMedia } from '../src/media.js';
import type { FetchLike, InboundMedia } from '../src/types.js';
import { MetaWhatsAppProvider } from '../src/providers/meta.js';
import { TwilioWhatsAppProvider } from '../src/providers/twilio.js';

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
      text: async () => r.text ?? '',
    };
  };
  return { fetch, calls };
}

describe('InMemoryMediaStore', () => {
  it('stores an asset and returns a durable mem:// url', async () => {
    const store = new InMemoryMediaStore();
    const asset: FetchedAsset = {
      data: new TextEncoder().encode('bytes'),
      mimeType: 'image/jpeg',
    };
    const stored = await store.put(asset);
    expect(stored.url).toBe('mem://media/1');
    expect(stored.mimeType).toBe('image/jpeg');
    expect(stored.size).toBe(5);
    expect(store.size).toBe(1);
    expect(store.get('1')).toBe(asset);
  });

  it('assigns distinct keys to successive puts', async () => {
    const store = new InMemoryMediaStore();
    const a = await store.put({ data: new Uint8Array([1]), mimeType: 'x' });
    const b = await store.put({ data: new Uint8Array([2]), mimeType: 'x' });
    expect(a.url).not.toBe(b.url);
    expect(store.size).toBe(2);
  });
});

describe('persistInboundMedia — full flow', () => {
  it('resolves -> downloads -> persists and returns the durable url', async () => {
    const media: InboundMedia = { providerRef: 'MEDIA_ID', refKind: 'id', mimeType: 'image/png' };
    const resolver: MediaResolver = {
      async resolve(m) {
        expect(m.providerRef).toBe('MEDIA_ID');
        return { url: 'https://cdn.example.com/x.png', headers: { Authorization: 'Bearer t' } };
      },
    };
    const { fetch, calls } = stubFetch((url) => {
      expect(url).toBe('https://cdn.example.com/x.png');
      return { text: 'IMAGEBYTES' };
    });
    const store = new InMemoryMediaStore();

    const stored = await persistInboundMedia(media, resolver, store, fetch);

    expect(stored.url).toBe('mem://media/1');
    expect(stored.mimeType).toBe('image/png');
    expect(stored.size).toBe('IMAGEBYTES'.length);
    // Auth header from the resolver was forwarded to the download fetch.
    expect(calls[0]!.init?.headers?.Authorization).toBe('Bearer t');
    // The downloaded bytes landed in the store.
    expect(store.get('1')?.mimeType).toBe('image/png');
  });

  it('throws when the download fails (HTTP error)', async () => {
    const resolver: MediaResolver = {
      async resolve() {
        return { url: 'https://cdn.example.com/x.png' };
      },
    };
    const { fetch } = stubFetch(() => ({ ok: false, status: 404 }));
    await expect(
      persistInboundMedia({ providerRef: 'X', refKind: 'url' }, resolver, new InMemoryMediaStore(), fetch)
    ).rejects.toThrow(/Media download failed \(HTTP 404\)/);
  });

  it('propagates resolver failures', async () => {
    const resolver: MediaResolver = {
      async resolve() {
        throw new Error('resolve boom');
      },
    };
    const { fetch } = stubFetch(() => ({ text: 'x' }));
    await expect(
      persistInboundMedia({ providerRef: 'X', refKind: 'id' }, resolver, new InMemoryMediaStore(), fetch)
    ).rejects.toThrow('resolve boom');
  });

  it('propagates store failures', async () => {
    const resolver: MediaResolver = {
      async resolve() {
        return { url: 'https://cdn.example.com/x.png' };
      },
    };
    const failingStore: MediaStore = {
      async put(): Promise<StoredMedia> {
        throw new Error('store boom');
      },
    };
    const { fetch } = stubFetch(() => ({ text: 'x' }));
    await expect(
      persistInboundMedia({ providerRef: 'X', refKind: 'url' }, resolver, failingStore, fetch)
    ).rejects.toThrow('store boom');
  });
});

describe('persistInboundMedia — wired to real provider resolvers', () => {
  it('Meta: parse image -> resolve id via Graph -> persist', async () => {
    // One fetch stub serves both the Graph media-id lookup and the CDN download.
    const { fetch } = stubFetch((url) => {
      if (url.endsWith('/MEDIA_ID_42')) return { json: { url: 'https://lookaside.fbcdn.net/a.bin' } };
      return { text: 'METABYTES' };
    });
    const provider = new MetaWhatsAppProvider({
      phoneNumberId: 'PN',
      accessToken: 'TKN',
      appSecret: 'S',
      fetchImpl: fetch,
    });
    const [msg] = provider.parseInbound({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { display_phone_number: '15551234567', phone_number_id: 'PN' },
                messages: [
                  {
                    from: '521555', id: 'wamid.1', timestamp: '1718625600',
                    type: 'image', image: { id: 'MEDIA_ID_42', mime_type: 'image/jpeg' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(msg!.media).toBeDefined();
    const store = new InMemoryMediaStore();
    const stored = await persistInboundMedia(msg!.media!, provider.mediaResolver(), store, fetch);
    expect(stored.url).toBe('mem://media/1');
    expect(stored.mimeType).toBe('image/jpeg');
    expect(stored.size).toBe('METABYTES'.length);
  });

  it('Twilio: parse media -> resolve (identity+auth) -> persist', async () => {
    const { fetch, calls } = stubFetch(() => ({ text: 'TWILIOBYTES' }));
    const provider = new TwilioWhatsAppProvider({
      accountSid: 'AC1',
      authToken: 'tok',
      fromNumber: '+14155238886',
      fetchImpl: fetch,
    });
    const [msg] = provider.parseInbound({
      MessageSid: 'SM1',
      From: 'whatsapp:+521555',
      To: 'whatsapp:+14155238886',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/ME1',
      MediaContentType0: 'image/jpeg',
    });
    const store = new InMemoryMediaStore();
    const stored = await persistInboundMedia(msg!.media!, provider.mediaResolver(), store, fetch);
    expect(stored.url).toBe('mem://media/1');
    expect(stored.size).toBe('TWILIOBYTES'.length);
    // Downloaded directly from the Twilio media URL with basic auth.
    expect(calls[0]!.url).toBe('https://api.twilio.com/media/ME1');
    expect(calls[0]!.init?.headers?.Authorization).toMatch(/^Basic /);
  });
});
