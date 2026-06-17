/**
 * Provider-agnostic types shared across the WhatsApp core.
 *
 * The goal of this module is to give every consuming app (bien, campfire-v2,
 * hablo, mexicasa, cobros) a single common vocabulary for WhatsApp messaging
 * regardless of whether the underlying transport is the Meta WhatsApp Cloud
 * API or Twilio's WhatsApp product.
 */

/** Identifies which underlying transport handled / will handle a message. */
export type WhatsAppProviderId = 'meta' | 'twilio';

/**
 * Normalized inbound content kinds. Providers map their own type taxonomies
 * onto this small, stable set so downstream code never branches on provider.
 */
export type InboundContentType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'location'
  | 'contacts'
  | 'interactive'
  | 'unknown';

/** Media kinds that can be sent outbound and that map to a downloadable asset. */
export type MediaKind = 'image' | 'video' | 'audio' | 'document';

/**
 * A pointer to media attached to an inbound message. Provider URLs are usually
 * ephemeral (Meta requires a token to download; Twilio URLs are short-lived and
 * basic-auth protected), so this is the raw provider-side reference. Use a
 * {@link MediaStore} to turn it into a durable URL.
 */
export interface InboundMedia {
  /**
   * For Meta this is the opaque media *id* that must be resolved via the Graph
   * API before download. For Twilio this is the directly-downloadable media URL.
   */
  providerRef: string;
  /** Whether `providerRef` is already a URL or an id needing resolution. */
  refKind: 'url' | 'id';
  /** MIME type if the provider supplied one. */
  mimeType?: string;
  /** Original filename (documents). */
  filename?: string;
  /** Caption supplied alongside the media, if any. */
  caption?: string;
}

/** A geographic location share. */
export interface InboundLocation {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

/**
 * The common, typed inbound message every provider normalizes to. This is the
 * single contract downstream apps consume; no provider-specific shape leaks
 * past the adapter boundary except via {@link raw}.
 */
export interface InboundMessage {
  /** Which provider produced this message. */
  provider: WhatsAppProviderId;
  /** Provider's unique message id (Meta `wamid`, Twilio `MessageSid`). */
  externalId: string;
  /**
   * Customer phone number in E.164-ish form (digits, no `whatsapp:` prefix).
   * This is the sender of an inbound message.
   */
  from: string;
  /** The business number that received the message (your WABA / Twilio number). */
  to: string;
  /** Normalized content kind. */
  contentType: InboundContentType;
  /** Best-effort plain-text body (caption for media, "" when none). */
  text: string;
  /** Present when `contentType` is image/video/audio/document. */
  media?: InboundMedia;
  /** Present when `contentType` is location. */
  location?: InboundLocation;
  /** Customer's WhatsApp profile name, when available. */
  senderName?: string;
  /** When the customer sent the message. */
  timestamp: Date;
  /**
   * Provider-specific routing identifier:
   *  - Meta: the `phone_number_id` (used to resolve which WABA / tenant).
   *  - Twilio: the messaging-service or account-scoped `To` number.
   */
  channelId?: string;
  /** The untouched provider payload, for auditing / debugging. */
  raw: unknown;
}

/** A template variable substitution. Order matches `{{1}}`, `{{2}}`, ... */
export type TemplateParameters = ReadonlyArray<string>;

/** Outbound: a freeform text message. Only allowed inside the 24h window. */
export interface OutboundText {
  kind: 'text';
  to: string;
  body: string;
  /** Enable link previews (Meta only; ignored by Twilio). */
  previewUrl?: boolean;
}

/** Outbound: a pre-approved template message. Allowed any time. */
export interface OutboundTemplate {
  kind: 'template';
  to: string;
  /** Template name as registered with the provider. */
  templateName: string;
  /** BCP-47 language code, e.g. `es_MX`, `en_US`. */
  languageCode: string;
  /** Body-component substitutions, positional. */
  parameters?: TemplateParameters;
}

/** Outbound: a media message (link to a durable, publicly fetchable URL). */
export interface OutboundMedia {
  kind: 'media';
  to: string;
  mediaKind: MediaKind;
  /** Publicly reachable URL the provider will fetch the asset from. */
  url: string;
  caption?: string;
  /** Filename to present (documents). */
  filename?: string;
}

/** Discriminated union of every outbound message shape. */
export type OutboundMessage = OutboundText | OutboundTemplate | OutboundMedia;

/** Result of an outbound send attempt. */
export interface SendResult {
  success: boolean;
  /** Provider message id on success. */
  externalId?: string;
  /** Human-readable error on failure. */
  error?: string;
  /** HTTP status if the failure came from the provider API. */
  statusCode?: number;
}

/**
 * Minimal `fetch` signature the providers depend on. Lets tests inject a stub
 * without pulling in any HTTP library, and keeps runtime deps at zero.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

/** Credentials + config for the Meta WhatsApp Cloud API provider. */
export interface MetaProviderConfig {
  /** WABA phone number id used in the send URL. */
  phoneNumberId: string;
  /** Long-lived system-user / app access token. */
  accessToken: string;
  /** App secret used to verify `X-Hub-Signature-256`. */
  appSecret: string;
  /** Graph API version, defaults to a recent stable version. */
  graphVersion?: string;
  /** Injected fetch (defaults to global fetch). */
  fetchImpl?: FetchLike;
}

/** Credentials + config for the Twilio WhatsApp provider. */
export interface TwilioProviderConfig {
  accountSid: string;
  authToken: string;
  /** The business WhatsApp sender, e.g. `+14155238886` (no `whatsapp:` prefix). */
  fromNumber: string;
  /**
   * The public URL Twilio is configured to POST webhooks to. Required for
   * signature verification because Twilio signs the full URL.
   */
  webhookUrl?: string;
  /** Injected fetch (defaults to global fetch). */
  fetchImpl?: FetchLike;
}

/** The common interface every provider adapter implements. */
export interface WhatsAppProvider {
  readonly id: WhatsAppProviderId;
  /** Send any outbound message shape. */
  send(message: OutboundMessage): Promise<SendResult>;
  /** Normalize a raw inbound webhook body into zero or more messages. */
  parseInbound(payload: unknown): InboundMessage[];
}
