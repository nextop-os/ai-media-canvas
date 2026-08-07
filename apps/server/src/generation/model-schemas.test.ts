import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";

import type { ServerEnv } from "../config/env.js";
import { getImageGenerationModelSchema } from "./model-schema-catalog.js";
import {
  validateImageGenerationParams,
  validateVideoGenerationParams,
} from "./model-schemas.js";
import { registerAllProviders } from "./providers/register-all.js";
import {
  clearProviders,
  getAvailableImageModels,
  getAvailableVideoModels,
} from "./providers/registry.js";

describe("generation model schemas", () => {
  afterEach(() => {
    clearProviders();
  });

  it("attaches Ajv-compilable Draft 2020-12 schemas to every registered image and video model", () => {
    registerAllProviders(ALL_PROVIDER_ENV);

    const ajv = new Ajv2020({ strict: false });
    const models = [...getAvailableImageModels(), ...getAvailableVideoModels()];

    expect(models.length).toBeGreaterThan(20);
    for (const model of models) {
      expect(model.schema, model.id).toBeDefined();
      const { schema } = model;
      if (!schema) throw new Error(`Missing schema for ${model.id}`);
      expect(schema.$schema, model.id).toBe(
        "https://json-schema.org/draft/2020-12/schema",
      );
      expect(() => ajv.compile(schema)).not.toThrow();
    }
  });

  it("validates Kie image model input constraints", () => {
    registerAllProviders({ ...MINIMAL_SERVER_ENV, kieApiKey: "kie-key" });

    expect(() =>
      validateImageGenerationParams({
        prompt: "make a poster",
        model: "kie/z-image",
        inputImages: ["https://example.com/reference.png"],
      }),
    ).toThrow(/z-image/i);

    expect(() =>
      validateImageGenerationParams({
        prompt: "edit this",
        model: "kie/qwen2",
        inputImages: [
          "https://example.com/one.png",
          "https://example.com/two.png",
        ],
      }),
    ).toThrow(/inputImages/i);
  });

  it("limits Codex reference images to the attached-image tool capacity", () => {
    const schema = getImageGenerationModelSchema({
      id: "codex/gpt-image-2",
      displayName: "GPT Image 2",
      description: "Codex image generation",
    });

    expect(schema.properties.inputImages?.maxItems).toBe(5);
  });

  it("validates Kie video duration, resolution, and mode constraints", () => {
    registerAllProviders({ ...MINIMAL_SERVER_ENV, kieApiKey: "kie-key" });

    expect(() =>
      validateVideoGenerationParams({
        prompt: "dance",
        model: "kie/grok-imagine",
        resolution: "720p",
      }),
    ).toThrow(/480p/i);

    expect(() =>
      validateVideoGenerationParams({
        prompt: "runway shot",
        model: "kie/runway",
        duration: 10,
        resolution: "1080p",
      }),
    ).toThrow(/10-second/i);

    expect(() =>
      validateVideoGenerationParams({
        prompt: "character reference",
        model: "kie/veo-3.1",
        videoMode: "reference",
        inputImages: [
          "https://example.com/ref-a.png",
          "https://example.com/ref-b.png",
        ],
      }),
    ).toThrow(/reference/i);

    expect(() =>
      validateVideoGenerationParams({
        prompt: "seedance reference",
        model: "kie/seedance-2",
        videoMode: "reference",
        inputImages: ["https://example.com/ref.png"],
        duration: 10,
        resolution: "1080p",
      }),
    ).not.toThrow();

    for (const model of [
      "kie/kling-2.6",
      "kie/seedance-2",
      "kie/happyhorse-1",
    ]) {
      expect(() =>
        validateVideoGenerationParams({
          prompt: "too short",
          model,
          duration: 1,
          resolution: "720p",
        }),
      ).toThrow(/duration/i);
    }
  });
});

const MINIMAL_SERVER_ENV: ServerEnv = {
  agentBackendMode: "state",
  agentModel: "mock",
  port: 0,
  version: "test",
  webOrigin: "http://localhost:3000",
};

const ALL_PROVIDER_ENV: ServerEnv = {
  ...MINIMAL_SERVER_ENV,
  agnesApiKey: "agnes-key",
  kieApiKey: "kie-key",
  replicateApiToken: "replicate-key",
  googleApiKey: "google-key",
  googleVertexProject: "vertex-project",
  googleVertexLocation: "global",
  openAIApiKey: "openai-key",
  volcesApiKey: "volces-key",
};
