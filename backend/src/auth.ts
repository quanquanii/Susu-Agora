// Solana wallet sign-in: nonce challenge + ed25519 signature verify.
// Flow:
//   1. Client POST /auth/nonce {address} → server returns nonce + message string
//   2. Client signs message with Phantom (or any Solana keypair)
//   3. Client POST /auth/verify {address, signature_b58, nonce}
//      → server verifies, issues bearer token (sessions table)
//   4. Subsequent requests carry Authorization: Bearer <token>

import nacl from "tweetnacl";
import bs58 from "bs58";
import { sql } from "./db.ts";
import { config } from "./config.ts";
import { recordEvent } from "./lib/events.ts";

export class AuthError extends Error {
  constructor(public status: number, public reason: string) {
    super(reason);
  }
}

const NONCE_BYTES = 24;
const TOKEN_BYTES = 32;

function randomB64(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString("base64url");
}

export function buildSignInMessage(address: string, nonce: string): string {
  // Human-readable so wallet UIs (Phantom) display it clearly.
  // Order and exact text matter — client must reproduce byte-for-byte.
  return [
    "Susurration sign-in",
    `address: ${address}`,
    `nonce: ${nonce}`,
    "By signing you authenticate this wallet to Susurration.",
  ].join("\n");
}

export async function issueNonce(address: string): Promise<{ nonce: string; message: string; expires_at: string }> {
  if (!isValidSolanaAddress(address)) {
    throw new AuthError(400, "invalid solana address");
  }
  const nonce = randomB64(NONCE_BYTES);
  const expiresAt = new Date(Date.now() + config.authNonceTtlSec * 1000);
  await sql`
    INSERT INTO auth_nonces(nonce, address, expires_at)
    VALUES (${nonce}, ${address}, ${expiresAt})
  `;
  return { nonce, message: buildSignInMessage(address, nonce), expires_at: expiresAt.toISOString() };
}

export async function verifySignatureAndIssueSession(args: {
  address: string;
  nonce: string;
  signature_b58: string;
  handle?: string | null;
}): Promise<{ token: string; expires_at: string; address: string }> {
  const { address, nonce, signature_b58, handle = null } = args;

  if (!isValidSolanaAddress(address)) {
    throw new AuthError(400, "invalid solana address");
  }

  const rows = await sql<{ address: string; expires_at: Date; consumed: boolean }[]>`
    SELECT address, expires_at, consumed FROM auth_nonces WHERE nonce = ${nonce}
  `;
  const row = rows[0];
  if (!row) throw new AuthError(400, "nonce not found");
  if (row.consumed) throw new AuthError(400, "nonce already consumed");
  if (row.address !== address) throw new AuthError(400, "nonce/address mismatch");
  if (row.expires_at.getTime() < Date.now()) throw new AuthError(400, "nonce expired");

  // Verify ed25519 signature over the canonical message.
  const message = new TextEncoder().encode(buildSignInMessage(address, nonce));
  let signature: Uint8Array;
  let pubkey: Uint8Array;
  try {
    signature = bs58.decode(signature_b58);
    pubkey = bs58.decode(address);
  } catch {
    throw new AuthError(400, "malformed signature or address");
  }
  if (signature.length !== 64) throw new AuthError(400, "invalid signature length");
  if (pubkey.length !== 32) throw new AuthError(400, "invalid pubkey length");

  const ok = nacl.sign.detached.verify(message, signature, pubkey);
  if (!ok) throw new AuthError(401, "signature verify failed");

  // Atomic: consume nonce + upsert identity + create session.
  const token = randomB64(TOKEN_BYTES);
  const expiresAt = new Date(Date.now() + config.sessionTtlSec * 1000);

  await sql.begin(async (tx) => {
    const upd = await tx`
      UPDATE auth_nonces SET consumed = true
      WHERE nonce = ${nonce} AND consumed = false
      RETURNING nonce
    `;
    if (upd.length === 0) throw new AuthError(409, "nonce race");

    await tx`
      INSERT INTO identities(address, handle)
      VALUES (${address}, ${handle})
      ON CONFLICT (address) DO UPDATE SET handle = COALESCE(EXCLUDED.handle, identities.handle)
    `;

    await tx`
      INSERT INTO sessions(token, address, expires_at)
      VALUES (${token}, ${address}, ${expiresAt})
    `;
  });

  // BETA telemetry: top-of-funnel signal. Funnel query in admin/funnel
  // looks for 'auth_signin' to compute signin → register → push conversion.
  recordEvent({ type: "auth_signin", address });

  return { token, expires_at: expiresAt.toISOString(), address };
}

export async function authedAddress(authHeader: string | null | undefined): Promise<string> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AuthError(401, "missing bearer token");
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) throw new AuthError(401, "empty bearer token");

  const rows = await sql<{ address: string; expires_at: Date }[]>`
    SELECT address, expires_at FROM sessions WHERE token = ${token}
  `;
  const row = rows[0];
  if (!row) throw new AuthError(401, "invalid token");
  if (row.expires_at.getTime() < Date.now()) throw new AuthError(401, "session expired");
  return row.address;
}

// R2: single-use SSE auth token. Issued on demand via POST /auth/stream-token
// (requires bearer), spent atomically when the SSE handler authenticates.
const STREAM_TOKEN_BYTES = 24;
const STREAM_TOKEN_TTL_SEC = 5 * 60;

export async function issueStreamToken(address: string): Promise<{ stream_token: string; expires_at: string }> {
  const tok = randomB64(STREAM_TOKEN_BYTES);
  const expiresAt = new Date(Date.now() + STREAM_TOKEN_TTL_SEC * 1000);
  await sql`
    INSERT INTO stream_tokens(token, address, expires_at)
    VALUES (${tok}, ${address}, ${expiresAt})
  `;
  return { stream_token: tok, expires_at: expiresAt.toISOString() };
}

export async function consumeStreamToken(token: string): Promise<string> {
  // Atomic single-use: UPDATE returning the address only if the row was
  // unconsumed AND not expired. Concurrent consumers race here; only one wins.
  const rows = await sql<{ address: string }[]>`
    UPDATE stream_tokens
    SET consumed = true
    WHERE token = ${token}
      AND consumed = false
      AND expires_at > now()
    RETURNING address
  `;
  const row = rows[0];
  if (!row) throw new AuthError(401, "invalid or expired stream_token");
  return row.address;
}

export function isValidSolanaAddress(s: string): boolean {
  // Solana base58 addresses are 32-byte ed25519 public keys → 43-44 base58 chars.
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try {
    const decoded = bs58.decode(s);
    return decoded.length === 32;
  } catch {
    return false;
  }
}
