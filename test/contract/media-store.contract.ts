/**
 * Shared contract test suite for {@link MediaStore} implementations. Run
 * against InMemoryMediaStore and PostgresMediaStore.
 */
import { it, expect } from 'vitest';
import type { MediaStore } from '../../src/media.js';

export function mediaStoreContract(getStore: () => MediaStore): void {
  it('put returns a durable StoredMedia with matching size and mimeType', async () => {
    const store = getStore();
    const data = new TextEncoder().encode('hello world');
    const stored = await store.put({ data, mimeType: 'text/plain', filename: 'hello.txt' });
    expect(stored.mimeType).toBe('text/plain');
    expect(stored.size).toBe(data.byteLength);
    expect(stored.url).toBeTruthy();
  });

  it('assigns distinct urls/keys to separate assets', async () => {
    const store = getStore();
    const a = await store.put({ data: new Uint8Array([1, 2, 3]), mimeType: 'application/octet-stream' });
    const b = await store.put({ data: new Uint8Array([4, 5, 6]), mimeType: 'application/octet-stream' });
    expect(a.url).not.toBe(b.url);
  });

  it('preserves size for larger binary payloads', async () => {
    const store = getStore();
    const data = new Uint8Array(4096).fill(7);
    const stored = await store.put({ data, mimeType: 'application/octet-stream' });
    expect(stored.size).toBe(4096);
  });
}
