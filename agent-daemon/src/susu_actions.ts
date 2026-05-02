// HTTP wrappers around the Susurration backend for the actions the daemon
// performs on behalf of the user. Kept separate from the LLM provider so
// the same action functions are reusable when we add CLI commands like
// `susu agent-daemon dry-run`.

export interface SusuClientConfig {
  api_url: string;
  token: string;
}

export interface PostSignalResult {
  signal_id: string;
  channel_id: string;
  cost_usd: number;
}

export interface PostReactionResult {
  reaction_id: string;
  signal_id: string;
  channel_id: string;
  cost_usd: number;
}

async function authedFetch(cfg: SusuClientConfig, path: string, init?: RequestInit) {
  const url = cfg.api_url.replace(/\/$/, "") + path;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "authorization": `Bearer ${cfg.token}`,
  };
  if (init?.headers) Object.assign(headers, init.headers);
  return fetch(url, { ...init, headers });
}

export async function pushSignal(
  cfg: SusuClientConfig,
  channelId: string,
  payload: Record<string, unknown>,
): Promise<PostSignalResult> {
  const resp = await authedFetch(cfg, `/channels/${channelId}/signals`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`pushSignal HTTP ${resp.status}: ${await resp.text()}`);
  const j = await resp.json() as any;
  return { signal_id: j.signal_id, channel_id: j.channel_id, cost_usd: j.cost_usd ?? 0 };
}

export async function pushReaction(
  cfg: SusuClientConfig,
  signalId: string,
  payload: Record<string, unknown>,
  isAuto = true,
): Promise<PostReactionResult> {
  const resp = await authedFetch(cfg, `/signals/${signalId}/reactions`, {
    method: "POST",
    // Mark agent-originated reactions with is_auto=true so peers can tell
    // them apart from human-typed reactions in their inbox UI.
    body: JSON.stringify({ payload, is_auto: isAuto }),
  });
  if (!resp.ok) throw new Error(`pushReaction HTTP ${resp.status}: ${await resp.text()}`);
  const j = await resp.json() as any;
  return {
    reaction_id: j.reaction_id,
    signal_id: j.signal_id,
    channel_id: j.channel_id,
    cost_usd: j.cost_usd ?? 0,
  };
}

export interface ChannelHistory {
  signals: any[];
}

export async function recentSignals(
  cfg: SusuClientConfig,
  channelId: string,
  limit = 20,
): Promise<ChannelHistory> {
  const resp = await authedFetch(cfg, `/channels/${channelId}/signals?limit=${limit}`);
  if (!resp.ok) throw new Error(`recentSignals HTTP ${resp.status}: ${await resp.text()}`);
  return await resp.json() as ChannelHistory;
}

export async function whoami(cfg: SusuClientConfig): Promise<{ address: string; username: string | null; handle: string | null }> {
  const resp = await authedFetch(cfg, `/me`);
  if (!resp.ok) throw new Error(`whoami HTTP ${resp.status}: ${await resp.text()}`);
  return await resp.json() as any;
}
