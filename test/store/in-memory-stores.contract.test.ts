import { describe } from 'vitest';
import { InMemoryOptOutStore } from '../../src/optout.js';
import { InMemorySessionStore } from '../../src/session.js';
import { InMemoryMediaStore } from '../../src/media.js';
import { InMemoryConsentLedger } from '../../src/consent.js';
import { InMemoryTemplateRegistry } from '../../src/templates.js';
import { InMemoryEscalationStore } from '../../src/escalation.js';
import { optOutStoreContract } from '../contract/opt-out-store.contract.js';
import { sessionStoreContract } from '../contract/session-store.contract.js';
import { mediaStoreContract } from '../contract/media-store.contract.js';
import { consentLedgerContract } from '../contract/consent-ledger.contract.js';
import { templateRegistryContract } from '../contract/template-registry.contract.js';
import { escalationStoreContract } from '../contract/escalation-store.contract.js';

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

describe('InMemoryConsentLedger — contract', () => {
  const store = new InMemoryConsentLedger();
  consentLedgerContract(() => store, 'mem');
});

describe('InMemoryTemplateRegistry — contract', () => {
  const store = new InMemoryTemplateRegistry();
  templateRegistryContract(() => store, 'mem');
});

describe('InMemoryEscalationStore — contract', () => {
  const store = new InMemoryEscalationStore();
  escalationStoreContract(() => store, 'mem');
});
