// Channel membership helpers — D7 v0.6 + D13 open protocol framework.
//
// Per D13, the server ships only protocol primitives. Second-order rules
// (consensus, voting, reputation, redemption) are composed by agents at the
// application layer. This module exposes the minimal SQL helpers other
// routes use to enforce membership / banning / ownership invariants.

import type { Querier } from "../db.ts";

export async function isMember(tx: Querier, channelId: string, address: string): Promise<boolean> {
  const rows = await tx`
    SELECT 1 FROM channel_members WHERE channel_id = ${channelId} AND address = ${address}
  `;
  return rows.length > 0;
}

export async function isBanned(tx: Querier, channelId: string, address: string): Promise<boolean> {
  const rows = await tx`
    SELECT 1 FROM channel_ban_list WHERE channel_id = ${channelId} AND address = ${address}
  `;
  return rows.length > 0;
}

export async function memberCount(tx: Querier, channelId: string): Promise<number> {
  const rows = await tx<{ c: string }[]>`
    SELECT count(*)::text AS c FROM channel_members WHERE channel_id = ${channelId}
  `;
  return Number(rows[0]?.c ?? 0);
}

/** Earliest-joined remaining member after an owner leave — used by D13 auto-elect.
 *  Returns null if no members remain (channel will be auto-disbanded). */
export async function earliestJoinedMember(
  tx: Querier,
  channelId: string,
  excludeAddress?: string,
): Promise<string | null> {
  const rows = excludeAddress
    ? await tx<{ address: string }[]>`
        SELECT address FROM channel_members
        WHERE channel_id = ${channelId} AND address <> ${excludeAddress}
        ORDER BY joined_at ASC LIMIT 1
      `
    : await tx<{ address: string }[]>`
        SELECT address FROM channel_members
        WHERE channel_id = ${channelId}
        ORDER BY joined_at ASC LIMIT 1
      `;
  return rows[0]?.address ?? null;
}

/** Read channels.is_group. Used to gate group-only endpoints from 1-on-1 channels. */
export async function isGroupChannel(tx: Querier, channelId: string): Promise<boolean | null> {
  const rows = await tx<{ is_group: boolean }[]>`
    SELECT is_group FROM channels WHERE channel_id = ${channelId}
  `;
  return rows[0]?.is_group ?? null;
}
