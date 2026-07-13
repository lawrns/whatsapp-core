/**
 * Meta WhatsApp Cloud API provider adapter.
 *
 * Responsibilities:
 *  - send text / template / media / interactive via the Graph API.
 *  - normalize inbound webhook payloads into {@link InboundMessage}.
 *  - resolve inbound media ids into downloadable URLs (for {@link MediaStore}).
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api
 */

import type { MediaResolver } from '../media.js';
import { validateInteractive } from '../interactive.js';
import type {
  FetchLike,
  InboundContentType,
  InboundMessage,
  MetaProviderConfig,
  OutboundInteractive,
  OutboundMessage,
  SendResult,
  WhatsAppProvider,
} from '../types.js';

const DEFAULT_GRAPH_VERSION = 'v20.0';

function resolveFetch(fetchImpl?: FetchLike): FetchLike {
  if (fetchImpl) return fetchImpl;
  const g = (globalThis as { fetch?: unknown }).fetch;
  if (typeof g !== 'function') {
    throw new Error('No fetch implementation available; pass config.fetchImpl.');
  }
  return g as FetchLike;
}

/** Map Meta's `message.type` to our normalized content kind. */
function mapContentType(metaType: string): InboundContentType {
  switch (metaType) {
    case 'text':
      return 'text';
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'document':
      return 'document';
    case 'location':
      return 'location';
    case 'contacts':
      return 'contacts';
    case 'interactive':
    case 'button':
      return 'interactive';
    default:
      return 'unknown';
  }
}

/** Map an interactive message onto Meta's `interactive` object. */
function buildInteractive(message: OutboundInteractive): Record<string, unknown> {
  const shell = {
    ...(message.header ? { header: { type: 'text', text: message.header } } : {}),
    body: { text: message.body },
    ...(message.footer ? { footer: { text: message.footer } } : {}),
  };

  switch (message.interactive) {
    case 'buttons':
      return {
        type: 'button',
        ...shell,
        action: {
          buttons: message.buttons.map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title },
          })),
        },
      };
    case 'list':
      return {
        type: 'list',
        ...shell,
        action: {
          button: message.buttonText,
          sections: message.sections.map((s) => ({
            title: s.title,
            rows: s.rows.map((r) => ({
              id: r.id,
              title: r.title,
              ...(r.description ? { description: r.description } : {}),
            })),
          })),
        },
      };
    case 'cta_url':
      return {
        type: 'cta_url',
        ...shell,
        action: {
          name: 'cta_url',
          parameters: { display_text: message.displayText, url: message.url },
        },
      };
    case 'flow':
      return {
        type: 'flow',
        ...shell,
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_id: message.flowId,
            flow_cta: message.ctaText,
            flow_token: message.flowToken,
            flow_action: 'navigate',
            flow_action_payload: {
              screen: message.screen,
              ...(message.flowActionPayload ? { data: message.flowActionPayload } : {}),
            },
          },
        },
      };
  }
}

export class MetaWhatsAppProvider implements WhatsAppProvider {
  readonly id = 'meta' as const;
  private readonly fetchImpl: FetchLike;
  private readonly graphVersion: string;

  constructor(private readonly config: MetaProviderConfig) {
    this.fetchImpl = resolveFetch(config.fetchImpl);
    this.graphVersion = config.graphVersion ?? DEFAULT_GRAPH_VERSION;
  }

  private get messagesUrl(): string {
    return `https://graph.facebook.com/${this.graphVersion}/${this.config.phoneNumberId}/messages`;
  }

  /** Build the Graph API request body for any outbound shape. */
  private buildBody(message: OutboundMessage): Record<string, unknown> {
    const base = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: message.to,
    };

