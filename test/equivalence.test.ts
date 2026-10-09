import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { deliveriesSince } from "../src/clock.ts";
import { getQueryCount, openDatabase, resetQueryCount } from "../src/db.ts";
import { listCreators } from "../src/list-creators.ts";
import { BENCH_SEED, CAMPAIGN_ID, seed } from "../src/seed.ts";
import { listCreators as originalListCreators } from "./list-creators.oracle.ts";

function mulberry32(seedValue: number): () => number {
  let state = seedValue;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Banco determinístico feito para empatar: poucos valores de views e de captured_at,
// ids sem zero à esquerda (crt_10 < crt_9) inseridos fora de ordem, nichos repetidos,
// criadores sem conta, contas sem métrica e entregas em cima do limite dos 90 dias.
function seedWithTies(db: DatabaseSync, creators: number, seedValue: number): void {
  const rand = mulberry32(seedValue);
  const below = (n: number) => Math.floor(rand() * n);
  const pick = <T>(items: readonly T[]): T => items[below(items.length)] as T;
  const niches = ["beleza", "moda", "tech", "games"];
  const views = [0, 100, 200];
  const capturedAt = ["2026-05-30T00:00:00.000Z", "2026-05-31T00:00:00.000Z"];
  const since = Date.parse(deliveriesSince());
  const deliveredAt = [since, since - 1, since + 86_400_000, since - 86_400_000].map((ms) =>
    new Date(ms).toISOString(),
  );

  const ids = Array.from({ length: creators }, (_, i) => `crt_${i + 1}`);
  for (let i = ids.length - 1; i > 0; i -= 1) {
    const j = below(i + 1);
    [ids[i], ids[j]] = [ids[j] as string, ids[i] as string];
  }

  const campaign = db.prepare("INSERT INTO campaigns VALUES (?, ?, ?)");
  const creator = db.prepare("INSERT INTO creators VALUES (?, ?, ?, '')");
  const account = db.prepare("INSERT INTO social_accounts VALUES (?, ?, 'instagram')");
  const metric = db.prepare("INSERT INTO metrics VALUES (?, ?, ?, ?, '')");
  const delivery = db.prepare("INSERT INTO deliveries VALUES (?, ?, ?)");

  db.exec("BEGIN");
  campaign.run("cmp_ties", "Empates", JSON.stringify(["beleza", "moda", "tech"]));
  campaign.run("cmp_dup", "Nicho repetido", JSON.stringify(["moda", "moda", "games"]));
  for (const id of ids) {
    creator.run(id, `Nome ${id}`, JSON.stringify(Array.from({ length: below(4) }, () => pick(niches))));
    for (let a = below(3); a > 0; a -= 1) {
      const accountId = `acc_${id}_${a}`;
      account.run(accountId, id);
      for (let m = below(4); m > 0; m -= 1) {
        metric.run(`met_${below(1000)}_${accountId}_${m}`, accountId, pick(views), pick(capturedAt));
      }
    }
    for (let d = below(4); d > 0; d -= 1) delivery.run(`del_${id}_${d}`, id, pick(deliveredAt));
  }
  db.exec("COMMIT");
}

type Input = { campaignId: string; limit: number; offset: number };

// Compara cada página (e duas além do fim) com o oráculo, em JSON serializado:
// mesma ordem, mesmos valores, mesma ordem de chaves.
async function expectSamePages(db: DatabaseSync, campaignId: string, limit: number): Promise<number> {
  const total = (await originalListCreators(db, { campaignId, limit, offset: 0 }))?.total ?? 0;
  for (let offset = 0; offset <= total + 2 * limit; offset += limit) {
    const input: Input = { campaignId, limit, offset };
    const expected = JSON.stringify(await originalListCreators(db, input));
    expect(JSON.stringify(await listCreators(db, input)), `offset ${offset}`).toBe(expected);
  }
  return total;
}

describe("equivalência com a implementação original (oráculo)", () => {
  const tiesDb = openDatabase(":memory:");
  seedWithTies(tiesDb, 800, 42);

  it("o banco de teste tem empates de verdade em niche_score + latest_reach", async () => {
    const full = await originalListCreators(tiesDb, { campaignId: "cmp_ties", limit: 1_000_000, offset: 0 });
    const creators = full?.creators ?? [];
    let tied = 0;
    for (let i = 1; i < creators.length; i += 1) {
      const [prev, cur] = [creators[i - 1], creators[i]];
      if (prev?.niche_score === cur?.niche_score && prev?.latest_reach === cur?.latest_reach) tied += 1;
    }
    expect(creators.length).toBeGreaterThan(400);
    expect(tied).toBeGreaterThan(creators.length / 2);
  });

  it("lista igual à original página por página com muitos empates, inclusive além do fim", async () => {
    expect(await expectSamePages(tiesDb, "cmp_ties", 20)).toBeGreaterThan(400);
    expect(await expectSamePages(tiesDb, "cmp_dup", 20)).toBeGreaterThan(400);
  }, 60_000);

  it("lista igual à original com páginas que cortam grupos de empate (limit 7 e 50)", async () => {
    await expectSamePages(tiesDb, "cmp_ties", 7);
    await expectSamePages(tiesDb, "cmp_ties", 50);
  }, 60_000);

  it("offset muito além do fim devolve lista vazia com o mesmo total da original", async () => {
    const input: Input = { campaignId: "cmp_ties", limit: 20, offset: Number.MAX_SAFE_INTEGER };
    const page = await listCreators(tiesDb, input);
    expect(page?.creators).toEqual([]);
    expect(JSON.stringify(page)).toBe(JSON.stringify(await originalListCreators(tiesDb, input)));
  });

  it("o JSON da API é idêntico ao da original no volume do bench (2000 criadores)", async () => {
    const db = openDatabase(":memory:");
    seed(db, BENCH_SEED);
    const app = createApp(db);
    const total = (await originalListCreators(db, { campaignId: CAMPAIGN_ID, limit: 50, offset: 0 }))?.total ?? 0;
    expect(total).toBeGreaterThan(1000);
    for (let offset = 0; offset <= total + 50; offset += 50) {
      const res = await app.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=50&offset=${offset}`);
      const expected = await originalListCreators(db, { campaignId: CAMPAIGN_ID, limit: 50, offset });
      expect(await res.text(), `offset ${offset}`).toBe(JSON.stringify(expected));
    }
  }, 60_000);
});

describe("orçamento de queries", () => {
  it("a página de 20 gasta o mesmo número de queries (no máximo 8) com 80, 600 e 5000 criadores", async () => {
    const counts: number[] = [];
    for (const creators of [80, 600, 5000]) {
      const db = openDatabase(":memory:");
      seed(db, { creators, seed: 7 });
      const app = createApp(db);
      for (const offset of [0, 20, 100_000]) {
        resetQueryCount();
        const res = await app.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=20&offset=${offset}`);
        expect(res.status).toBe(200);
        counts.push(getQueryCount());
      }
    }
    expect(Math.max(...counts)).toBeLessThanOrEqual(8);
    expect(new Set(counts).size).toBe(1);
  }, 30_000);
});
