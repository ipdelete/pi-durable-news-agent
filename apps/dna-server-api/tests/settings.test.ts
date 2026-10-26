import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DnaError } from "@dna/sdk";
import { loadConfig } from "../src/config.ts";
import { bootServer, idle, settledSweep, type Booted } from "./server.ts";

let s: Booted;

test("Copilot configuration does not inherit OpenRouter model IDs or change jev's provider", () => {
  const config = loadConfig([], { DNA_PROVIDER: "github-copilot", JEV_BACKEND: "openrouter" });
  assert.equal(config.provider, "github-copilot");
  assert.equal(config.model, "");
  assert.equal(config.researchModel, "");
  assert.equal(config.jevBackend, "openrouter");
  assert.throws(() => loadConfig([], { DNA_PROVIDER: "typo" }), /Unknown DNA_PROVIDER/);
});
before(async () => {
  s = await bootServer({ FIRECRAWL_API_KEY: "" });
});
after(() => s.cleanup());

const fails = async (p: Promise<unknown>, pattern: RegExp) => {
  await assert.rejects(
    p,
    (e: unknown) => e instanceof DnaError && e.status === 400 && pattern.test(e.message),
  );
};

test("compaction points: defaults, validation, and they persist across a restart", async () => {
  const start = await s.client.compaction();
  assert.deepEqual(
    { background: start.background, force: start.force, enabled: start.enabled },
    { background: 100_000, force: 200_000, enabled: true },
  );
  await fails(
    s.client.setCompaction({ background: 199_000 }),
    /at least 1024 tokens below the force point/,
  );
  await fails(s.client.setCompaction({ background: 1_000 }), /at least 4096/);
  await fails(s.client.setCompaction({ force: start.window }), /must leave at least/);
  const next = await s.client.setCompaction({ background: 80_000, force: 150_000 });
  assert.equal(next.background, 80_000);
  assert.equal((await s.client.agent()).compaction.force, 150_000);
  await s.stop();
  await s.start();
  const after = await s.client.compaction();
  assert.deepEqual([after.background, after.force], [80_000, 150_000]);
});

test("model and thinking changes validate against the catalog", async () => {
  await fails(s.client.configure({ model: "nope/not-a-model" }), /Unknown model nope\/not-a-model/);
  await fails(
    s.client.configure({}),
    /Send model, thinkingLevel, quickModel, quickThinking, deepResearchModel, deepResearchThinking, deepResearchCount, or a mix/,
  );
  const state = await s.client.configure({ model: "faux-haiku", thinkingLevel: "medium" });
  assert.equal(state.model, "faux-haiku");
  assert.equal(state.thinkingLevel, "medium");
  assert.deepEqual(state.quick, { model: "anthropic/claude-haiku-5.5", thinkingLevel: "off" });
  await fails(s.client.configure({ quickModel: "nope/x" }), /Unknown model nope\/x/);
  const quick = await s.client.configure({ quickModel: "openai/gpt-6-luna", quickThinking: "low" });
  assert.deepEqual(quick.quick, { model: "openai/gpt-6-luna", thinkingLevel: "low" });
  assert.equal(quick.model, "faux-haiku", "the quick model leaves the agent's model alone");
  assert.deepEqual(quick.deepResearch, {
    model: "anthropic/claude-haiku-5.5",
    thinkingLevel: "xhigh",
    count: 1,
  });
  await fails(s.client.configure({ deepResearchCount: 6 }), /deepResearchCount/);
  await fails(s.client.configure({ deepResearchThinking: "max" as never }), /deepResearchThinking/);
  const deep = await s.client.configure({
    deepResearchModel: "openai/gpt-6-luna",
    deepResearchThinking: "high",
    deepResearchCount: 5,
  });
  assert.deepEqual(deep.deepResearch, {
    model: "openai/gpt-6-luna",
    thinkingLevel: "high",
    count: 5,
  });
  assert.deepEqual(deep.quick, quick.quick, "deep research leaves the quick model alone");
});

