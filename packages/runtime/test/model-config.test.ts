import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  baseUrlHost,
  defaultLocalModelConfig,
  parseModelConfig,
  probeModels,
  providerById,
  reachableProbedModels,
  readGatewayApiKey,
  resolveProviderApiKey,
  withEffectiveChatExit,
  writeModelConfig,
} from "../src/model-config.js";

const sample = {
  defaultProvider: "yishu-local-grok",
  providers: [
    {
      id: "yishu-local-grok",
      name: "本地模型 (BYOK)",
      baseUrl: "http://127.0.0.1:8317/v1",
      apiKey: "sk-local",
      models: ["grok-4.6", "grok-4.5"],
      defaultModel: "grok-4.6",
    },
    {
      id: "second",
      name: "第二家",
      baseUrl: "http://example.com/v1",
      apiKeyEnv: "SECOND_API_KEY",
      models: ["m1"],
    },
  ],
};

test("parseModelConfig reads providers and resolves the default", () => {
  const cfg = parseModelConfig(JSON.stringify(sample));
  assert.equal(cfg.providers[0].baseUrl, "http://127.0.0.1:8317/v1");
  assert.equal(cfg.providers[0].defaultModel, "grok-4.6");
  assert.equal(providerById(cfg).id, "yishu-local-grok");
  assert.equal(providerById(cfg, "second").baseUrl, "http://example.com/v1");
});

test("parseModelConfig rejects a default provider that is not listed", () => {
  const bad = { ...sample, defaultProvider: "missing" };
  assert.throws(() => parseModelConfig(JSON.stringify(bad)), /defaultProvider not found/);
});

test("resolveProviderApiKey prefers inline key over the env reference", () => {
  assert.equal(resolveProviderApiKey(sample.providers[0]), "sk-local");
});

test("resolveProviderApiKey falls through to the environment variable", () => {
  const previous = process.env.SECOND_API_KEY;
  process.env.SECOND_API_KEY = "env-secret";
  try {
    assert.equal(resolveProviderApiKey(sample.providers[1]), "env-secret");
  } finally {
    if (previous === undefined) delete process.env.SECOND_API_KEY;
    else process.env.SECOND_API_KEY = previous;
  }
});

test("default model config keeps the product usable with no file", () => {
  const cfg = defaultLocalModelConfig();
  assert.equal(cfg.defaultProvider, "yishu-local-grok");
  assert.equal(cfg.chatExit, "direct");
  assert.equal(cfg.providers[0].baseUrl, "https://api.minimaxi.com/v1");
  assert.equal(cfg.providers[0].name, "MiniMax 直连");
  assert.equal(cfg.providers[0].apiKeyEnv, "MINIMAX_API_KEY");
  assert.deepEqual(cfg.providers[0].models, ["MiniMax-M3"]);
});

test("writeModelConfig refuses inline apiKey fields", async () => {
  await assert.rejects(
    () => writeModelConfig(parseModelConfig(JSON.stringify(sample)), "/tmp/yishu-model-config-test.json"),
    /credentialRef/,
  );
});

test("chatExit overlay switches the effective host and display name", () => {
  const cfg = parseModelConfig(JSON.stringify({
    ...sample,
    chatExit: "direct",
  }));
  const provider = providerById(cfg);
  const previous = process.env.YISHU_CHAT_EXIT;
  delete process.env.YISHU_CHAT_EXIT;
  try {
    const direct = withEffectiveChatExit(cfg, provider);
    assert.equal(direct.exit, "direct");
    assert.equal(baseUrlHost(direct.baseUrl), "api.minimaxi.com");
    assert.equal(direct.name, "MiniMax 直连");
    process.env.YISHU_CHAT_EXIT = "gateway";
    const gateway = withEffectiveChatExit(cfg, provider);
    assert.equal(gateway.exit, "gateway");
    assert.equal(baseUrlHost(gateway.baseUrl), "127.0.0.1:8317");
    assert.equal(gateway.name, "CLI 网关");
  } finally {
    if (previous === undefined) delete process.env.YISHU_CHAT_EXIT;
    else process.env.YISHU_CHAT_EXIT = previous;
  }
});

test("readGatewayApiKey takes api-keys[0] without logging", () => {
  const home = mkdtempSync(join(tmpdir(), "yishu-gateway-"));
  mkdirSync(join(home, ".cli-proxy-api"));
  writeFileSync(join(home, ".cli-proxy-api", "config.yaml"), "api-keys:\n  - gw-secret-key\n");
  assert.equal(readGatewayApiKey(home), "gw-secret-key");
});

test("probeModels keeps only reachable streaming models", async () => {
  const cfg = parseModelConfig(JSON.stringify({
    defaultProvider: "yishu-local-grok",
    chatExit: "direct",
    providers: [{
      id: "yishu-local-grok",
      name: "MiniMax 直连",
      baseUrl: "https://api.minimaxi.com/v1",
      apiKey: "sk-test",
      models: ["MiniMax-M3", "dead-model"],
    }],
  }));
  const seenModels: string[] = [];
  const probingFetch: typeof fetch = (async (_input, init) => {
    const parsed = JSON.parse(String(init && typeof init === "object" && "body" in init ? init.body : "{}")) as { model?: string };
    seenModels.push(parsed.model ?? "");
    if (parsed.model === "dead-model") {
      return new Response("nope", { status: 404 });
    }
    return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"h\"}}]}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const results = await probeModels(cfg, { fetchImpl: probingFetch, timeoutMs: 200 });
  assert.deepEqual(seenModels, ["MiniMax-M3", "dead-model"]);
  assert.equal(results.find((row) => row.id === "MiniMax-M3")?.reachable, true);
  assert.equal(results.find((row) => row.id === "dead-model")?.reachable, false);
  assert.equal(reachableProbedModels(results).length, 1);
  assert.equal(reachableProbedModels(results)[0]?.baseUrlHost, "api.minimaxi.com");
});
