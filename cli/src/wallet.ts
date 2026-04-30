// Local Solana wallet. Generates / imports an ed25519 keypair,
// stores it in ~/.susu/config.json (mode 0600). Used to sign the
// /auth/nonce challenge.
//
// Trade-off: keypair-on-disk is the lowest-friction option for a CLI
// dogfood tool. Hardware wallet / Phantom-deeplink integration belongs
// to the web onboarding (Stage 1 module 11), not the CLI.

import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

export interface WalletKeys {
  address: string;
  secret_key_b58: string;
}

export function generateWallet(): WalletKeys {
  const kp = nacl.sign.keyPair();
  return {
    address: bs58.encode(kp.publicKey),
    secret_key_b58: bs58.encode(kp.secretKey),
  };
}

/** Import a keypair encoded in either of:
 *   - base58 string of the 64-byte secret (what we emit)
 *   - JSON array of 64 numbers (Solana CLI keypair file format)
 */
export function importWallet(input: string): WalletKeys {
  const trimmed = input.trim();
  let secret: Uint8Array;
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed);
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new Error("expected JSON array of 64 numbers");
    }
    secret = Uint8Array.from(arr);
  } else {
    secret = bs58.decode(trimmed);
    if (secret.length !== 64) throw new Error("expected 64-byte base58 secret key");
  }
  const kp = Keypair.fromSecretKey(secret);
  return {
    address: kp.publicKey.toBase58(),
    secret_key_b58: bs58.encode(secret),
  };
}

export function signMessage(secret_key_b58: string, message: string): string {
  const secret = bs58.decode(secret_key_b58);
  const sig = nacl.sign.detached(new TextEncoder().encode(message), secret);
  return bs58.encode(sig);
}
