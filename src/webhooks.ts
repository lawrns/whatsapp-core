/**
 * Webhook signature verification — fail-closed for both providers.
 *
 * "Fail-closed" means: any ambiguity (missing/empty secret, missing/empty
 * signature, malformed header, length mismatch, bad MAC) results in rejection.
 * We never default to "allow" on error. Comparisons use a constant-time
 * algorithm to avoid leaking the expected MAC via timing.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string compare. Returns false immediately on length mismatch
 * (length is not secret) and otherwise compares all bytes in constant time.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verify Meta's `X-Hub-Signature-256` header.
 *
 * Meta sends `sha256=<hexdigest>` where the digest is HMAC-SHA256 of the raw
 * request body keyed by the app secret. We recompute and compare in constant
 * time. The raw body string MUST be the exact bytes received (re-serializing
 * parsed JSON will not match).
 *
 * @param rawBody  Exact raw request body as received.
 * @param header   Value of the `X-Hub-Signature-256` header (with or without
 *                 the `sha256=` prefix).
 * @param appSecret Meta app secret.
 */
export function verifyMetaSignature(
  rawBody: string,
  header: string | null | undefined,
  appSecret: string | null | undefined
): boolean {
  // Fail-closed: no secret means we cannot trust anything.
  if (!appSecret) return false;
  if (!header) return false;

  // Meta always sends a lowercase `sha256=` prefix; strip it case-insensitively
  // so an upper/mixed-case header still verifies.
  const signature = /^sha256=/i.test(header) ? header.slice(7) : header;
  if (signature.length === 0) return false;

  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  return safeEqual(signature.toLowerCase(), expected.toLowerCase());
}

/**
 * Handle Meta's GET verification handshake (subscribe challenge).
 *
 * Returns the challenge string to echo back when `mode === 'subscribe'` and the
 * verify token matches; otherwise null (caller should respond 403). Fail-closed
 * on an empty configured verify token.
 *
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 */
export function verifyMetaChallenge(
  params: {
    mode?: string | null;
    token?: string | null;
    challenge?: string | null;
  },
  verifyToken: string | null | undefined
): string | null {
  if (!verifyToken) return null;
  if (params.mode !== 'subscribe') return null;
  if (!params.token || !safeEqual(params.token, verifyToken)) return null;
  return params.challenge ?? null;
}

/**
 * Verify a Twilio `X-Twilio-Signature` header.
 *
 * Twilio's algorithm (for application/x-www-form-urlencoded POSTs):
 *   1. Start with the full request URL (exactly as configured, including query).
 *   2. Sort POST params by key; append each `key + value` (no separators).
 *   3. HMAC-SHA1 the concatenation with the auth token, base64-encode.
 *   4. Compare to the `X-Twilio-Signature` header.
 *
 * Fail-closed: missing/empty auth token, signature, or URL => reject.
 *
 * @param authToken Twilio auth token (the signing key).
 * @param url       The exact URL Twilio was configured to call.
 * @param params    The POSTed form parameters.
 * @param header    Value of the `X-Twilio-Signature` header.
 * @see https://www.twilio.com/docs/usage/security#validating-requests
 */
export function verifyTwilioSignature(
  authToken: string | null | undefined,
  url: string | null | undefined,
  params: Record<string, string> | null | undefined,
  header: string | null | undefined
): boolean {
  if (!authToken) return false;
  if (!url) return false;
  if (!header) return false;

  const sortedKeys = Object.keys(params ?? {}).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + String((params as Record<string, string>)[key]);
  }

  const expected = createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
  return safeEqual(header, expected);
}
