// Test preload — runs before any test file is imported, so env vars set
// here are visible to `src/config.ts` on its first (and only) module load.
//
// Why preload not per-file beforeAll: config.ts caches process.env reads
// at module load time. The first test file to import anything from src/
// transitively loads config; subsequent files see the cached snapshot.
// Setting env in a per-file `beforeAll` is too late.

if (!process.env.SUSU_ADMIN_TOKEN) {
  process.env.SUSU_ADMIN_TOKEN = "test-admin-token-e2e";
}
