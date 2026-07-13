/**
 * Twilio WhatsApp provider adapter.
 *
 * Responsibilities:
 *  - send text / template / media via Twilio's Messages API (form-encoded).
 *  - normalize inbound webhook form params into {@link InboundMessage}.
 *  - provide a {@link MediaResolver} (Twilio media URLs are directly
 *    downloadable with basic auth, so resolution is near-identity).
 *
 * Twilio addresses WhatsApp numbers with a `whatsapp:` prefix; this adapter
 * adds/strips it at the boundary so the rest of the core only ever sees bare
 * phone numbers.
 *
 * @see https://www.twilio.com/docs/whatsapp/api
 */

import type { MediaResolver } from '../media.js';
import type {
  FetchLike,
  InboundContentType,
  InboundMessage,
  OutboundMessage,
  SendResult,
  TwilioProviderConfig,
  WhatsAppProvider,
} from '../types.js';

function resolveFetch(fetchImpl?: FetchLike): FetchLike {
  if (fetchImpl) return fetchImpl;
  const g = (globalThis as { fetch?: unknown }).fetch;
  if (typeof g !== 'function') {
    throw new Error('No fetch implementation available; pass config.fetchImpl.');
  }
  return g as FetchLike;
}

/** Strip Twilio's `whatsapp:` prefix to get a bare number. */
function stripPrefix(addr: string): string {
  return addr.startsWith('whatsapp:') ? addr.slice('whatsapp:'.length) : addr;
}

/** Add Twilio's `whatsapp:` prefix to a bare number. */
function addPrefix(addr: string): string {
  return addr.startsWith('whatsapp:') ? addr : `whatsapp:${addr}`;
}

/** Twilio mime-type prefix -> normalized content kind. */
function mapMediaContentType(mime: string): InboundContentType {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

export class TwilioWhatsAppProvider implements WhatsAppProvider {
  readonly id = 'twilio' as const;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: TwilioProviderConfig) {
    this.fetchImpl = resolveFetch(config.fetchImpl);
  }

  private get messagesUrl(): string {
    return `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`;
  }

  private authHeader(): string {
    const raw = `${this.config.accountSid}:${this.config.authToken}`;
    return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
  }

  /** Build the form-encoded body for an outbound message. */
  private buildForm(message: OutboundMessage): URLSearchParams {
    const form = new URLSearchParams();
    form.set('From', addPrefix(this.config.fromNumber));
    form.set('To', addPrefix(message.to));

    switch (message.kind) {
      case 'text':
        form.set('Body', message.body);
        break;
      case 'template':
        // Twilio renders approved templates by substituting the body text.
        // Apps that use Content API templates can pass ContentSid via a media
        // message; here we substitute {{n}} positional params into the name's
        // body, mirroring how Twilio's quick-reply templates accept variables.
        form.set('Body', renderTemplateBody(message.templateName, message.parameters));
        break;
      case 'media':
        if (message.caption !== undefined) form.set('Body', message.caption);
        form.set('MediaUrl', message.url);
        break;
      case 'interactive':
        // Unreachable: send() rejects interactive before building the form.
        // Twilio models buttons/lists as Content API templates, not inline
        // payloads, so there is no faithful mapping here.
        throw new Error('Twilio does not support inline interactive messages');
    }

    return form;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.config.accountSid || !this.config.authToken || !this.config.fromNumber) {
      return { success: false, error: 'Twilio provider missing accountSid/authToken/fromNumber' };
    }

    if (message.kind === 'interactive') {
      // Fail explicitly rather than silently posting an empty body.
      return {
        success: false,
        error:
          'Twilio provider does not support interactive messages (buttons/list/flow); use the Meta provider',
      };
    }

    try {
      const res = await this.fetchImpl(this.messagesUrl, {
        method: 'POST',
        headers: {
          Authorization: this.authHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: this.buildForm(message).toString(),
      });

      const json = (await res.json()) as { sid?: string; message?: string; code?: number };

      if (!res.ok) {
        return {
          success: false,
          error: json.message ?? `Twilio API error (HTTP ${res.status})`,
          statusCode: res.status,
        };
      }

      return json.sid !== undefined
        ? { success: true, externalId: json.sid }
        : { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Twilio send failed' };
    }
  }

  /**
   * Normalize a Twilio inbound webhook. Twilio POSTs form-encoded params; pass
   * them as a plain object (e.g. `Object.fromEntries(new URLSearchParams(body))`).
   * Twilio delivers one message per webhook, so this returns 0 or 1 messages.
   */
  parseInbound(payload: unknown): InboundMessage[] {
    const p = payload as Record<string, string> | null | undefined;
    if (!p || typeof p !== 'object') return [];

    const sid = p['MessageSid'] ?? p['SmsMessageSid'] ?? p['SmsSid'];
    const from = p['From'];
    if (!sid || !from) return [];

    const numMedia = parseInt(p['NumMedia'] ?? '0', 10) || 0;
    const body = p['Body'] ?? '';

    let contentType: InboundContentType = 'text';
    const msg: InboundMessage = {
      provider: 'twilio',
      externalId: sid,
      from: stripPrefix(from),
      to: stripPrefix(p['To'] ?? this.config.fromNumber),
      contentType,
      text: body,
      timestamp: new Date(),
      raw: payload,
    };

    const profileName = p['ProfileName'];
    if (profileName) msg.senderName = profileName;

    const messagingServiceSid = p['MessagingServiceSid'] ?? p['To'];
    if (messagingServiceSid) msg.channelId = stripPrefix(messagingServiceSid);

    // Location share: Twilio sends Latitude/Longitude.
    if (p['Latitude'] && p['Longitude']) {
      contentType = 'location';
      msg.contentType = 'location';
      msg.location = {
        latitude: parseFloat(p['Latitude']),
        longitude: parseFloat(p['Longitude']),
        ...(p['Address'] !== undefined ? { address: p['Address'] } : {}),
        ...(p['Label'] !== undefined ? { name: p['Label'] } : {}),
      };
      return [msg];
    }

    // Media: Twilio exposes MediaUrl0 / MediaContentType0.
    if (numMedia > 0) {
      const mediaUrl = p['MediaUrl0'];
      const mediaMime = p['MediaContentType0'] ?? 'application/octet-stream';
      if (mediaUrl) {
        contentType = mapMediaContentType(mediaMime);
        msg.contentType = contentType;
        msg.media = {
          providerRef: mediaUrl,
          refKind: 'url',
          mimeType: mediaMime,
          ...(body ? { caption: body } : {}),
        };
      }
    }

    return [msg];
  }

  /**
   * Twilio media URLs are directly downloadable using the account's basic-auth
   * credentials, so resolution is identity-with-auth-headers.
   */
  mediaResolver(): MediaResolver {
    const auth = this.authHeader();
    return {
      async resolve(media) {
        return { url: media.providerRef, headers: { Authorization: auth } };
      },
    };
  }
}

/**
 * Substitute positional `{{1}}`, `{{2}}` ... params into a template body. When
 * no `{{n}}` placeholders are present, params are appended space-separated so a
 * bare template name still produces a sensible message.
 */
function renderTemplateBody(
  templateBody: string,
  params?: ReadonlyArray<string>
): string {
  if (!params || params.length === 0) return templateBody;
  if (/\{\{\s*\d+\s*\}\}/.test(templateBody)) {
    return templateBody.replace(/\{\{\s*(\d+)\s*\}\}/g, (_match, n: string) => {
      const idx = parseInt(n, 10) - 1;
      return params[idx] ?? '';
    });
  }
  return [templateBody, ...params].join(' ');
}
