/**
 * Validation for interactive messages.
 *
 * Meta rejects an over-long button title or an 11th list row with an opaque
 * Graph 400 that surfaces at runtime, in production, to a real member. These
 * checks turn that into a local failure with a message naming the offender.
 */
import { INTERACTIVE_LIMITS as L, type OutboundInteractive } from './types.js';

const over = (value: string, max: number): boolean => [...value].length > max;

/**
 * @returns a list of human-readable violations; empty means the message is
 * within Meta's limits.
 */
export function validateInteractive(message: OutboundInteractive): string[] {
  const errors: string[] = [];

  if (!message.body.trim()) errors.push('body is required');
  if (over(message.body, L.body)) errors.push(`body exceeds ${L.body} chars`);
  if (message.header && over(message.header, L.header))
    errors.push(`header exceeds ${L.header} chars`);
  if (message.footer && over(message.footer, L.footer))
    errors.push(`footer exceeds ${L.footer} chars`);

  switch (message.interactive) {
    case 'buttons': {
      const { buttons } = message;
      if (buttons.length === 0) errors.push('at least 1 button is required');
      if (buttons.length > L.maxButtons)
        errors.push(
          `${buttons.length} buttons exceeds Meta's max of ${L.maxButtons} — use a list instead`
        );
      const seen = new Set<string>();
      for (const b of buttons) {
        if (over(b.title, L.buttonTitle))
          errors.push(`button title "${b.title}" exceeds ${L.buttonTitle} chars`);
        if (over(b.id, L.buttonId)) errors.push(`button id "${b.id}" exceeds ${L.buttonId} chars`);
        if (seen.has(b.id)) errors.push(`duplicate button id "${b.id}"`);
        seen.add(b.id);
      }
      break;
    }
    case 'list': {
      if (over(message.buttonText, L.listButton))
        errors.push(`list button text exceeds ${L.listButton} chars`);
      const rows = message.sections.flatMap((s) => s.rows);
      if (rows.length === 0) errors.push('at least 1 row is required');
      if (rows.length > L.maxListRows)
        errors.push(`${rows.length} rows exceeds Meta's max of ${L.maxListRows}`);
      const seen = new Set<string>();
      for (const s of message.sections) {
        if (over(s.title, L.sectionTitle))
          errors.push(`section title "${s.title}" exceeds ${L.sectionTitle} chars`);
      }
      for (const r of rows) {
        if (over(r.title, L.rowTitle))
          errors.push(`row title "${r.title}" exceeds ${L.rowTitle} chars`);
        if (r.description && over(r.description, L.rowDescription))
          errors.push(`row description for "${r.title}" exceeds ${L.rowDescription} chars`);
        if (seen.has(r.id)) errors.push(`duplicate row id "${r.id}"`);
        seen.add(r.id);
      }
      break;
    }
    case 'cta_url': {
      if (!/^https?:\/\//i.test(message.url)) errors.push('cta_url url must be http(s)');
      if (over(message.displayText, L.buttonTitle))
        errors.push(`cta display text exceeds ${L.buttonTitle} chars`);
      break;
    }
    case 'flow': {
      if (!message.flowId) errors.push('flowId is required');
      if (!message.flowToken) errors.push('flowToken is required');
      if (over(message.ctaText, L.buttonTitle))
        errors.push(`flow cta text exceeds ${L.buttonTitle} chars`);
      break;
    }
  }

  return errors;
}
