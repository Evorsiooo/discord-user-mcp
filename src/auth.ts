// Shared-secret bearer check for the /mcp endpoint.

const MIN_SECRET_LENGTH = 32;
const encoder = new TextEncoder();

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/**
 * True only if the request carries `Authorization: Bearer <secret>`.
 * Both sides are hashed first so the comparison always runs over 32 bytes,
 * whatever the lengths, and the byte loop never exits early.
 * Fails closed when the secret is missing or too short.
 */
export async function isAuthorized(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret || secret.length < MIN_SECRET_LENGTH) return false;
  const header = request.headers.get("Authorization") ?? "";
  const [expected, actual] = await Promise.all([sha256(`Bearer ${secret}`), sha256(header)]);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i]! ^ actual[i]!;
  return diff === 0;
}
