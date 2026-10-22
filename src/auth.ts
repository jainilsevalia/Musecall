import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a.toLowerCase(), "hex");
  const bb = Buffer.from(b.toLowerCase(), "hex");
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

/** Checks an `Authorization: Bearer <key>` header against the stored SHA-256 digest of the key. */
export function checkBearer(header: string | undefined, keySha256: string): boolean {
  if (!header) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!m) return false;
  return safeEqualHex(sha256Hex(m[1]), keySha256);
}

/** Token passed to Twilio as a Stream <Parameter> so only streams we started can attach to a call. */
export function streamToken(callId: string, secret: string): string {
  return createHmac("sha256", secret).update(`stream:${callId}`).digest("hex");
}

export function checkStreamToken(callId: string, token: string | undefined, secret: string): boolean {
  return !!token && /^[0-9a-f]+$/i.test(token) && safeEqualHex(token, streamToken(callId, secret));
}
