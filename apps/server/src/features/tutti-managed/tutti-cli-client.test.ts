import { chmod, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import {
  TuttiManagedModelCliUnsupportedError,
  invokeTuttiManagedModelCli,
} from "./tutti-cli-client.js";

function envFor(path: string): ServerEnv {
  return {
    agentBackendMode: "state",
    agentModel: "openai:gpt-5.1",
    port: 3001,
    tuttiCliPath: path,
    version: "test",
    webOrigin: "http://localhost:3000",
  };
}

async function writeNodeCommand(prefix: string, source: string): Promise<string> {
  const scriptPath = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random()}.mjs`);
  await writeFile(scriptPath, source);
  if (process.platform === "win32") {
    const commandPath = `${scriptPath}.cmd`;
    await writeFile(commandPath, `@"${process.execPath}" "${scriptPath}" %*\r\n`);
    return commandPath;
  }
  await writeFile(scriptPath, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  await chmod(scriptPath, 0o700);
  return scriptPath;
}

describe("invokeTuttiManagedModelCli", () => {
  it("reports a missing host CLI as an upgrade-required capability error", async () => {
    const { tuttiCliPath: _tuttiCliPath, ...envWithoutCli } = envFor("");
    await expect(
      invokeTuttiManagedModelCli(
        envWithoutCli,
        ["managed-model", "models"],
        {},
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "TUTTI_MANAGED_MODEL_CLI_UNSUPPORTED",
        message: "当前 Tutti 不支持托管模型 CLI，请升级 Tutti",
      }),
    );
  });

  it.skipIf(process.platform === "win32")("sends JSON through stdin and parses only JSON stdout", async () => {
    const path = await writeNodeCommand(
      "aimc-tutti-cli",
      "let input = ''; for await (const chunk of process.stdin) input += chunk; " +
        "if (input.includes('grantRef')) process.stdout.write(JSON.stringify({ ok: true })); else process.exit(2);",
    );
    await expect(
      invokeTuttiManagedModelCli(envFor(path), ["managed-model", "revoke"], {
        grantRef: "grant-1",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it.skipIf(process.platform === "win32")("preserves UTF-8 JSON when a character spans stdout chunks", async () => {
    const path = await writeNodeCommand(
      "aimc-tutti-cli-utf8",
      "const value = Buffer.from(JSON.stringify({ label: '雪' }));\nprocess.stdout.write(value.subarray(0, value.length - 2));\nsetImmediate(() => process.stdout.write(value.subarray(value.length - 2)));\n",
    );

    await expect(
      invokeTuttiManagedModelCli(envFor(path), ["managed-model", "models"], {}),
    ).resolves.toEqual({ label: "雪" });
  });

  it.skipIf(process.platform === "win32")("retains diagnostics when the CLI fails to start", async () => {
    const path = join(
      tmpdir(),
      `aimc-tutti-cli-no-exec-${Date.now()}-${Math.random()}.sh`,
    );
    await writeFile(path, "#!/bin/sh\nprintf '{}'");
    await chmod(path, 0o600);

    await expect(
      invokeTuttiManagedModelCli(envFor(path), ["managed-model", "models"], {}),
    ).rejects.toThrow(/failed to start:.*EACCES/u);
  });

  it("uses the shared managed-model protocol fixture shape", async () => {
    const raw = await readFile(
      new URL("./testdata/managed-model-protocol.v1.json", import.meta.url),
      "utf8",
    );
    const fixture = JSON.parse(raw) as {
      commands: Record<string, { input: unknown }>;
    };
    expect(fixture.commands["managed-model.grant.exchange"]?.input).toEqual({
      contextToken: "context-test",
      grantCode: "grant-test",
      nonce: "nonce-test",
      state: "state-test",
    });
  });

  it.skipIf(process.platform === "win32")("reports an unknown managed-model command as an upgrade-required capability error", async () => {
    const path = await writeNodeCommand(
      "aimc-tutti-cli-unsupported",
      'process.stderr.write(\'Error: unknown command "managed-model" for "tutti"\\n\'); process.exit(1);',
    );

    await expect(
      invokeTuttiManagedModelCli(envFor(path), ["managed-model", "models"], {}),
    ).rejects.toBeInstanceOf(TuttiManagedModelCliUnsupportedError);
  });

  it.skipIf(process.platform === "win32")("does not mistake an unrelated CLI failure for a missing managed-model command", async () => {
    const path = await writeNodeCommand(
      "aimc-tutti-cli-failure",
      "process.stderr.write('daemon unavailable: unknown command: app refresh\\n'); process.exit(1);",
    );

    await expect(
      invokeTuttiManagedModelCli(envFor(path), ["managed-model", "models"], {}),
    ).rejects.toThrow(
      "Tutti CLI command failed: daemon unavailable: unknown command: app refresh",
    );
  });
});
