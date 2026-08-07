import type { GenerationModelSchema, JsonSchemaObject } from "@aimc/shared";

type ModelLike = {
  schema?: GenerationModelSchema;
};

export function summarizeModelSchemaForTool(model: ModelLike): string {
  const schema = model.schema;
  if (!schema) return "schema limits unavailable";

  const parts: string[] = [];
  if (schema.description) parts.push(schema.description);
  addSchemaValue(parts, "aspectRatio", schema.properties.aspectRatio);
  addSchemaValue(parts, "duration", schema.properties.duration);
  addSchemaValue(parts, "resolution", schema.properties.resolution);

  const inputImages = schema.properties.inputImages;
  if (inputImages?.maxItems !== undefined) {
    parts.push(`inputImages: up to ${inputImages.maxItems}`);
  }

  const modes = schema["x-aimc-ui"].inputModes;
  if (modes?.length) {
    parts.push(
      `inputModes: ${modes
        .map((mode) => {
          const counts = [
            mode.minImages !== undefined ? `min ${mode.minImages}` : null,
            mode.maxImages !== undefined ? `max ${mode.maxImages}` : null,
          ].filter(Boolean);
          return counts.length ? `${mode.id} (${counts.join(", ")})` : mode.id;
        })
        .join(", ")}`,
    );
  }

  const supported = [
    isSupported(schema.properties.seed) ? "seed" : null,
    isSupported(schema.properties.size) ? "size" : null,
    isSupported(schema.properties.outputFormat) ? "outputFormat" : null,
    isSupported(schema.properties.negativePrompt) ? "negativePrompt" : null,
    isSupported(schema.properties.inputVideo) ? "inputVideo" : null,
    isSupported(schema.properties.frameRate) ? "frameRate" : null,
    isSupported(schema.properties.numFrames) ? "numFrames" : null,
    isSupported(schema.properties.enableAudio) ? "audio" : null,
  ].filter(Boolean);
  if (supported.length) {
    parts.push(`${supported.join(", ")} supported`);
  }

  return parts.length ? parts.join("; ") : "no extra parameter limits";
}

export function collectStringEnumValues(
  models: readonly ModelLike[],
  property: string,
): string[] {
  return [
    ...new Set(
      models.flatMap((model) =>
        ((model.schema?.properties[property]?.enum ?? []) as unknown[]).filter(
          (value): value is string => typeof value === "string",
        ),
      ),
    ),
  ];
}

function addSchemaValue(
  parts: string[],
  label: string,
  schema: JsonSchemaObject | undefined,
) {
  if (!schema) return;
  if (schema.enum?.length) {
    parts.push(`${label}: ${schema.enum.map(String).join(", ")}`);
    return;
  }
  const range = [
    schema.minimum !== undefined ? `min ${schema.minimum}` : null,
    schema.maximum !== undefined ? `max ${schema.maximum}` : null,
  ].filter(Boolean);
  if (range.length) {
    parts.push(`${label}: ${range.join(", ")}`);
  }
}

function isSupported(schema: JsonSchemaObject | undefined) {
  if (!schema) return false;
  if (schema.const === false) return false;
  if (schema.not?.const === true) return false;
  return true;
}
