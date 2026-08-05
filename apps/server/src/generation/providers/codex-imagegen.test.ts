import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  CODEX_IMAGEGEN_MODELS,
  CodexImagegenProvider,
  parsePngDimensions,
} from "./codex-imagegen.js";

describe("CodexImagegenProvider", () => {
  it("exposes GPT Image 2 as the Codex imagegen model display name", () => {
    expect(CODEX_IMAGEGEN_MODELS).toContainEqual(
      expect.objectContaining({
        id: "codex/gpt-image-2",
        displayName: "GPT Image 2",
      }),
    );
  });

  it("fails before execution when the configured Agent Target is unavailable", async () => {
    const execCodex = vi.fn();
    const provider = new CodexImagegenProvider({
      execCodex,
      resolveCapability: async () => ({
        ready: false,
        reasons: ["agent_target_unavailable"],
        checkedAt: "2026-08-06T00:00:00.000Z",
      }),
    });

    await expect(
      provider.generate({
        model: "codex/gpt-image-2",
        prompt: "a red mug",
      }),
    ).rejects.toThrow("agent_target_unavailable");
    expect(execCodex).not.toHaveBeenCalled();
  });

  it("generates through codex exec and returns a data URI", async () => {
    const sourceHome = await createCodexImagegenHomeFixture();
    const execCodex = vi.fn(async (args: readonly string[], options) => {
      const instruction = String(args.at(-1));
      expect(options.env.CODEX_HOME).toBe(join(options.cwd, ".codex-home"));
      await expect(
        readFile(
          join(
            options.env.CODEX_HOME,
            "skills",
            ".system",
            "imagegen",
            "SKILL.md",
          ),
          "utf8",
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(join(options.env.CODEX_HOME, "models_cache.json"), "utf8"),
      ).resolves.toContain("cached-model");
      await writeFile(
        join(options.env.CODEX_HOME, "models_cache.json"),
        '{"models":["refreshed-model"]}',
        "utf8",
      );
      const imagePath = join(
        options.generatedImagesDir,
        "thread",
        "result.png",
      );
      await mkdir(dirname(imagePath), { recursive: true });
      await writeFile(imagePath, createPngBuffer(1024, 576));
      expect(JSON.parse(instruction.split("\n")[2] ?? "{}")).toEqual({
        prompt:
          "a red mug\nAspect ratio: 16:9.\nRequested quality: standard.\nOutput format: PNG.",
      });
      return { imagePath, stdout: "", stderr: "" };
    });
    const createExecCodex = vi.fn(() => execCodex);
    const provider = new CodexImagegenProvider({
      codexHome: sourceHome,
      timeoutMs: 1234,
      createExecCodex,
      resolveCapability: async () => ({
        ready: true,
        reasons: [],
        codexPath: String.raw`C:\Program Files\Tutti Agents\codex.exe`,
        checkedAt: "2026-08-06T00:00:00.000Z",
      }),
    });

    try {
      const image = await provider.generate({
        model: "codex/gpt-image-2",
        prompt: "a red mug",
        aspectRatio: "16:9",
        quality: "standard",
      });

      expect(execCodex).toHaveBeenCalledWith(
        expect.arrayContaining([
          "exec",
          "--ignore-user-config",
          "--enable",
          "image_generation",
          "--enable",
          "fast_mode",
          "--json",
          "-c",
          'model_reasoning_effort="low"',
          "-m",
          "gpt-5.5",
          "--sandbox",
          "workspace-write",
          "--skip-git-repo-check",
          "-C",
        ]),
        expect.objectContaining({
          env: expect.objectContaining({
            CODEX_HOME: expect.stringContaining(".codex-home"),
          }),
          timeoutMs: 1234,
        }),
      );
      expect(createExecCodex).toHaveBeenCalledWith(
        String.raw`C:\Program Files\Tutti Agents\codex.exe`,
      );
      const args = execCodex.mock.calls[0]?.[0] ?? [];
      expect(args.at(-1)).toContain(
        "Call the built-in image_gen tool immediately and exactly once.",
      );
      expect(image).toEqual({
        url: `data:image/png;base64,${createPngBuffer(1024, 576).toString("base64")}`,
        mimeType: "image/png",
        width: 1024,
        height: 576,
      });
      await expect(
        readFile(
          join(sourceHome, "cache", "aimc-imagegen", "models_cache.json"),
          "utf8",
        ),
      ).resolves.toBe('{"models":["refreshed-model"]}');
    } finally {
      await rm(sourceHome, { recursive: true, force: true });
    }
  });

  it("normalizes an explicitly configured Codex agent model", async () => {
    const sourceHome = await createCodexImagegenHomeFixture();
    const execCodex = vi.fn(async (_args: readonly string[], options) => {
      const imagePath = join(options.generatedImagesDir, "result.png");
      await mkdir(dirname(imagePath), { recursive: true });
      await writeFile(imagePath, createPngBuffer(1024, 1024));
      return { imagePath, stdout: "", stderr: "" };
    });
    const provider = new CodexImagegenProvider({
      codexHome: sourceHome,
      execCodex,
      agentModel: "codex:gpt-5.5",
    });

    try {
      await provider.generate({
        model: "codex/gpt-image-2",
        prompt: "a red mug",
      });

      expect(execCodex).toHaveBeenCalledWith(
        expect.arrayContaining([
          "exec",
          "--ignore-user-config",
          "-m",
          "gpt-5.5",
          "--sandbox",
          "workspace-write",
        ]),
        expect.any(Object),
      );
    } finally {
      await rm(sourceHome, { recursive: true, force: true });
    }
  });

  it("materializes reference images for Codex imagegen", async () => {
    const sourceHome = await createCodexImagegenHomeFixture();
    const execCodex = vi.fn(async (args: readonly string[], options) => {
      const instruction = String(args.at(-1));
      const toolArguments = JSON.parse(instruction.split("\n")[2] ?? "{}") as {
        prompt: string;
        referenced_image_paths: string[];
      };
      const referencePath = toolArguments.referenced_image_paths[0];
      if (!referencePath) throw new Error("missing reference path");
      await expect(readFile(referencePath, "utf8")).resolves.toBe("ref-bytes");
      const imagePath = join(options.generatedImagesDir, "result.png");
      await mkdir(dirname(imagePath), { recursive: true });
      await writeFile(imagePath, createPngBuffer(1024, 1024));
      return { imagePath, stdout: "", stderr: "" };
    });
    const provider = new CodexImagegenProvider({
      codexHome: sourceHome,
      execCodex,
    });

    try {
      await provider.generate({
        model: "codex/gpt-image-2",
        prompt: "edit this",
        inputImages: [
          `data:image/png;base64,${Buffer.from("ref-bytes").toString("base64")}`,
        ],
      });

      const instruction = String(execCodex.mock.calls[0]?.[0].at(-1));
      const args = execCodex.mock.calls[0]?.[0] ?? [];
      expect(instruction).toContain(
        "Use the supplied reference images for subject, composition, or style as requested",
      );
      expect(instruction).toContain("referenced_image_paths");
      expect(args).not.toContain("--image");
      expect(instruction).toMatch(
        /"referenced_image_paths":\["[^"]+reference-1\.png"\]/,
      );
    } finally {
      await rm(sourceHome, { recursive: true, force: true });
    }
  });

  it("returns as soon as a complete generated PNG appears", async () => {
    const sourceHome = await createCodexImagegenHomeFixture();
    const fakeCodexScript = join(sourceHome, "fake-codex.js");
    const fakeCodexPath =
      process.platform === "win32"
        ? join(sourceHome, "fake-codex.cmd")
        : join(sourceHome, "fake-codex");
    const pngHex = createPngBuffer(640, 480).toString("hex");
    await writeFile(
      fakeCodexScript,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const output = path.join(process.env.CODEX_HOME, "generated_images", "thread", "result.png");',
        "fs.mkdirSync(path.dirname(output), { recursive: true });",
        `fs.writeFileSync(output, Buffer.from("${pngHex}", "hex"));`,
        "setInterval(() => {}, 10_000);",
      ].join("\n"),
      "utf8",
    );
    if (process.platform === "win32") {
      await writeFile(
        fakeCodexPath,
        `@echo off\r\n"${process.execPath}" "${fakeCodexScript}" %*\r\n`,
        "utf8",
      );
    } else {
      await writeFile(fakeCodexPath, await readFile(fakeCodexScript));
      await chmod(fakeCodexPath, 0o755);
    }
    const provider = new CodexImagegenProvider({
      codexHome: sourceHome,
      codexPath: fakeCodexPath,
      timeoutMs: 5_000,
    });

    try {
      const startedAt = performance.now();
      const image = await provider.generate({
        model: "codex/gpt-image-2",
        prompt: "a red mug",
      });

      expect(performance.now() - startedAt).toBeLessThan(4_000);
      expect(image).toMatchObject({ width: 640, height: 480 });
    } finally {
      await rm(sourceHome, { recursive: true, force: true });
    }
  });

  it("rejects more than 16 Codex imagegen reference images", async () => {
    const provider = new CodexImagegenProvider({
      execCodex: vi.fn(),
    });

    await expect(
      provider.generate({
        model: "codex/gpt-image-2",
        prompt: "edit this",
        inputImages: Array.from(
          { length: 17 },
          (_, index) =>
            `data:image/png;base64,${Buffer.from(`ref-${index}`).toString("base64")}`,
        ),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects saved paths outside the run directory", async () => {
    const sourceHome = await createCodexImagegenHomeFixture();
    const provider = new CodexImagegenProvider({
      codexHome: sourceHome,
      execCodex: vi.fn(async () => ({
        imagePath: "/tmp/outside-codex-image.png",
        stdout: "",
        stderr: "",
      })),
    });

    try {
      await expect(
        provider.generate({
          model: "codex/gpt-image-2",
          prompt: "a red mug",
        }),
      ).rejects.toMatchObject({
        code: "invalid_output_path",
      });
    } finally {
      await rm(sourceHome, { recursive: true, force: true });
    }
  });

  it("reads dimensions from PNG headers", () => {
    const png = Buffer.alloc(24);
    Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
    png.writeUInt32BE(1254, 16);
    png.writeUInt32BE(1254, 20);

    expect(parsePngDimensions(png)).toEqual({ width: 1254, height: 1254 });
    expect(parsePngDimensions(Buffer.from("not png"))).toBeUndefined();
  });
});

async function createCodexImagegenHomeFixture() {
  const sourceHome = await mkdtemp(join(tmpdir(), "aimc-codex-home-"));
  await mkdir(join(sourceHome, "cache", "aimc-imagegen"), { recursive: true });
  await writeFile(
    join(sourceHome, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "test-key" }),
    "utf8",
  );
  await writeFile(
    join(sourceHome, "cache", "aimc-imagegen", "models_cache.json"),
    '{"models":["cached-model"]}',
    "utf8",
  );
  return sourceHome;
}

function createPngBuffer(width: number, height: number) {
  const png = Buffer.alloc(36);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  Buffer.from("0000000049454e44ae426082", "hex").copy(png, 24);
  return png;
}
