import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { resolveProcessInvocation } from "@tutti-os/agent-acp-kit/process-adapter";

import type {
  GeneratedImage,
  ImageGenerateParams,
  ImageProvider,
  ModelInfo,
} from "../types.js";
import { GenerationError, aspectRatioToDimensions } from "../utils.js";
import type { CodexImagegenCapability } from "./codex-imagegen-capability.js";

const ICON_CODEX = "https://github.com/openai.png";
const DEFAULT_CODEX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CODEX_IMAGEGEN_AGENT_MODEL = "gpt-5.5";
const CODEX_IMAGEGEN_REASONING_EFFORT = "low";
const GENERATED_IMAGE_POLL_MS = 100;
const CODEX_IMAGEGEN_MODEL_ID = "codex/gpt-image-2";
const CODEX_IMAGEGEN_MAX_INPUT_IMAGES = 5;

export const CODEX_IMAGEGEN_MODELS: readonly ModelInfo[] = [
  {
    id: CODEX_IMAGEGEN_MODEL_ID,
    displayName: "GPT Image 2",
    description:
      "Routes image generation through the signed-in local Codex image generation tool.",
    iconUrl: ICON_CODEX,
  },
];

export type CodexImagegenExec = (
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    generatedImagesDir: string;
    timeoutMs: number;
  },
) => Promise<{ stdout: string; stderr: string; imagePath: string }>;

export interface CodexImagegenProviderOptions {
  codexPath?: string;
  codexHome?: string;
  agentModel?: string;
  timeoutMs?: number;
  execCodex?: CodexImagegenExec;
  createExecCodex?: (command: string) => CodexImagegenExec;
  resolveCapability?: () => Promise<CodexImagegenCapability>;
}

export class CodexImagegenProvider implements ImageProvider {
  readonly name = "codex-imagegen";
  readonly models = CODEX_IMAGEGEN_MODELS;
  private readonly codexPath: string;
  private readonly codexHome: string | undefined;
  private readonly agentModel: string;
  private readonly timeoutMs: number;
  private readonly execCodex: CodexImagegenExec | undefined;
  private readonly createExecCodex: (command: string) => CodexImagegenExec;
  private readonly resolveCapability:
    | (() => Promise<CodexImagegenCapability>)
    | undefined;

  constructor(options: CodexImagegenProviderOptions = {}) {
    this.codexPath = options.codexPath ?? "codex";
    this.codexHome = options.codexHome;
    this.agentModel = normalizeCodexModel(
      options.agentModel ?? DEFAULT_CODEX_IMAGEGEN_AGENT_MODEL,
    );
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
    this.execCodex = options.execCodex;
    this.createExecCodex = options.createExecCodex ?? defaultExecCodex;
    this.resolveCapability = options.resolveCapability;
  }

