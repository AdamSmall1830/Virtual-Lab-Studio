import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError, parseConfig } from "../src/config.js";

const VALID = {
  serverUrl: "https://studio.example.com",
  displayName: "Lab desktop",
  models: [
    {
      modelKey: "local-qwen",
      displayName: "Qwen (local)",
      baseUrl: "http://127.0.0.1:11434/v1",
      providerModelId: "qwen3:32b",
      apiKeyEnv: null,
      contextWindow: 32_768,
      maxTokens: 8_192,
      supportsTools: true,
      pricing: { input_per_million_usd: 0, output_per_million_usd: 0, currency: "USD" },
    },
  ],
};

describe("configuration loading", () => {
  it("accepts a complete configuration and applies the safe defaults", () => {
    const config = parseConfig(VALID, "/tmp/worker.config.json");
    assert.equal(config.concurrency, 1);
    assert.equal(config.sandbox.kind, "container");
    assert.equal(config.sandbox.network, "proxy");
    assert.equal(config.sandbox.allowUnsafeProcessRunner, false);
    assert.equal(config.agentRuntime, "auto");
  });

  it("refuses to start while a placeholder remains", () => {
    // An unconfigured worker that started would enroll, win jobs and fail every
    // one of them, which looks to the researcher like a broken product.
    const withPlaceholder = {
      ...VALID,
      serverUrl: "<REPLACE_ME: https://your-studio>",
    };
    assert.throws(
      () => parseConfig(withPlaceholder, "/tmp/worker.config.json"),
      (error: unknown) => error instanceof ConfigError && /REPLACE_ME/.test(error.message),
    );
  });

  it("finds a placeholder nested inside a model entry", () => {
    const nested = {
      ...VALID,
      models: [{ ...VALID.models[0], providerModelId: "<REPLACE_ME>" }],
    };
    assert.throws(() => parseConfig(nested, "/tmp/c.json"), /models\[0\]\.providerModelId/);
  });

  it("requires https for a remote studio", () => {
    assert.throws(
      () => parseConfig({ ...VALID, serverUrl: "http://studio.example.com" }, "/tmp/c.json"),
      /must use https/,
    );
  });

  it("allows plain http for localhost development", () => {
    const config = parseConfig({ ...VALID, serverUrl: "http://localhost:8080" }, "/tmp/c.json");
    assert.equal(config.serverUrl, "http://localhost:8080");
  });

  it("refuses credentials embedded in a model URL", () => {
    assert.throws(
      () =>
        parseConfig(
          { ...VALID, models: [{ ...VALID.models[0], baseUrl: "http://user:pass@host/v1" }] },
          "/tmp/c.json",
        ),
      /must not embed credentials/,
    );
  });

  it("refuses a duplicate model key", () => {
    assert.throws(
      () => parseConfig({ ...VALID, models: [VALID.models[0], VALID.models[0]] }, "/tmp/c.json"),
      /more than once/,
    );
  });

  it("refuses a configuration with no models", () => {
    assert.throws(() => parseConfig({ ...VALID, models: [] }, "/tmp/c.json"), /non-empty array/);
  });

  it("refuses an unknown container engine", () => {
    assert.throws(
      () => parseConfig({ ...VALID, sandbox: { engine: "runc-yolo" } }, "/tmp/c.json"),
      /docker.*podman/,
    );
  });

  it("refuses a concurrency outside the supported range", () => {
    assert.throws(() => parseConfig({ ...VALID, concurrency: 99 }, "/tmp/c.json"), /between 1 and 8/);
  });

  it("resolves relative paths against the configuration file", () => {
    const config = parseConfig(
      { ...VALID, workspaceRoot: "jobs", workerTokenFile: "token" },
      "/opt/vls/worker.config.json",
    );
    assert.equal(config.workspaceRoot, "/opt/vls/jobs");
    assert.equal(config.workerTokenFile, "/opt/vls/token");
  });
});
