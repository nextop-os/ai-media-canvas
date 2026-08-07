import type { GenerationModelSchema } from "@aimc/shared";

/** Metadata describing a model supported by a provider. */
export interface ModelInfo {
  /** Provider-scoped model ID, e.g. "google/nano-banana-pro" */
  id: string;
  /** Human-readable name shown to users */
  displayName: string;
  /** Short description for LLM model selection */
  description: string;
  /** URL to the model owner's avatar/icon */
  iconUrl?: string;
  /** AIMC standard model parameter schema. */
  schema?: GenerationModelSchema;
}

/**
 * Semantic quality levels — each provider translates to its own resolution param.
 * - standard: ~1K (fastest, preview quality)
 * - hd:       ~2K (default, production quality)
 * - ultra:    ~4K (highest, print quality — not all models support this)
 */
export type ImageQuality = "standard" | "hd" | "ultra";

export type OutputFormat = "png" | "jpg" | "webp";

export interface ImageGenerateParams {
  prompt: string;
  model: string;
  aspectRatio?: string;
  inputImages?: string[];
  /** Provider-specific size override, e.g. "1536x1024". */
  size?: string;
  /** Semantic quality level, provider translates to model-specific resolution */
  quality?: ImageQuality;
  /** Output format preference */
  outputFormat?: OutputFormat;
  /** Optional deterministic seed when the provider supports it. */
  seed?: number;
  metadata?: Record<string, unknown>;
}

export interface GeneratedImage {
  url: string;
  mimeType: string;
  width: number;
  height: number;
}

export interface ImageProvider {
  readonly name: string;
  readonly models: readonly ModelInfo[];
  generate(params: ImageGenerateParams): Promise<GeneratedImage>;
}

export interface VideoGenerateParams {
  prompt: string;
  model: string;
  resolution?: "480p" | "720p" | "1080p" | "4k" | "2160p";
  duration?: number;
  aspectRatio?: string;
  inputImages?: string[];
  inputVideo?: string;
  videoMode?: "multivideo" | "keyframes" | "reference";
  seed?: number;
  negativePrompt?: string;
  frameRate?: number;
  numFrames?: number;
  /** Enable audio generation (only supported by some providers). */
  enableAudio?: boolean;
  metadata?: Record<string, unknown>;
}

export interface GeneratedVideo {
  url: string;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds: number;
  /** Effective output resolution after any provider-side normalization. */
  resolution?: "480p" | "720p" | "1080p" | "4k" | "2160p";
}

export interface VideoProvider {
  readonly name: string;
  readonly models: readonly VideoModelInfo[];
  generate(params: VideoGenerateParams): Promise<GeneratedVideo>;
  resume?(
    remoteTaskId: string,
    params: VideoGenerateParams,
  ): Promise<GeneratedVideo>;
}

/** Extended model info with video-specific capabilities metadata. */
export interface VideoModelInfo extends ModelInfo {
  capabilities: {
    textToVideo: boolean;
    imageToVideo: boolean;
    videoToVideo: boolean;
    audio: boolean;
  };
  limits: {
    maxDuration: number;
    allowedDurations?: number[];
    maxResolution: "480p" | "720p" | "1080p" | "2160p";
    maxInputImages: number;
  };
}
