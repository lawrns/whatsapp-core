import { describe } from 'vitest';
import { InMemoryOptOutStore } from '../../src/optout.js';
import { InMemorySessionStore } from '../../src/session.js';
import { InMemoryMediaStore } from '../../src/media.js';
import { optOutStoreContract } from '../contract/opt-out-store.contract.js';
import { sessionStoreContract } from '../contract/session-store.contract.js';
import { mediaStoreContract } from '../contract/media-store.contract.js';

describe('InMemoryOptOutStore — contract', () => {
  const store = new InMemoryOptOutStore();
  optOutStoreContract(() => store, 'mem');
});

describe('InMemorySessionStore — contract', () => {
  const store = new InMemorySessionStore();
  sessionStoreContract(() => store, 'mem');
});

describe('InMemoryMediaStore — contract', () => {
  const store = new InMemoryMediaStore();
  mediaStoreContract(() => store);
});