  async generate(params: ImageGenerateParams): Promise<GeneratedImage> {
    const trace = createCodexImagegenTrace(params);
    trace.lap("start", {
      model: params.model,
      promptLength: params.prompt.length,
      aspectRatio: params.aspectRatio ?? null,
      quality: params.quality ?? null,
      size: params.size ?? null,
      inputImageCount: params.inputImages?.length ?? 0,
      timeoutMs: this.timeoutMs,
    });
    if (params.model !== CODEX_IMAGEGEN_MODEL_ID) {
      throw new GenerationError(
        this.name,
        "model_not_found",
        `Unsupported Codex Imagegen model: ${params.model}`,
      );
    }
    if ((params.inputImages?.length ?? 0) > CODEX_IMAGEGEN_MAX_INPUT_IMAGES) {
      throw new GenerationError(
        this.name,
        "invalid_input",
        `Codex Imagegen supports at most ${CODEX_IMAGEGEN_MAX_INPUT_IMAGES} reference images.`,
      );
    }
    const capability = await this.resolveCapability?.();
    if (capability && (!capability.ready || !capability.codexPath)) {
      throw new GenerationError(
        this.name,
        "provider_unavailable",
        `Configured Codex Agent Target is unavailable: ${capability.detail ?? capability.reasons.join(", ")}`,
      );
    }
    const codexPath = capability?.codexPath ?? this.codexPath;
    const execCodex = this.execCodex ?? this.createExecCodex(codexPath);

    const aspectRatio = params.aspectRatio ?? "1:1";
    const dimensions = params.size
      ? dimensionsFromSize(params.size, aspectRatio)
      : aspectRatioToDimensions(aspectRatio);
    const runDir = await mkdtemp(join(tmpdir(), "aimc-codex-imagegen-"));
    let runHome: string | undefined;
    let persistentModelsCache: string | undefined;
    trace.lap("run_dir_ready", {
      targetWidth: dimensions.width,
      targetHeight: dimensions.height,
    });

    try {
      const referenceImages = await materializeReferenceImages(
        params.inputImages ?? [],
        runDir,
      );
      trace.lap("reference_images_ready", {
        inputImageCount: params.inputImages?.length ?? 0,
        materializedCount: referenceImages.length,
      });
      const instruction = buildCodexImagegenInstruction(params, {
        aspectRatio,
        referenceImages,
      });
      trace.lap("instruction_built", {
        instructionLength: instruction.length,
      });
      trace.lap("agent_model_selected", {
        agentModel: this.agentModel,
        reasoningEffort: CODEX_IMAGEGEN_REASONING_EFFORT,
      });
      const materializedHome = await materializeCodexImagegenHome({
        runDir,
        sourceHome: this.codexHome ?? join(homedir(), ".codex"),
      });
      runHome = materializedHome.runHome;
      persistentModelsCache = materializedHome.persistentModelsCache;
      trace.lap("codex_home_ready");
      const env = {
        ...process.env,
        CODEX_HOME: runHome,
      };
      trace.lap("codex_exec_start", {
        agentModel: this.agentModel,
        sandbox: "workspace-write",
      });
      const result = await execCodex(
        [
          "exec",
          "--ignore-user-config",
          "--ignore-rules",
          "--ephemeral",
          "--disable",
          "plugins",
          "--enable",
          "image_generation",
          "--enable",
          "fast_mode",
          "--json",
          "-c",
          `model_reasoning_effort=\"${CODEX_IMAGEGEN_REASONING_EFFORT}\"`,
          "-m",
          this.agentModel,
          "--sandbox",
          "workspace-write",
          "--skip-git-repo-check",
          "-C",
          runDir,
          ...referenceImages.flatMap((imagePath) => ["--image", imagePath]),
          "--",
          instruction,
        ],
        {
          cwd: runDir,
          env,
          generatedImagesDir: join(runHome, "generated_images"),
          timeoutMs: this.timeoutMs,
        },
      );
      trace.lap("codex_exec_done", {
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
      });
      const resolvedPath = resolve(result.imagePath);
      trace.lap("generated_image_ready", {
        resolvedPath,
      });
      if (!isPathInside(join(runHome, "generated_images"), resolvedPath)) {
        throw new GenerationError(
          this.name,
          "invalid_output_path",
          "Codex Imagegen returned an output outside its generated image directory.",
        );
      }
      const imageBuffer = await readFile(resolvedPath);
      trace.lap("image_read", {
        byteSize: imageBuffer.length,
      });
      const imageDimensions = parsePngDimensions(imageBuffer) ?? dimensions;
      trace.lap("done", {
        width: imageDimensions.width,
        height: imageDimensions.height,
      });
      return {
        url: `data:image/png;base64,${imageBuffer.toString("base64")}`,
        mimeType: "image/png",
        width: imageDimensions.width,
        height: imageDimensions.height,
      };
    } catch (error) {
      trace.lap("failed", {
        errorCode: error instanceof GenerationError ? error.code : null,
        error:
          error instanceof GenerationError
            ? error.code
            : error instanceof Error
              ? error.name
              : typeof error,
      });
      if (error instanceof GenerationError) throw error;
      throw new GenerationError(
        this.name,
        "api_error",
        error instanceof Error ? error.message : "Unknown Codex Imagegen error",
      );
    } finally {
      if (runHome && persistentModelsCache) {
        await persistCodexModelsCache(
          join(runHome, "models_cache.json"),
          persistentModelsCache,
        ).catch((error) => {
          trace.lap("models_cache_persist_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      const cleanupStartedAt = Date.now();
      await rm(runDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      }).catch((error) => {
        trace.lap("cleanup_failed", {
          cleanupMs: Date.now() - cleanupStartedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        console.warn(
          "[codex-imagegen] temporary directory cleanup failed:",
          error instanceof Error ? error.message : String(error),
        );
      });
      trace.lap("cleanup_done", {
        cleanupMs: Date.now() - cleanupStartedAt,
      });
    }
  }
}

function createCodexImagegenTrace(params: ImageGenerateParams) {
  const t0 = Date.now();
  let lastLapAt = t0;
  const jobId =
    typeof params.metadata?.jobId === "string" ? params.metadata.jobId : null;
  const attempt =
    typeof params.metadata?.attempt === "number"
      ? params.metadata.attempt
      : null;

  return {
    lap(label: string, extra?: Record<string, unknown>) {
      const now = Date.now();
      console.info(
        `[codex-imagegen] ${label} +${now - t0}ms step=${now - lastLapAt}ms`,
        JSON.stringify({
          jobId,
          attempt,
          ...(extra ?? {}),
        }),
      );
      lastLapAt = now;
    },
  };
}

async function materializeCodexImagegenHome(options: {
  runDir: string;
  sourceHome: string;
}) {
  const runHome = join(options.runDir, ".codex-home");
  await mkdir(runHome, { recursive: true });
  await copyFileIfPresent(
    join(options.sourceHome, "auth.json"),
    join(runHome, "auth.json"),
  );
  // Keep a CLI-owned cache separate from the desktop app's models_cache.json.
  // Different Codex builds can use different schemas; sharing the desktop file
  // caused every image request to reject the cache and repeat model discovery.
  const persistentModelsCache = join(
    options.sourceHome,
    "cache",
    "aimc-imagegen",
    "models_cache.json",
  );
  await copyValidJsonFileIfPresent(
    persistentModelsCache,
    join(runHome, "models_cache.json"),
  );
  return { persistentModelsCache, runHome };
}

async function copyFileIfPresent(source: string, target: string) {
  try {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

async function copyValidJsonFileIfPresent(source: string, target: string) {
  try {
    const contents = await readFile(source, "utf8");
    JSON.parse(contents);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  } catch (error) {
    if (!isMissingFileError(error) && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
}

async function persistCodexModelsCache(source: string, target: string) {
  const contents = await readFile(source, "utf8");
  JSON.parse(contents);
  await mkdir(dirname(target), { recursive: true });
  const temporaryTarget = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryTarget, contents, "utf8");
  await rename(temporaryTarget, target);
}

function isMissingFileError(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}

function buildCodexImagegenInstruction(
  params: ImageGenerateParams,
  options: {
    aspectRatio: string;
    referenceImages: readonly string[];
  },
) {
  const quality = params.quality ?? "hd";
  const imagePrompt = [
    params.prompt.trim(),
    `Aspect ratio: ${options.aspectRatio}.`,
    ...(params.size ? [`Requested size: ${params.size}.`] : []),
    `Requested quality: ${quality}.`,
    "Output format: PNG.",
    ...(options.referenceImages.length > 0
      ? [
          "Use the attached reference images for subject, composition, or style as requested, preserving their input order.",
        ]
      : []),
  ].join("\n");
  const toolArguments = {
    prompt: imagePrompt,
    ...(options.referenceImages.length > 0
      ? { num_last_images_to_include: options.referenceImages.length }
      : {}),
  };
  return [
    "Call the built-in image_gen tool immediately and exactly once.",
    "Use exactly the JSON arguments below. Do not add, remove, rename, or rewrite any argument:",
    JSON.stringify(toolArguments),
    "Do not inspect files, read skills, use shell commands, call other tools, or explain the task.",
    "After the image tool returns, reply exactly DONE.",
  ].join("\n");
}

async function materializeReferenceImages(
  inputImages: readonly string[],
  runDir: string,
) {
  if (inputImages.length === 0) return [];

  const referenceDir = join(runDir, "reference-images");
  await mkdir(referenceDir, { recursive: true });

  const paths: string[] = [];
  for (const [index, inputImage] of inputImages.entries()) {
    const materialized = await materializeReferenceImage(
      inputImage,
      referenceDir,
      index,
    );
    paths.push(materialized);
  }
  return paths;
}

async function materializeReferenceImage(
  inputImage: string,
  referenceDir: string,
  index: number,
) {
  if (inputImage.startsWith("data:")) {
    const parsed = parseDataUrl(inputImage);
    const outputPath = join(
      referenceDir,
      `reference-${index + 1}.${extensionForMimeType(parsed.mimeType)}`,
    );
    await writeFile(outputPath, parsed.buffer);
    return outputPath;
  }

  if (/^https?:\/\//i.test(inputImage)) {
    const response = await fetch(inputImage);
    if (!response.ok) {
      throw new GenerationError(
        "codex-imagegen",
        "invalid_input",
        `Unable to fetch reference image ${index + 1}: ${response.status}`,
      );
    }
    const mimeType =
      response.headers.get("content-type")?.split(";")[0]?.trim() ??
      "image/png";
    const outputPath = join(
      referenceDir,
      `reference-${index + 1}.${extensionForMimeType(mimeType)}`,
    );
    await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
    return outputPath;
  }

  if (isAbsolute(inputImage)) {
    const outputPath = join(referenceDir, `reference-${index + 1}.png`);
    await copyFile(inputImage, outputPath);
    return outputPath;
  }

  throw new GenerationError(
    "codex-imagegen",
    "invalid_input",
    `Unsupported reference image input ${index + 1}.`,
  );
}

function parseDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
  if (!match) {
    throw new GenerationError(
      "codex-imagegen",
      "invalid_input",
      "Invalid reference image data URL.",
    );
  }

  const mimeType = match[1] ?? "image/png";
  const body = match[3] ?? "";
  const buffer = match[2]
    ? Buffer.from(body, "base64")
    : Buffer.from(decodeURIComponent(body), "utf8");
  return { mimeType, buffer };
}

function extensionForMimeType(mimeType: string) {
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

function isPathInside(parent: string, child: string) {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  return (
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(`${normalizedParent}${sep}`)
  );
}

function dimensionsFromSize(size: string, fallbackAspectRatio: string) {
  const match = size.match(/^(\d+)x(\d+)$/);
  if (!match) return aspectRatioToDimensions(fallbackAspectRatio);
  return {
    width: Number.parseInt(match[1] ?? "1024", 10),
    height: Number.parseInt(match[2] ?? "1024", 10),
  };
}

export function parsePngDimensions(buffer: Buffer) {
  const pngSignature = "89504e470d0a1a0a";
  if (
    buffer.length < 24 ||
    buffer.subarray(0, 8).toString("hex") !== pngSignature
  ) {
    return undefined;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function defaultExecCodex(command: string): CodexImagegenExec {
  return async (args, options) => {
    const invocation = resolveProcessInvocation({
      command,
      args,
      env: options.env,
    });
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let spawnError: Error | undefined;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      spawnError = error;
    });

    try {
      const imagePath = await waitForStableGeneratedPng({
        child,
        generatedImagesDir: options.generatedImagesDir,
        getOutput: () => ({ spawnError, stderr, stdout }),
        timeoutMs: options.timeoutMs,
      });
      await terminateCodexChild(child);
      return { imagePath, stderr, stdout };
    } catch (error) {
      await terminateCodexChild(child);
      throw error;
    }
  };
}

async function waitForStableGeneratedPng(options: {
  child: ChildProcess;
  generatedImagesDir: string;
  getOutput: () => {
    spawnError: Error | undefined;
    stderr: string;
    stdout: string;
  };
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  let previousPath: string | undefined;
  let previousSize = -1;
  let stablePolls = 0;

  for (;;) {
    const candidates = await findGeneratedPngs(options.generatedImagesDir);
    const candidate = candidates.at(-1);
    if (candidate) {
      if (candidate.path === previousPath && candidate.size === previousSize) {
        stablePolls += 1;
      } else {
        previousPath = candidate.path;
        previousSize = candidate.size;
        stablePolls = 0;
      }
      if (
        (stablePolls >= 2 || hasChildClosed(options.child)) &&
        (await isCompletePng(candidate.path))
      ) {
        return candidate.path;
      }
    }

    const output = options.getOutput();
    if (output.spawnError) throw output.spawnError;
    if (hasChildClosed(options.child)) {
      throw new GenerationError(
        "codex-imagegen",
        "no_output",
        `Codex Imagegen exited before producing a PNG: ${tail(output.stderr || output.stdout)}`,
      );
    }
    if (Date.now() - startedAt >= options.timeoutMs) {
      throw new GenerationError(
        "codex-imagegen",
        "timeout",
        `Codex Imagegen timed out after ${options.timeoutMs}ms: ${tail(output.stderr || output.stdout)}`,
      );
    }
    await delay(GENERATED_IMAGE_POLL_MS);
  }
}

async function findGeneratedPngs(
  root: string,
): Promise<Array<{ modifiedAt: number; path: string; size: number }>> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }

  const images: Array<{ modifiedAt: number; path: string; size: number }> = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      images.push(...(await findGeneratedPngs(path)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) {
      const metadata = await stat(path);
      images.push({ modifiedAt: metadata.mtimeMs, path, size: metadata.size });
    }
  }
  return images.sort(
    (left, right) =>
      left.modifiedAt - right.modifiedAt || left.path.localeCompare(right.path),
  );
}

async function isCompletePng(path: string) {
  try {
    const buffer = await readFile(path);
    return (
      parsePngDimensions(buffer) !== undefined &&
      buffer.length >= 12 &&
      buffer
        .subarray(buffer.length - 8, buffer.length - 4)
        .toString("ascii") === "IEND"
    );
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

async function terminateCodexChild(child: ChildProcess) {
  if (hasChildClosed(child)) return;
  child.kill("SIGTERM");
  if (await waitForChildClose(child, 1_000)) return;
  child.kill("SIGKILL");
  await waitForChildClose(child, 1_000);
}

async function waitForChildClose(child: ChildProcess, timeoutMs: number) {
  if (hasChildClosed(child)) return true;
  return new Promise<boolean>((resolvePromise) => {
    const timeout = setTimeout(() => {
      child.off("close", onClose);
      resolvePromise(false);
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timeout);
      resolvePromise(true);
    };
    child.once("close", onClose);
  });
}

function hasChildClosed(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode !== null;
}

function delay(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function tail(output: string) {
  return output.trim().slice(-8_000);
}

function normalizeCodexModel(model: string) {
  const normalized = model.trim();
  return normalized.startsWith("codex:")
    ? normalized.slice("codex:".length)
    : normalized;
}
