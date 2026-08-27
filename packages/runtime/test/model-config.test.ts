import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultLocalModelConfig,
  parseModelConfig,
  providerById,
  resolveProviderApiKey,
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
  assert.equal(cfg.providers[0].baseUrl, "http://127.0.0.1:8317/v1");
  assert.equal(cfg.providers[0].apiKeyEnv, "YISHU_LOCAL_MODEL_API_KEY");
});

test("writeModelConfig refuses inline apiKey fields", async () => {
  await assert.rejects(
    () => writeModelConfig(parseModelConfig(JSON.stringify(sample)), "/tmp/yishu-model-config-test.json"),
    /credentialRef/,
  );
});
