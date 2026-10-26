import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { createCopilotCatalog } from "../src/models.ts";

test("Copilot reuses Pi auth, filters account models and never resolves an OpenRouter ref", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dna-copilot-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected live request");
  });
  const chosen = githubCopilotProvider().getModels()[0];
  const auth = {
    "github-copilot": {
      type: "oauth",
      access: "test-access",
      refresh: "test-refresh",
      expires: Date.now() + 3_600_000,
      availableModelIds: [chosen.id],
    },
    other: { type: "api_key", key: "preserve-me" },
  };
  const file = join(dir, "auth.json");
  writeFileSync(file, JSON.stringify(auth));
  for (let restart = 0; restart < 2; restart++) {
    const catalog = await createCopilotCatalog();
    assert.deepEqual(catalog.defaultModel, { provider: "github-copilot", modelId: chosen.id });
    assert.deepEqual(
      catalog.list().map((m) => m.id),
      [chosen.id],
    );
    assert.equal(catalog.info(chosen.id)?.contextWindow, chosen.contextWindow);
    assert.equal(catalog.models.getModel("github-copilot", chosen.id)?.cost.input, 0);
    assert.throws(() => catalog.ref("anthropic/claude-haiku-5.5"), /not available/);
  }
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), auth);
  await assert.rejects(createCopilotCatalog("not-enabled"), /not available/);
});

test("Copilot requires a Pi login even when an OpenRouter key is present", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dna-copilot-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const key = process.env.OPENROUTER_API_KEY;
  const copilotToken = process.env.COPILOT_GITHUB_TOKEN;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.OPENROUTER_API_KEY = "not-a-copilot-login";
  delete process.env.COPILOT_GITHUB_TOKEN;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (key === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = key;
    if (copilotToken !== undefined) process.env.COPILOT_GITHUB_TOKEN = copilotToken;
    rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(createCopilotCatalog(), /not signed in.*\/login/);
});
