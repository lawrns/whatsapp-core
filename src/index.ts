/**
 * @portfolio/whatsapp-core
 *
 * Provider-agnostic WhatsApp messaging core. Public API surface.
 */

// Types
export type {
  WhatsAppProviderId,
  InboundContentType,
  MediaKind,
  InboundMedia,
  InboundLocation,
  InboundMessage,
  TemplateParameters,
  OutboundText,
  OutboundTemplate,
  OutboundMedia,
  OutboundButtons,
  OutboundList,
  OutboundCtaUrl,
  OutboundFlow,
  OutboundInteractive,
  ReplyButton,
  ListRow,
  ListSection,
  OutboundMessage,
  SendResult,
  FetchLike,
  MetaProviderConfig,
  TwilioProviderConfig,
  WhatsAppProvider,
} from './types.js';

export { INTERACTIVE_LIMITS } from './types.js';

// Interactive message validation
export { validateInteractive } from './interactive.js';

// Providers
export { MetaWhatsAppProvider } from './providers/meta.js';
export { TwilioWhatsAppProvider } from './providers/twilio.js';

// Session window
export {
  SESSION_WINDOW_MS,
  createSession,
  recordInbound,
  sessionExpiresAt,
  isWithinSession,
  canSend,
  InMemorySessionStore,
} from './session.js';
export type { SessionState, SendDecision, SendGateReason, SessionStore } from './session.js';

// Media
export { persistInboundMedia, InMemoryMediaStore } from './media.js';
export type {
  MediaStore,
  MediaResolver,
  FetchedAsset,
  StoredMedia,
} from './media.js';

// Webhook signature verification
export {
  verifyMetaSignature,
  verifyMetaChallenge,
  verifyTwilioSignature,
} from './webhooks.js';

// Opt-out / compliance
export {
  DEFAULT_OPT_OUT_KEYWORDS,
  DEFAULT_OPT_IN_KEYWORDS,
  detectOptOut,
  isOptOut,
  detectOptIn,
  applyComplianceKeywords,
  InMemoryOptOutStore,
} from './optout.js';
export type { OptOutStore } from './optout.js';

// Postgres-backed reference stores (Supabase/Postgres)
export {
  PostgresOptOutStore,
  PostgresSessionStore,
  PostgresMediaStore,
  ensureWhatsAppCoreSchema,
  whatsAppCoreSchemaSql,
} from './store/postgres.js';
export type {
  SqlExecutor,
  PostgresStoreOptions,
  PostgresMediaStoreOptions,
} from './store/postgres.js';
