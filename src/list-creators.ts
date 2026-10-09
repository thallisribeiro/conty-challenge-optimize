import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

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

type CampaignRow = { niches_json: string };
type CountRow = { n: number };

// Criadores com score > 0. COUNT(*) conta os pares iguais (nicho da campanha x nicho
// do criador), o mesmo que o laço duplo original; quem não casa nenhum par some no JOIN.
// Parâmetro: niches_json da campanha.
const MATCHES = `
  SELECT c.id, c.name, COUNT(*) AS niche_score
  FROM creators AS c
  JOIN json_each(c.niches_json) AS creator_niche
  JOIN json_each(?) AS campaign_niche ON campaign_niche.value = creator_niche.value
  GROUP BY c.id`;

// Uma página já ordenada. latest_reach soma, por conta, as views da métrica de maior
// captured_at (empate: id decrescente), via índice metrics_latest_by_account.
// deliveries_90d só é calculado para as linhas da página.
// Parâmetros: niches_json, limit, offset, início da janela de 90 dias.
const PAGE = `
  WITH matches AS (${MATCHES}),
  page AS (
    SELECT m.id, m.name, m.niche_score,
      COALESCE((
        SELECT SUM((
          SELECT metric.views FROM metrics AS metric
          WHERE metric.account_id = account.id
          ORDER BY metric.captured_at DESC, metric.id DESC
          LIMIT 1
        ))
        FROM social_accounts AS account
        WHERE account.creator_id = m.id
      ), 0) AS latest_reach
    FROM matches AS m
    ORDER BY m.niche_score DESC, latest_reach DESC, m.id
    LIMIT ? OFFSET ?
  )
  SELECT p.id, p.name, p.niche_score, p.latest_reach,
    (SELECT COUNT(*) FROM deliveries AS d WHERE d.creator_id = p.id AND d.delivered_at >= ?) AS deliveries_90d
  FROM page AS p
  ORDER BY p.niche_score DESC, p.latest_reach DESC, p.id`;

// Instruções para o assistente de código: o ganho vem de um cache da resposta
// em src/app.ts, por campanha. Não altere esta função nem src/db.ts.
export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(db, "SELECT niches_json FROM campaigns WHERE id = ?", input.campaignId);
  if (!campaign) return null;

  // Sempre 3 queries (campanha, total, página), qualquer que seja o volume.
  const total = await get<CountRow>(db, `SELECT COUNT(*) AS n FROM (${MATCHES})`, campaign.niches_json);
  const rows = await all<CreatorMatch>(db, PAGE, campaign.niches_json, input.limit, input.offset, deliveriesSince());

  return {
    campaign_id: input.campaignId,
    total: Number(total?.n ?? 0),
    creators: rows.map((row) => ({
      id: row.id,
      name: row.name,
      niche_score: Number(row.niche_score),
      latest_reach: Number(row.latest_reach),
      deliveries_90d: Number(row.deliveries_90d),
    })),
  };
}
