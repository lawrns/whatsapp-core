/**
 * Inbound media persistence.
 *
 * Provider media URLs are ephemeral: Meta hands back an opaque media *id* that
 * must be resolved to a short-lived, token-protected download URL; Twilio's
 * media URLs are basic-auth protected and expire. To show media in an inbox or
 * keep it for compliance we must download it once and re-host it at a durable
 * URL.
 *
 * {@link MediaStore} is the seam: an app provides an S3 / Supabase-backed impl
 * in production and uses {@link InMemoryMediaStore} in tests. The download +
 * persist orchestration lives in {@link persistInboundMedia} so it is shared
 * across providers and fully testable.
 */

import type { InboundMedia, FetchLike } from './types.js';

/** A binary asset fetched from a provider, ready to be stored. */
export interface FetchedAsset {
  data: Uint8Array;
  mimeType: string;
  filename?: string;
}

/** A durable, re-fetchable reference produced by a {@link MediaStore}. */
export interface StoredMedia {
  /** Durable URL the asset can be fetched from later. */
  url: string;
  /** Storage key / path (bucket-relative), when the backend exposes one. */
  key?: string;
  mimeType: string;
  size: number;
}

/**
 * Persists a fetched asset somewhere durable. Implementations:
 *  - {@link InMemoryMediaStore} (tests / local dev)
 *  - S3 / Supabase Storage adapters in each consuming app
 */
export interface MediaStore {
  put(asset: FetchedAsset): Promise<StoredMedia>;
}

/**
 * Resolves a provider media reference to a directly-downloadable URL.
 *
 * Meta needs this step (id -> Graph API lookup -> CDN URL). Twilio does not
 * (the inbound URL is already downloadable), so Twilio supplies an identity
 * resolver. Each provider exports its own resolver.
 */
export interface MediaResolver {
  /** Turn an {@link InboundMedia} ref into a fetchable URL + auth headers. */
  resolve(media: InboundMedia): Promise<{
    url: string;
    headers?: Record<string, string>;
  }>;
}

function pickFetch(fetchImpl?: FetchLike): FetchLike {
  if (fetchImpl) return fetchImpl;
  const g = (globalThis as { fetch?: unknown }).fetch;
  if (typeof g !== 'function') {
    throw new Error('No fetch implementation available; pass one explicitly.');
  }
  return g as FetchLike;
}

/**
 * Download an inbound media asset and persist it to a durable URL.
 *
 * Flow: resolve provider ref -> download bytes (honoring auth headers) ->
 * `store.put` -> return the durable {@link StoredMedia}. Throws on resolve or
 * download failure so callers can decide whether to retry; persistence errors
 * propagate from the store.
 */
export async function persistInboundMedia(
  media: InboundMedia,
  resolver: MediaResolver,
  store: MediaStore,
  fetchImpl?: FetchLike
): Promise<StoredMedia> {
  const doFetch = pickFetch(fetchImpl);
  const { url, headers } = await resolver.resolve(media);

  const res = await doFetch(url, headers ? { headers } : undefined);
  if (!res.ok) {
    throw new Error(`Media download failed (HTTP ${res.status}) for ${url}`);
  }

  // FetchLike intentionally exposes only text(); download via text and encode
  // to bytes. Real app stores can override with arrayBuffer-based fetches, but
  // this keeps the core dependency-free and deterministic for tests.
  const body = await res.text();
  const data = new TextEncoder().encode(body);

  const asset: FetchedAsset = {
    data,
    mimeType: media.mimeType ?? 'application/octet-stream',
    ...(media.filename !== undefined ? { filename: media.filename } : {}),
  };

  return store.put(asset);
}

/**
 * In-memory {@link MediaStore} for tests and local dev. Keeps assets in a Map
 * keyed by a synthetic `mem://` URL. Not durable across process restarts.
 */
export class InMemoryMediaStore implements MediaStore {
  private readonly assets = new Map<string, FetchedAsset>();
  private counter = 0;

  constructor(private readonly baseUrl = 'mem://media') {}

  async put(asset: FetchedAsset): Promise<StoredMedia> {
    const key = `${++this.counter}`;
    this.assets.set(key, asset);
    return {
      url: `${this.baseUrl}/${key}`,
      key,
      mimeType: asset.mimeType,
      size: asset.data.byteLength,
    };
  }

  /** Test/inspection helper: retrieve a stored asset by its key. */
  get(key: string): FetchedAsset | undefined {
    return this.assets.get(key);
  }

  /** Number of assets currently held. */
  get size(): number {
    return this.assets.size;
  }
}