    switch (message.kind) {
      case 'text':
        return {
          ...base,
          type: 'text',
          text: {
            preview_url: message.previewUrl ?? false,
            body: message.body,
          },
        };
      case 'template':
        return {
          ...base,
          type: 'template',
          template: {
            name: message.templateName,
            language: { code: message.languageCode },
            ...(message.parameters && message.parameters.length > 0
              ? {
                  components: [
                    {
                      type: 'body',
                      parameters: message.parameters.map((text) => ({
                        type: 'text',
                        text,
                      })),
                    },
                  ],
                }
              : {}),
          },
        };
      case 'media':
        return {
          ...base,
          type: message.mediaKind,
          [message.mediaKind]: {
            link: message.url,
            ...(message.caption !== undefined ? { caption: message.caption } : {}),
            ...(message.filename !== undefined ? { filename: message.filename } : {}),
          },
        };
      case 'interactive':
        return {
          ...base,
          type: 'interactive',
          interactive: buildInteractive(message),
        };
    }
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.config.accessToken || !this.config.phoneNumberId) {
      return { success: false, error: 'Meta provider missing accessToken/phoneNumberId' };
    }

    // Fail here rather than as an opaque Graph 400 in front of a member.
    if (message.kind === 'interactive') {
      const errors = validateInteractive(message);
      if (errors.length > 0) {
        return { success: false, error: `Invalid interactive message: ${errors.join('; ')}` };
      }
    }

    try {
      const res = await this.fetchImpl(this.messagesUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(this.buildBody(message)),
      });

      const json = (await res.json()) as {
        messages?: Array<{ id?: string }>;
        error?: { message?: string };
      };

      if (!res.ok) {
        return {
          success: false,
          error: json.error?.message ?? `Meta API error (HTTP ${res.status})`,
          statusCode: res.status,
        };
      }

      const externalId = json.messages?.[0]?.id;
      return externalId !== undefined
        ? { success: true, externalId }
        : { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Meta send failed' };
    }
  }

  parseInbound(payload: unknown): InboundMessage[] {
    const data = payload as {
      entry?: Array<{
        changes?: Array<{
          value?: {
            metadata?: { phone_number_id?: string; display_phone_number?: string };
            contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
            messages?: Array<Record<string, unknown>>;
          };
        }>;
      }>;
    };

    const out: InboundMessage[] = [];

    for (const entry of data.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value?.messages) continue;

        const phoneNumberId = value.metadata?.phone_number_id;
        const businessNumber = value.metadata?.display_phone_number ?? phoneNumberId ?? '';
        const contactName = value.contacts?.[0]?.profile?.name;

        for (const raw of value.messages) {
          const m = raw as {
            id?: string;
            from?: string;
            type?: string;
            timestamp?: string;
            text?: { body?: string };
            image?: { id?: string; mime_type?: string; caption?: string };
            video?: { id?: string; mime_type?: string; caption?: string };
            audio?: { id?: string; mime_type?: string };
            document?: { id?: string; mime_type?: string; caption?: string; filename?: string };
            location?: { latitude?: number; longitude?: number; name?: string; address?: string };
          };

          const metaType = m.type ?? 'unknown';
          const contentType = mapContentType(metaType);
          const timestamp = m.timestamp
            ? new Date(parseInt(m.timestamp, 10) * 1000)
            : new Date();

          const msg: InboundMessage = {
            provider: 'meta',
            externalId: m.id ?? '',
            from: m.from ?? '',
            to: businessNumber,
            contentType,
            text: '',
            timestamp,
            raw,
            ...(contactName !== undefined ? { senderName: contactName } : {}),
            ...(phoneNumberId !== undefined ? { channelId: phoneNumberId } : {}),
          };

          switch (metaType) {
            case 'text':
              msg.text = m.text?.body ?? '';
              break;
            case 'image':
            case 'video':
            case 'audio':
            case 'document': {
              const media = (m as Record<string, { id?: string; mime_type?: string; caption?: string; filename?: string }>)[metaType];
              msg.text = media?.caption ?? '';
              if (media?.id) {
                msg.media = {
                  providerRef: media.id,
                  refKind: 'id',
                  ...(media.mime_type !== undefined ? { mimeType: media.mime_type } : {}),
                  ...(media.filename !== undefined ? { filename: media.filename } : {}),
                  ...(media.caption !== undefined ? { caption: media.caption } : {}),
                };
              }
              break;
            }
            case 'location':
              if (m.location) {
                msg.location = {
                  latitude: m.location.latitude ?? 0,
                  longitude: m.location.longitude ?? 0,
                  ...(m.location.name !== undefined ? { name: m.location.name } : {}),
                  ...(m.location.address !== undefined ? { address: m.location.address } : {}),
                };
              }
              break;
            default:
              break;
          }

          out.push(msg);
        }
      }
    }

    return out;
  }

  /**
   * A {@link MediaResolver} that turns a Meta media id into a downloadable CDN
   * URL via the Graph API, attaching the bearer token needed to fetch it.
   */
  mediaResolver(): MediaResolver {
    const fetchImpl = this.fetchImpl;
    const version = this.graphVersion;
    const token = this.config.accessToken;
    return {
      async resolve(media) {
        if (media.refKind === 'url') {
          return { url: media.providerRef, headers: { Authorization: `Bearer ${token}` } };
        }
        const res = await fetchImpl(`https://graph.facebook.com/${version}/${media.providerRef}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          throw new Error(`Meta media lookup failed (HTTP ${res.status}) for ${media.providerRef}`);
        }
        const json = (await res.json()) as { url?: string };
        if (!json.url) {
          throw new Error(`Meta media lookup returned no URL for ${media.providerRef}`);
        }
        return { url: json.url, headers: { Authorization: `Bearer ${token}` } };
      },
    };
  }
}
