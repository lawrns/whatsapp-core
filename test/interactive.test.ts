import { describe, expect, it } from 'vitest';
import { MetaWhatsAppProvider } from '../src/providers/meta.js';
import { TwilioWhatsAppProvider } from '../src/providers/twilio.js';
import { validateInteractive } from '../src/interactive.js';
import type { OutboundButtons, OutboundFlow, OutboundList } from '../src/types.js';

const buttons = (overrides: Partial<OutboundButtons> = {}): OutboundButtons => ({
  kind: 'interactive',
  interactive: 'buttons',
  to: '5216145547454',
  body: '¿Listo para entrenar?',
  buttons: [
    { id: 'start', title: 'Empezar' },
    { id: 'why', title: '¿Por qué cambió?' },
  ],
  ...overrides,
});

/** Capture the Graph request body without hitting the network. */
function captureBody() {
  const sent: unknown[] = [];
  const fetchImpl = async (_url: string, init?: { body?: string }) => {
    sent.push(JSON.parse(init?.body ?? '{}'));
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.TEST' }] }),
    };
  };
  const provider = new MetaWhatsAppProvider({
    accessToken: 't',
    phoneNumberId: '1154738041061726',
    fetchImpl: fetchImpl as never,
  });
  return { provider, sent };
}

describe('validateInteractive', () => {
  it('accepts a well-formed button message', () => {
    expect(validateInteractive(buttons())).toEqual([]);
  });

  it('rejects a 4th button — Meta caps reply buttons at 3', () => {
    const errors = validateInteractive(
      buttons({
        buttons: [
          { id: 'a', title: 'A' },
          { id: 'b', title: 'B' },
          { id: 'c', title: 'C' },
          { id: 'd', title: 'D' },
        ],
      })
    );
    expect(errors.join(' ')).toMatch(/exceeds Meta's max of 3/);
  });

  it('rejects a button title over 20 chars', () => {
    const errors = validateInteractive(
      buttons({ buttons: [{ id: 'x', title: 'Reportar una molestia muy larga' }] })
    );
    expect(errors.join(' ')).toMatch(/exceeds 20 chars/);
  });

  it('counts emoji as single characters, not UTF-16 code units', () => {
    // '🏋️' is multi-code-unit; naive .length would over-count and false-reject.
    expect(validateInteractive(buttons({ buttons: [{ id: 'go', title: 'Empezar 🏋️' }] }))).toEqual(
      []
    );
  });

  it('rejects duplicate button ids — the webhook could not disambiguate them', () => {
    const errors = validateInteractive(
      buttons({
        buttons: [
          { id: 'same', title: 'Uno' },
          { id: 'same', title: 'Dos' },
        ],
      })
    );
    expect(errors.join(' ')).toMatch(/duplicate button id/);
  });

  it('rejects an 11th list row', () => {
    const list: OutboundList = {
      kind: 'interactive',
      interactive: 'list',
      to: '52',
      body: 'Elige el día',
      buttonText: 'Ver días',
      sections: [
        {
          title: 'Semana',
          rows: Array.from({ length: 11 }, (_, i) => ({ id: `d${i}`, title: `Día ${i}` })),
        },
      ],
    };
    expect(validateInteractive(list).join(' ')).toMatch(/exceeds Meta's max of 10/);
  });
});

describe('MetaWhatsAppProvider interactive payloads', () => {
  it('maps reply buttons onto Meta type=button', async () => {
    const { provider, sent } = captureBody();
    const res = await provider.send(buttons());
    expect(res.success).toBe(true);
    expect(sent[0]).toMatchObject({
      messaging_product: 'whatsapp',
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: '¿Listo para entrenar?' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'start', title: 'Empezar' } },
            { type: 'reply', reply: { id: 'why', title: '¿Por qué cambió?' } },
          ],
        },
      },
    });
  });

  it('maps a Flow onto action.name=flow with a navigate payload', async () => {
    const { provider, sent } = captureBody();
    const flow: OutboundFlow = {
      kind: 'interactive',
      interactive: 'flow',
      to: '52',
      body: 'Antes de empezar',
      flowId: '123',
      ctaText: 'Responder',
      screen: 'READINESS',
      flowToken: 'tok-abc',
      flowActionPayload: { memberId: 'gaby' },
    };
    await provider.send(flow);
    expect(sent[0]).toMatchObject({
      interactive: {
        type: 'flow',
        action: {
          name: 'flow',
          parameters: {
            flow_id: '123',
            flow_cta: 'Responder',
            flow_token: 'tok-abc',
            flow_action: 'navigate',
            flow_action_payload: { screen: 'READINESS', data: { memberId: 'gaby' } },
          },
        },
      },
    });
  });

  it('refuses to send an invalid message instead of letting Graph 400', async () => {
    const { provider, sent } = captureBody();
    const res = await provider.send(
      buttons({ buttons: [{ id: 'x', title: 'Un título larguísimo que no cabe' }] })
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Invalid interactive message/);
    expect(sent).toHaveLength(0); // never left the process
  });
});

describe('TwilioWhatsAppProvider', () => {
  it('fails explicitly on interactive rather than sending an empty body', async () => {
    const provider = new TwilioWhatsAppProvider({
      accountSid: 'AC',
      authToken: 't',
      fromNumber: '+52',
      fetchImpl: (async () => {
        throw new Error('must not be called');
      }) as never,
    });
    const res = await provider.send(buttons());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/does not support interactive/);
  });
});
