/**
 * Opt-out / compliance.
 *
 * Detects unsubscribe keywords (English + Mexican-Spanish variants) on inbound
 * messages and exposes an {@link OptOutStore} seam so apps can persist opt-out
 * state in their own database (or anywhere). Detection is intentionally strict:
 * the *entire* trimmed message must equal a keyword, so "no quiero parar" is NOT
 * treated as opt-out while "PARAR" is.
 */

/**
 * Default opt-out keywords. Matches campfire-v2's set: international `STOP`
 * plus common Mexican-Spanish unsubscribe phrasings.
 */
export const DEFAULT_OPT_OUT_KEYWORDS: readonly string[] = [
  'STOP',
  'BAJA',
  'CANCELAR',
  'ALTO',
  'PARAR',
  'NO MAS',
  'NOMAS',
  'UNSUBSCRIBE',
];

/** Default keywords that re-subscribe a previously opted-out customer. */
export const DEFAULT_OPT_IN_KEYWORDS: readonly string[] = [
  'START',
  'ALTA',
  'UNSTOP',
  'SUSCRIBIR',
];

function normalize(content: string): string {
  // Collapse internal whitespace so "NO   MAS" still matches "NO MAS".
  return content.trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * Returns the matched keyword (normalized) when `content` is an opt-out
 * message, or null otherwise. Whole-message match only — no substring matching.
 */
export function detectOptOut(
  content: string,
  keywords: readonly string[] = DEFAULT_OPT_OUT_KEYWORDS
): string | null {
  if (!content) return null;
  const normalized = normalize(content);
  for (const keyword of keywords) {
    if (normalized === normalize(keyword)) return keyword;
  }
  return null;
}

/** Convenience boolean wrapper around {@link detectOptOut}. */
export function isOptOut(
  content: string,
  keywords: readonly string[] = DEFAULT_OPT_OUT_KEYWORDS
): boolean {
  return detectOptOut(content, keywords) !== null;
}

/** Returns the matched opt-in keyword, or null. */
export function detectOptIn(
  content: string,
  keywords: readonly string[] = DEFAULT_OPT_IN_KEYWORDS
): string | null {
  if (!content) return null;
  const normalized = normalize(content);
  for (const keyword of keywords) {
    if (normalized === normalize(keyword)) return keyword;
  }
  return null;
}

/**
 * Persistence seam for opt-out state. Apps back this with their own store
 * (Supabase table, etc.). All methods are keyed by the customer phone number
 * in the same normalized form used elsewhere in the core (digits, no prefix).
 */
export interface OptOutStore {
  /** Record that a customer opted out. `keyword` is the trigger that matched. */
  optOut(phone: string, keyword: string): Promise<void>;
  /** Record that a customer opted back in. */
  optIn(phone: string): Promise<void>;
  /** Whether a customer is currently opted out. */
  isOptedOut(phone: string): Promise<boolean>;
}

/** In-memory {@link OptOutStore} for tests and local dev. */
export class InMemoryOptOutStore implements OptOutStore {
  private readonly out = new Set<string>();

  async optOut(phone: string, _keyword: string): Promise<void> {
    this.out.add(phone);
  }

  async optIn(phone: string): Promise<void> {
    this.out.delete(phone);
  }

  async isOptedOut(phone: string): Promise<boolean> {
    return this.out.has(phone);
  }
}

/**
 * Apply an inbound message's content to an {@link OptOutStore}: opt out on an
 * opt-out keyword, opt back in on an opt-in keyword, otherwise no-op. Returns
 * what action was taken so the webhook handler can decide on acknowledgements.
 */
export async function applyComplianceKeywords(
  store: OptOutStore,
  phone: string,
  content: string,
  options?: {
    optOutKeywords?: readonly string[];
    optInKeywords?: readonly string[];
  }
): Promise<{ action: 'opt_out' | 'opt_in' | 'none'; keyword?: string }> {
  const outKeyword = detectOptOut(content, options?.optOutKeywords ?? DEFAULT_OPT_OUT_KEYWORDS);
  if (outKeyword) {
    await store.optOut(phone, outKeyword);
    return { action: 'opt_out', keyword: outKeyword };
  }

  const inKeyword = detectOptIn(content, options?.optInKeywords ?? DEFAULT_OPT_IN_KEYWORDS);
  if (inKeyword) {
    await store.optIn(phone);
    return { action: 'opt_in', keyword: inKeyword };
  }

  return { action: 'none' };
}