test("show me more and less move topic weights, card detail shows the feedback, bad bodies are 400", async () => {
  const started = await s.cron.newsSweep({ requestId: "settings:1" });
  await settledSweep(s.client, started.data.sweep!.id);
  await idle(s.client);
  const card = (await s.client.feed()).items.find((c) =>
    c.title.toLowerCase().includes("durable"),
  )!;
  const before = await s.client.keywords("topic");
  const more = await s.client.feedback(card.id, { signal: "more" });
  assert.ok(more.changed.length >= 1);
  for (const c of more.changed) assert.ok(c.to > c.from, `${c.term} went up`);
  const after = await s.client.keywords("topic");
  const moved = after.find((k) => k.id === more.changed[0].id)!;
  assert.ok(moved.weight > before.find((k) => k.id === moved.id)!.weight);
  const less = await s.client.feedback(card.id, { signal: "less" });
  for (const c of less.changed) assert.ok(c.to < c.from);
  const detail = await s.client.card(card.id);
  assert.equal(detail.card.feedback?.signal, "less");
  assert.ok(
    detail.item && detail.findings.length >= 1 && detail.toolCall?.toolName === "present_news",
  );
  await fails(s.client.feedback(card.id, {}), /signal/);
  await fails(s.client.feedback(card.id, { labels: ["vibes" as never] }), /labels must be one of/);
});

test("feed search finds news by words, keyword and url, and validates its query", async () => {
  const card = (await s.client.feed()).items.find((c) => c.url)!;
  const word = card.title.split(/\s+/).find((w) => w.length > 4)!;
  assert.ok((await s.client.search({ q: word.toUpperCase() })).some((c) => c.id === card.id));
  const site = new URL(card.url!).hostname;
  const bySite = await s.client.search({ q: `https://${site}/`, by: "url" });
  assert.ok(bySite.length >= 1 && bySite.every((c) => c.url!.includes(site)));
  assert.deepEqual(await s.client.search({ q: "zzqx nothing matches" }), []);
  await fails(s.client.search({ q: " " }), /q must be a non empty string/);
  await fails(s.client.search({ q: "x", by: "vibes" as never }), /by must be one of/);
});

test("keyword and source edits", async () => {
  const k = await s.client.addKeyword({ kind: "signal", term: "abi break", weight: 1.2 });
  assert.equal(k.kind, "signal");
  await fails(s.client.addKeyword({ kind: "signal", term: "abi break" }), /already has/);
  assert.equal((await s.client.updateKeyword(k.id, { weight: 5 }).catch((e) => e)).status, 400);
  assert.equal(
    (await s.client.updateKeyword(k.id, { weight: 0.5, enabled: false })).enabled,
    false,
  );
  await s.client.removeKeyword(k.id);
  assert.ok(!(await s.client.keywords("signal")).some((x) => x.id === k.id));

  const src = await s.client.addSource({
    kind: "rss",
    name: "Example",
    url: "https://example.com/feed.xml",
  });
  await fails(
    s.client.addSource({ kind: "rss", name: "Bad", url: "http://example.com/feed" }),
    /https/,
  );
  assert.equal((await s.client.updateSource(src.id, { enabled: false })).enabled, false);
  await s.client.removeSource(src.id);
});

test("compact now runs a compaction task", async () => {
  const { taskId } = await s.client.compact("Keep the sweep summaries.");
  assert.ok(taskId > 0);
  await idle(s.client);
});

test("the tool list: every tool once with its agents, params from the schema, what it returns, and the definition", async () => {
  const tools = await s.client.tools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  assert.equal(byName.size, tools.length, "each tool once");
  const search = byName.get("search_web")!;
  assert.deepEqual(search.agents.sort(), ["news-desk", "news-researcher"]);
  assert.deepEqual(
    search.params.map((p) => [p.name, p.type, p.required]),
    [
      ["query", "string", true],
      ["hours", "integer", false],
      ["sweep_id", "integer", false],
    ],
  );
  assert.match(search.returns ?? "", /one line per hit/);
  assert.equal((search.definition.parameters as { type: string }).type, "object");
  const present = byName.get("present_news")!;
  assert.deepEqual(present.agents, ["news-desk"]);
  assert.ok(present.params.find((p) => p.name === "component")!.values!.includes("signal_alert"));
  assert.ok(present.example);
  assert.ok(
    tools.every((t) => t.returns),
    "every tool says what it returns",
  );
  assert.equal(
    byName.has("hyper_fetch"),
    true,
    "hyper_fetch reads directly without a Firecrawl key",
  );
});
