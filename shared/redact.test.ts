import { describe, expect, test } from "bun:test";
import { redactSecrets, redactSecretsDeep } from "./redact.ts";

describe("redactSecrets", () => {
  test("redacts OpenAI sk- keys", () => {
    const msg = "401 Incorrect API key provided: sk-70ce0AbCdEfGhIjKlMnOpQrStUvWx. You can find your API key at...";
    const out = redactSecrets(msg);
    expect(out).not.toContain("sk-70ce0");
    expect(out).toContain("sk-***");
  });

  test("redacts Anthropic-style sk- keys", () => {
    const msg = "401 invalid x-api-key: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh";
    expect(redactSecrets(msg)).toContain("sk-***");
    expect(redactSecrets(msg)).not.toContain("AbCdEfGh");
  });

  test("redacts Bearer tokens", () => {
    const msg = "401 Unauthorized — Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig";
    expect(redactSecrets(msg)).toContain("Bearer ***");
    expect(redactSecrets(msg)).not.toContain("eyJ");
  });

  test("redacts AWS access key id", () => {
    expect(redactSecrets("AWS error: AKIAIOSFODNN7EXAMPLE failed")).toContain("AWS_AKIA_***");
  });

  test("redacts Google API key", () => {
    expect(redactSecrets("key=AIzaSyA-1234567890abcdefghijklmnopqrstuvwxA")).toContain("AIza_***");
  });

  test("redacts GitHub PAT", () => {
    expect(redactSecrets("token ghp_1234567890ABCDEFGHIJKLMNOPQRSTUV1234")).toContain("gh_***");
  });

  test("redacts Slack token", () => {
    expect(redactSecrets("xoxb-1234567890-abcdefg-XYZ")).toContain("xox_***");
  });

  test("does not eat short benign strings", () => {
    expect(redactSecrets("sk-foo")).toBe("sk-foo");
    expect(redactSecrets("Bearer")).toBe("Bearer");
    expect(redactSecrets("AKIA")).toBe("AKIA");
  });

  test("preserves non-secret content around redaction", () => {
    const msg = "[OpenAI] 401 sk-70ce0AbCdEfGhIjKlMnOpQrStUvWxYz at line 42";
    const out = redactSecrets(msg);
    expect(out.startsWith("[OpenAI] 401 sk-***")).toBe(true);
    expect(out.endsWith(" at line 42")).toBe(true);
  });

  test("handles multiple secrets in one string", () => {
    const msg = "key1=sk-AAAAAAAAAAAAAAAAAAAAAA key2=Bearer BBBBBBBBBBBB";
    const out = redactSecrets(msg);
    expect(out).toContain("sk-***");
    expect(out).toContain("Bearer ***");
    expect(out).not.toContain("AAAAAAAAAA");
    expect(out).not.toContain("BBBBBBBBBB");
  });
});

describe("redactSecretsDeep", () => {
  test("walks objects and arrays", () => {
    const ctx = {
      provider: "openai",
      message: "sk-70ce0AbCdEfGhIjKlMnOpQrStUvWxYz",
      tags: ["normal", "Bearer abcdefg.hijklmn.opqrstu"],
      nested: { token: "ghp_1234567890ABCDEFGHIJKLMNOPQRSTUV1234" },
    };
    const out = redactSecretsDeep(ctx);
    expect(out.message).toContain("sk-***");
    expect(out.tags[1]).toContain("Bearer ***");
    expect(out.nested.token).toContain("gh_***");
    expect(out.provider).toBe("openai");
    expect(out.tags[0]).toBe("normal");
  });

  test("passes null/undefined through", () => {
    expect(redactSecretsDeep(null)).toBe(null);
    expect(redactSecretsDeep(undefined)).toBe(undefined);
  });

  test("passes numbers/booleans through", () => {
    expect(redactSecretsDeep(42)).toBe(42);
    expect(redactSecretsDeep(true)).toBe(true);
  });
});
