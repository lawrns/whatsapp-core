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
 * A normalized inbound interactive response (FYV-147): the customer tapped a
 * quick-reply button, picked a list row, or submitted a Flow / native form.
 * Providers map their own payload shapes onto this; downstream apps branch on
 * `type` + `id`, never on the provider's raw JSON.
 */
export interface InboundInteractive {
  /** Interactive subtype. `unknown` when the provider sent an unrecognized shape. */
  type: 'button_reply' | 'list_reply' | 'flow_reply' | 'nfm_reply' | 'unknown';
  /** Id of the tapped button / selected row / flow button (when present). */
  id?: string;
  /** Display title of the tapped button / selected row. */
  title?: string;
  /** Raw JSON string for Flow / native-form replies (Meta `response_json`). */
  responseJson?: string;
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
  /**
   * Present when `contentType` is interactive: the customer's button / list /
   * Flow reply, normalized. `text` carries the reply title when available.
   */
  interaction?: InboundInteractive;
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

/**
 * Meta's hard limits on interactive messages. Exceeding any of these is a
 * Graph API 400, so we enforce them before the request leaves the process.
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 */
export const INTERACTIVE_LIMITS = {
  /** Reply buttons per message. */
  maxButtons: 3,
  buttonTitle: 20,
  buttonId: 256,
  /** Rows summed across every section of a list. */
  maxListRows: 10,
  listButton: 20,
  rowTitle: 24,
  rowDescription: 72,
  sectionTitle: 24,
  body: 1024,
  header: 60,
  footer: 60,
} as const;

/** A tappable reply button. Meta caps these at 3 per message. */
export interface ReplyButton {
  /** Echoed back on the inbound webhook when tapped. */
  id: string;
  title: string;
}

/** One selectable row inside a list message. */
export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

/** A named group of rows within a list message. */
export interface ListSection {
  title: string;
  rows: ReadonlyArray<ListRow>;
}

interface OutboundInteractiveBase {
  kind: 'interactive';
  to: string;
  body: string;
  header?: string;
  footer?: string;
}

/** Up to 3 quick-reply buttons. */
export interface OutboundButtons extends OutboundInteractiveBase {
  interactive: 'buttons';
  buttons: ReadonlyArray<ReplyButton>;
}

/** A tap-to-open list of up to 10 rows. Use when you need >3 choices. */
export interface OutboundList extends OutboundInteractiveBase {
  interactive: 'list';
  /** Label of the button that opens the list sheet. */
  buttonText: string;
  sections: ReadonlyArray<ListSection>;
}

/** A button that opens a URL — the escape hatch to the web app. */
export interface OutboundCtaUrl extends OutboundInteractiveBase {
  interactive: 'cta_url';
  displayText: string;
  url: string;
}

/**
 * A WhatsApp Flow: Meta's native in-app form. This is the only way to collect
 * typed input (numbers, selections) inside WhatsApp — chat bubbles cannot
 * contain input fields.
 */
export interface OutboundFlow extends OutboundInteractiveBase {
  interactive: 'flow';
  flowId: string;
  /** Label on the button that launches the Flow. */
  ctaText: string;
  /** Screen to open on. */
  screen: string;
  /** Opaque token echoed back with the Flow's completion payload. */
  flowToken: string;
  /** Initial data passed into the first screen. */
  flowActionPayload?: Record<string, unknown>;
}

export type OutboundInteractive =
  | OutboundButtons
  | OutboundList
  | OutboundCtaUrl
  | OutboundFlow;

/** Discriminated union of every outbound message shape. */
export type OutboundMessage =
  | OutboundText
  | OutboundTemplate
  | OutboundMedia
  | OutboundInteractive;

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
