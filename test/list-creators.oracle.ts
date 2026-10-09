// Oráculo: cópia da implementação original de src/list-creators.ts (commit b319e26),
// sem mudança de lógica (só os caminhos dos imports e um comentário). Serve de referência para
// provar que a versão otimizada devolve exatamente a mesma listagem.
import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "../src/clock.ts";
import { all, get } from "../src/db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { id: string; niches_json: string; raw_payload?: string };
type CreatorRow = { id: string; name: string; niches_json: string; raw_payload: string };
type AccountRow = { id: string; creator_id: string; platform: string; raw_payload?: string };
type MetricRow = { views: number; raw_payload?: string };
type CountRow = { n: number };

function compareCreators(left: CreatorMatch, right: CreatorMatch): number {
  if (right.niche_score !== left.niche_score) return right.niche_score - left.niche_score;
  if (right.latest_reach !== left.latest_reach) return right.latest_reach - left.latest_reach;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(db, "SELECT * FROM campaigns WHERE id = ?", input.campaignId);
  if (!campaign) return null;

  const creators = await all<CreatorRow>(db, "SELECT * FROM creators");
  const since = deliveriesSince();
  const scored: CreatorMatch[] = [];

  for (const creator of creators) {
    const campaignNiches = JSON.parse(campaign.niches_json) as string[];
    const creatorNiches = JSON.parse(creator.niches_json) as string[];
    let nicheScore = 0;
    for (const campaignNiche of campaignNiches) {
      for (const creatorNiche of creatorNiches) {
        if (campaignNiche === creatorNiche) nicheScore += 1;
      }
    }
    if (nicheScore === 0) continue;

    const accounts = await all<AccountRow>(
      db,
      "SELECT * FROM social_accounts WHERE creator_id = ?",
      creator.id,
    );
    let latestReach = 0;
    for (const account of accounts) {
      const metric = await get<MetricRow>(
        db,
        "SELECT * FROM metrics WHERE account_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1",
        account.id,
      );
      if (metric) latestReach += metric.views;
    }

    const deliveries = await get<CountRow>(
      db,
      "SELECT COUNT(*) AS n FROM deliveries WHERE creator_id = ? AND delivered_at >= ?",
      creator.id,
      since,
    );

    scored.push({
      id: creator.id,
      name: creator.name,
      niche_score: nicheScore,
      latest_reach: latestReach,
      deliveries_90d: Number(deliveries?.n ?? 0),
    });
  }

  scored.sort(compareCreators);
  return {
    campaign_id: input.campaignId,
    total: scored.length,
    creators: scored.slice(input.offset, input.offset + input.limit),
  };
}
