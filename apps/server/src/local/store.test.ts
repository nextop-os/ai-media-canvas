import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";

import { loadWorkspaceSkills } from "../agent/workspace-skills.js";
import { createLocalStore } from "./store.js";
import { createLocalUserClient } from "./user-client.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createLocalStore", () => {
  it("waits for a concurrent runtime process to release the SQLite lock", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-data-"));
    const databaseRoot = mkdtempSync(join(tmpdir(), "aimc-database-"));
    tempDirs.push(dataRoot, databaseRoot);
    const dbPath = join(databaseRoot, "ai-media-canvas.db");

    const lockHolder = new Worker(
      `
        const { parentPort, workerData } = require("node:worker_threads");
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(workerData.dbPath);
        db.exec("CREATE TABLE IF NOT EXISTS lock_holder (id INTEGER); BEGIN EXCLUSIVE");
        parentPort.postMessage("locked");
        setTimeout(() => {
          db.exec("COMMIT");
          db.close();
          parentPort.postMessage("released");
        }, 200);
      `,
      { eval: true, workerData: { dbPath } },
    );
    await new Promise<void>((resolve, reject) => {
      lockHolder.once("message", () => resolve());
      lockHolder.once("error", reject);
    });

    expect(() =>
      createLocalStore({
        assetBaseUrl: "http://127.0.0.1:3001",
        dataRoot,
        databaseRoot,
      }),
    ).not.toThrow();
    await lockHolder.terminate();
  });

  it("keeps SQLite under the dedicated database root", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-data-"));
    const databaseRoot = mkdtempSync(join(tmpdir(), "aimc-database-"));
    tempDirs.push(dataRoot, databaseRoot);

    createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
      databaseRoot,
    });

    expect(existsSync(join(databaseRoot, "ai-media-canvas.db"))).toBe(true);
    expect(existsSync(join(dataRoot, "ai-media-canvas.db"))).toBe(false);
    // Private assets stay with the VM-local database root, not FabricFS dataRoot.
    expect(existsSync(join(databaseRoot, "assets"))).toBe(true);
    expect(existsSync(join(dataRoot, "assets"))).toBe(false);
  });

  it("creates unique slugs for duplicate project names", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const first = store.createProject({ name: "Untitled" });
    const second = store.createProject({ name: "Untitled" });

    expect(first.slug).toBe("untitled");
    expect(second.slug).toBe("untitled-2");
  });

  it("returns null or false for chat operations on missing resources", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    expect(store.createSession("missing-canvas")).toBeNull();
    expect(store.updateSessionTitle("missing-session", "Renamed")).toBe(false);
    expect(store.deleteSession("missing-session")).toBe(false);
    expect(store.listMessages("missing-session")).toBeNull();
    expect(
      store.createMessage("missing-session", {
        role: "user",
        content: "Hello",
      }),
    ).toBeNull();
  });

  it("reuses a chat message for the same client request and role", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-"));
    tempDirs.push(dataRoot);
    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });
    const project = store.createProject({ name: "Idempotent messages" });
    const session = store.createSession(project.primaryCanvas.id, "Chat");
    if (!session) throw new Error("expected chat session");

    const first = store.createMessage(session.id, {
      clientRequestId: "request-1",
      role: "user",
      content: "first",
    });
    const replay = store.createMessage(session.id, {
      clientRequestId: "request-1",
      role: "user",
      content: "replayed",
    });

    expect(replay).toEqual(first);
    expect(store.listMessages(session.id)).toHaveLength(1);
  });

  it("persists agent run metadata in the local SQLite database", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const project = store.createProject({ name: "Agent Runs" });
    const session = store.createSession(
      project.primaryCanvas.id,
      "Run session",
    );
    expect(session).not.toBeNull();

    store.createAgentRun({
      agentTargetId: "team:designer",
      canvasId: project.primaryCanvas.id,
      model: "agnes:agnes-2.0-flash",
      previousRunId: "run-previous",
      resumeMode: "handoff",
      runtimeKind: "local-agent",
      runId: "run-1",
      sessionId: session!.id,
      threadId: "thread:run-session",
    });
    store.updateAgentRun({
      agentTargetId: "team:reviewer",
      providerSessionId: "provider-session-1",
      runId: "run-1",
      resumeToken: "resume-token-1",
      status: "completed",
    });

    const db = new DatabaseSync(join(dataRoot, "ai-media-canvas.db"));
    const row = db
      .prepare(
        `SELECT id, canvas_id, session_id, thread_id, model, runtime_kind,
                runtime_provider, agent_target_id, previous_run_id, resume_mode,
                provider_session_id, resume_token, status, completed_at
         FROM agent_runs
         WHERE id = ?`,
      )
      .get("run-1") as
      | {
          canvas_id: string;
          agent_target_id: string | null;
          completed_at: string | null;
          id: string;
          model: string;
          previous_run_id: string | null;
          provider_session_id: string | null;
          resume_mode: string | null;
          resume_token: string | null;
          runtime_kind: string | null;
          runtime_provider: string | null;
          session_id: string;
          status: string;
          thread_id: string;
        }
      | undefined;
    db.close();

    expect(row).toMatchObject({
      agent_target_id: "team:reviewer",
      canvas_id: project.primaryCanvas.id,
      id: "run-1",
      model: "agnes:agnes-2.0-flash",
      previous_run_id: "run-previous",
      provider_session_id: "provider-session-1",
      resume_mode: "handoff",
      resume_token: "resume-token-1",
      runtime_kind: "local-agent",
      runtime_provider: null,
      session_id: session!.id,
      status: "completed",
      thread_id: "thread:run-session",
    });
    expect(row?.completed_at).toEqual(expect.any(String));
  });

  it("cancels active session work before deleting the session", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const project = store.createProject({ name: "Session cleanup" });
    const session = store.createSession(
      project.primaryCanvas.id,
      "Deleting session",
    );
    expect(session).not.toBeNull();

    const assistantMessage = store.createMessage(session!.id, {
      role: "assistant",
      content: "",
      contentBlocks: [],
    });
    expect(assistantMessage).not.toBeNull();

    store.createAgentRun({
      assistantMessageId: assistantMessage!.id,
      canvasId: project.primaryCanvas.id,
      model: "agnes:agnes-2.0-flash",
      runtimeKind: "local-agent",
      runId: "run-delete-session",
      sessionId: session!.id,
    });
    store.updateAgentRun({
      runId: "run-delete-session",
      status: "running",
    });
    const job = store.createBackgroundJob({
      jobType: "image_generation",
      queueName: "image_generation_jobs",
      projectId: project.id,
      canvasId: project.primaryCanvas.id,
      sessionId: session!.id,
      payload: {
        prompt: "A social carousel",
        model: "gpt-image-1",
      },
    });

    expect(store.deleteSession(session!.id)).toBe(true);

    expect(store.getAgentRun("run-delete-session")?.status).toBe("canceled");
    expect(
      store.listAgentRunEvents("run-delete-session").at(-1)?.event,
    ).toMatchObject({
      type: "run.canceled",
      runId: "run-delete-session",
    });
    expect(store.getBackgroundJob(job.id)?.status).toBe("canceled");
    expect(
      store.markBackgroundJobSucceeded(job.id, {
        signed_url: "https://example.test/image.png",
      })?.status,
    ).toBe("canceled");
    expect(
      store.markBackgroundJobFailed({
        jobId: job.id,
        errorCode: "late_failure",
        errorMessage: "Late worker failure",
      })?.status,
    ).toBe("canceled");
  });

  it("rejects stale canvas saves so old clients cannot overwrite newer content", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const project = store.createProject({ name: "Canvas revisions" });
    const initial = store.getCanvas(project.primaryCanvas.id);
    expect(initial?.revision).toBe(0);
    const initialRevision = initial?.revision ?? 0;

    expect(
      store.saveCanvas(
        project.primaryCanvas.id,
        {
          elements: [
            {
              id: "server-image",
              type: "image",
              isDeleted: false,
            },
          ],
          appState: {},
          files: {},
        },
        { baseRevision: initialRevision },
      ),
    ).toEqual({ ok: true, revision: 1 });

    expect(
      store.saveCanvas(
        project.primaryCanvas.id,
        {
          elements: [],
          appState: {},
          files: {},
        },
        { baseRevision: initialRevision },
      ),
    ).toEqual({ ok: false, reason: "revision_conflict" });

    expect(store.getCanvas(project.primaryCanvas.id)?.content.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "server-image",
        }),
      ]),
    );
  });

  it("keeps server batch writes when an older frontend batch save arrives", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const project = store.createProject({ name: "Canvas batch revisions" });
    const canvasId = project.primaryCanvas.id;
    const initialRevision = store.getCanvas(canvasId)?.revision ?? 0;

    expect(
      store.saveCanvas(canvasId, {
        elements: [{ id: "server-image-1", type: "image", isDeleted: false }],
        appState: {},
        files: {},
      }),
    ).toEqual({ ok: true, revision: 1 });
    expect(
      store.saveCanvas(canvasId, {
        elements: [
          { id: "server-image-1", type: "image", isDeleted: false },
          { id: "server-image-2", type: "image", isDeleted: false },
        ],
        appState: {},
        files: {},
      }),
    ).toEqual({ ok: true, revision: 2 });

    expect(
      store.saveCanvas(
        canvasId,
        {
          elements: [{ id: "frontend-stale", type: "rectangle" }],
          appState: {},
          files: {},
        },
        { baseRevision: initialRevision },
      ),
    ).toEqual({ ok: false, reason: "revision_conflict" });

    expect(store.getCanvas(canvasId)?.content.elements).toEqual([
      expect.objectContaining({ id: "server-image-1" }),
      expect.objectContaining({ id: "server-image-2" }),
    ]);

    expect(
      store.saveCanvas(
        canvasId,
        {
          elements: [
            { id: "server-image-1", type: "image", isDeleted: false },
            { id: "server-image-2", type: "image", isDeleted: false },
            { id: "frontend-current", type: "rectangle" },
          ],
          appState: {},
          files: {},
        },
        { baseRevision: 2 },
      ),
    ).toEqual({ ok: true, revision: 3 });
  });

  it("reclaims stale running background jobs without incrementing attempts", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const project = store.createProject({ name: "Stale Jobs" });
    const job = store.createBackgroundJob({
      jobType: "video_generation",
      queueName: "video_generation_jobs",
      projectId: project.id,
      payload: {
        prompt: "A long running video",
        model: "agnes-video/agnes-video-v2.0",
      },
    });

    const [firstClaim] = store.claimBackgroundJobs({
      workerId: "worker-old",
      limit: 1,
    });
    expect(firstClaim?.id).toBe(job.id);
    expect(firstClaim?.attempt_count).toBe(1);

    const [reclaimed] = store.claimBackgroundJobs({
      workerId: "worker-new",
      limit: 1,
      staleAfterMs: 0,
    });

    expect(reclaimed?.id).toBe(job.id);
    expect(reclaimed?.attempt_count).toBe(1);
  });

  it("updates assistant anchors and persists agent run events", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const project = store.createProject({ name: "Agent Transcript" });
    const session = store.createSession(
      project.primaryCanvas.id,
      "Transcript session",
    );
    expect(session).not.toBeNull();

    const assistantMessage = store.createMessage(session!.id, {
      role: "assistant",
      content: "",
      contentBlocks: [],
    });
    expect(assistantMessage).not.toBeNull();

    store.createAgentRun({
      assistantMessageId: assistantMessage!.id,
      canvasId: project.primaryCanvas.id,
      model: "codex:gpt-5.4",
      runtimeKind: "local-agent",
      runtimeProvider: "codex",
      runId: "run-anchor",
      sessionId: session!.id,
    });
    store.appendAgentRunEvent({
      runId: "run-anchor",
      event: {
        type: "run.started",
        runId: "run-anchor",
        sessionId: session!.id,
        conversationId: project.primaryCanvas.id,
        timestamp: "2026-06-04T00:00:00.000Z",
      },
    });
    store.appendAgentRunEvent({
      runId: "run-anchor",
      event: {
        type: "message.delta",
        runId: "run-anchor",
        messageId: assistantMessage!.id,
        delta: "hello",
        timestamp: "2026-06-04T00:00:01.000Z",
      },
    });
    store.updateMessage(assistantMessage!.id, {
      role: "assistant",
      content: "hello",
      contentBlocks: [{ type: "text", text: "hello" }],
    });

    const updatedMessage = store
      .listMessages(session!.id)
      ?.find((message) => message.id === assistantMessage!.id);
    const persistedEvents = store.listAgentRunEvents("run-anchor");
    const persistedRun = store.getAgentRun("run-anchor");
    const db = new DatabaseSync(join(dataRoot, "ai-media-canvas.db"));
    const messageRow = db
      .prepare(
        `
          SELECT run_id, run_status, last_run_event_id
          FROM chat_messages
          WHERE id = ?
          LIMIT 1
        `,
      )
      .get(assistantMessage!.id) as
      | {
          last_run_event_id: string | null;
          run_id: string | null;
          run_status: string | null;
        }
      | undefined;
    db.close();

    expect(updatedMessage).toMatchObject({
      id: assistantMessage!.id,
      content: "hello",
      contentBlocks: [{ type: "text", text: "hello" }],
    });
    expect(persistedEvents.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(persistedRun).toMatchObject({
      id: "run-anchor",
      assistant_message_id: assistantMessage!.id,
      runtime_kind: "local-agent",
      runtime_provider: "codex",
      status: "accepted",
    });
    expect(messageRow).toEqual({
      last_run_event_id: "run-anchor:2",
      run_id: "run-anchor",
      run_status: "accepted",
    });
  });

  it("does not append events after a terminal run event", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const project = store.createProject({ name: "Terminal Events" });
    const session = store.createSession(
      project.primaryCanvas.id,
      "Terminal session",
    );
    expect(session).not.toBeNull();

    store.createAgentRun({
      canvasId: project.primaryCanvas.id,
      runId: "run-terminal",
      sessionId: session!.id,
    });

    const terminal = store.appendAgentRunEvent({
      runId: "run-terminal",
      event: {
        type: "run.canceled",
        runId: "run-terminal",
        timestamp: "2026-06-04T00:00:00.000Z",
      },
    });
    const duplicate = store.appendAgentRunEvent({
      runId: "run-terminal",
      event: {
        type: "run.failed",
        runId: "run-terminal",
        error: {
          code: "run_failed",
          message: "late failure",
        },
        timestamp: "2026-06-04T00:00:01.000Z",
      },
    });

    expect(terminal).toEqual({ eventId: "run-terminal:1", seq: 1 });
    expect(duplicate).toEqual({
      duplicate: true,
      eventId: "run-terminal:1",
      seq: 1,
    });
    expect(
      store.listAgentRunEvents("run-terminal").map((entry) => entry.event.type),
    ).toEqual(["run.canceled"]);
  });

  it("finds the latest active run for a specific canvas and session", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const project = store.createProject({ name: "Resume Binding" });
    const sessionA = store.createSession(project.primaryCanvas.id, "Session A");
    const sessionB = store.createSession(project.primaryCanvas.id, "Session B");
    expect(sessionA).not.toBeNull();
    expect(sessionB).not.toBeNull();

    store.createAgentRun({
      canvasId: project.primaryCanvas.id,
      model: "codex:gpt-5.4",
      runtimeKind: "local-agent",
      runtimeProvider: "codex",
      runId: "run-a",
      sessionId: sessionA!.id,
    });
    store.createAgentRun({
      canvasId: project.primaryCanvas.id,
      model: "codex:gpt-5.4",
      runtimeKind: "local-agent",
      runId: "run-b",
      sessionId: sessionB!.id,
    });
    store.updateAgentRun({
      runId: "run-b",
      status: "running",
    });

    expect(
      store.getActiveAgentRun(project.primaryCanvas.id, sessionA!.id),
    ).toMatchObject({
      id: "run-a",
      session_id: sessionA!.id,
    });
    expect(
      store.getActiveAgentRun(project.primaryCanvas.id, sessionB!.id),
    ).toMatchObject({
      id: "run-b",
      session_id: sessionB!.id,
    });
  });

  it("persists durable per-canvas replay sequence for agent events", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const project = store.createProject({ name: "Canvas Replay" });
    const session = store.createSession(
      project.primaryCanvas.id,
      "Replay session",
    );
    expect(session).not.toBeNull();

    store.createAgentRun({
      canvasId: project.primaryCanvas.id,
      model: "codex:gpt-5.4",
      runtimeKind: "local-agent",
      runtimeProvider: "codex",
      runId: "run-canvas",
      sessionId: session!.id,
    });

    const first = store.appendAgentRunEvent({
      canvasId: project.primaryCanvas.id,
      runId: "run-canvas",
      event: {
        type: "run.started",
        runId: "run-canvas",
        sessionId: session!.id,
        conversationId: project.primaryCanvas.id,
        timestamp: "2026-06-04T00:00:00.000Z",
      },
    });
    const second = store.appendAgentRunEvent({
      canvasId: project.primaryCanvas.id,
      runId: "run-canvas",
      event: {
        type: "canvas.sync",
        runId: "run-canvas",
        timestamp: "2026-06-04T00:00:01.000Z",
      },
    });

    expect(first.canvasSeq).toBe(1);
    expect(second.canvasSeq).toBe(2);
    expect(store.getLatestCanvasEventSeq(project.primaryCanvas.id)).toBe(2);
    expect(
      store.listCanvasAgentEvents(project.primaryCanvas.id, 1).map((entry) => ({
        canvasSeq: entry.canvasSeq,
        eventId: entry.eventId,
        type: entry.event.type,
      })),
    ).toEqual([
      {
        canvasSeq: 2,
        eventId: "run-canvas:2",
        type: "canvas.sync",
      },
    ]);
  });

  it("recovers interrupted agent runs on startup and appends a terminal failure event", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const project = store.createProject({ name: "Interrupted Run" });
    const session = store.createSession(
      project.primaryCanvas.id,
      "Interrupted session",
    );
    expect(session).not.toBeNull();

    store.createAgentRun({
      canvasId: project.primaryCanvas.id,
      model: "codex:gpt-5.4",
      runtimeKind: "local-agent",
      runtimeProvider: "codex",
      runId: "run-interrupted",
      sessionId: session!.id,
    });
    store.updateAgentRun({
      runId: "run-interrupted",
      status: "running",
    });
    store.appendAgentRunEvent({
      canvasId: project.primaryCanvas.id,
      runId: "run-interrupted",
      event: {
        type: "run.started",
        runId: "run-interrupted",
        sessionId: session!.id,
        conversationId: project.primaryCanvas.id,
        timestamp: "2026-06-04T00:00:00.000Z",
      },
    });

    const reopenedStore = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });
    const recovered = reopenedStore.recoverInterruptedAgentRuns(
      "Recovered interrupted run.",
    );
    const run = reopenedStore.getAgentRun("run-interrupted");
    const events = reopenedStore.listAgentRunEvents("run-interrupted");

    expect(recovered).toBe(1);
    expect(run?.status).toBe("failed");
    expect(events.at(-1)?.event).toMatchObject({
      type: "run.failed",
      error: {
        code: "run_failed",
        message: "Recovered interrupted run.",
      },
    });
  });

  it("hides archived project canvases and sessions from active access", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const project = store.createProject({ name: "Archive Me" });
    const session = store.createSession(
      project.primaryCanvas.id,
      "Archive session",
    );

    expect(session).not.toBeNull();
    expect(store.archiveProject(project.id)).toBe(true);
    expect(store.getCanvas(project.primaryCanvas.id)).toBeNull();
    expect(store.listSessions(project.primaryCanvas.id)).toBeNull();
    expect(store.createSession(project.primaryCanvas.id)).toBeNull();
    expect(store.listMessages(session!.id)).toBeNull();
  });

  it("applies the default brand kit to newly created projects", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const defaultKit = store.createBrandKit({ name: "Default Kit" });
    store.updateBrandKit(defaultKit.id, { is_default: true });

    const project = store.createProject({ name: "Uses Default Kit" });
    const storedProject = store.getProject(project.id);

    expect(storedProject).not.toBeNull();
    expect(storedProject?.brand_kit_id).toBe(defaultKit.id);
  });

  it("rejects binding a project to a missing brand kit", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const project = store.createProject({ name: "Broken Reference" });
    const result = store.updateProject(project.id, {
      brandKitId: "11111111-1111-1111-1111-111111111111",
    });

    expect(result).toEqual({ ok: false, reason: "brand_kit_not_found" });
    expect(store.getProject(project.id)?.brand_kit_id).toBeNull();
  });

  it("refuses to delete assets that are still referenced by local app data", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const project = store.createProject({ name: "Asset Guard" });
    const uploaded = store.uploadFile({
      bucket: "project-assets",
      fileName: "ref.png",
      fileBuffer: Buffer.from("png"),
      mimeType: "image/png",
      projectId: project.id,
    });
    const session = store.createSession(
      project.primaryCanvas.id,
      "Attachment Session",
    );

    expect(session).not.toBeNull();
    store.createMessage(session!.id, {
      role: "user",
      content: "See attachment",
      contentBlocks: [
        {
          type: "image",
          assetId: uploaded.asset.id,
          url: uploaded.url,
          mimeType: "image/png",
          source: "upload",
          name: "ref.png",
        },
      ],
    });

    expect(store.deleteAsset(uploaded.asset.id)).toEqual({
      ok: false,
      reason: "asset_in_use",
    });

    const thumbnail = store.saveProjectThumbnail(
      project.id,
      Buffer.from("thumb"),
      "image/png",
    );
    const thumbnailAssetId = thumbnail?.thumbnailUrl.split("/").at(-1);

    expect(thumbnailAssetId).toBeTruthy();
    expect(store.deleteAsset(thumbnailAssetId!)).toEqual({
      ok: false,
      reason: "asset_in_use",
    });
  });

  it("manages bundled and imported local skills", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    const catalog = store.listCatalogSkills();
    expect(catalog.length).toBeGreaterThan(0);

    expect(catalog.some((skill) => skill.installed)).toBe(true);
    expect(catalog.some((skill) => skill.name === "Canvas Design")).toBe(true);
    const canvasDirectorSkill = catalog.find(
      (skill) => skill.name === "Canvas Director",
    );
    expect(canvasDirectorSkill).toBeDefined();
    const canvasDirectorDetail = store.getSkillDetail(canvasDirectorSkill!.id);
    expect(canvasDirectorDetail?.skillContent).toContain(
      "Inspect the real element bounds before any layout pass",
    );
    expect(canvasDirectorDetail?.skillContent).toContain(
      "Do not add decorative labels, dividers, badges, buttons, or detail text around generated media unless the user explicitly asks for editable layered layout.",
    );

    const bundled = catalog.find((skill) => skill.installed) ?? catalog[0];
    expect(bundled).toBeDefined();
    const localDirectorySkill = catalog.find(
      (skill) => skill.name === "Canvas Design",
    );
    expect(localDirectorySkill).toBeDefined();
    const localDirectoryDetail = store.getSkillDetail(localDirectorySkill!.id);
    expect(localDirectoryDetail?.metadata).toMatchObject({
      scope: "local-directory",
      path: "skills/canvas-design/SKILL.md",
    });
    expect(localDirectoryDetail?.metadata.files).toContain(
      "canvas-fonts/ArsenalSC-Regular.ttf",
    );

    const imported = store.importSkill({
      files: [
        {
          filePath: "custom/SKILL.md",
          content: `# Local Storyboard Skill

## Description
Help the assistant break an idea into storyboard beats.

## Instructions
1. Ask for the key beats.
2. Suggest a shot list.
`,
        },
      ],
    });

    expect(imported).not.toBeNull();
    expect(imported?.name).toBe("Local Storyboard Skill");

    const frontmatterSkill = store.importSkill({
      files: [
        {
          filePath: "pua/SKILL.md",
          content: `name: pua
description: "Use when the user explicitly requests PUA mode or signals frustration."
license: MIT

# PUA 我们不养闲 Agent
`,
        },
      ],
    });

    expect(frontmatterSkill).not.toBeNull();
    expect(frontmatterSkill?.name).toBe("pua");
    expect(frontmatterSkill?.description).toBe(
      "Use when the user explicitly requests PUA mode or signals frustration.",
    );

    const enabled = store.listEnabledSkills().map((skill) => skill.id);
    expect(enabled).toContain(bundled!.id);
    expect(enabled).toContain(imported!.id);

    store.toggleSkill(imported!.id, { enabled: false });
    expect(store.listEnabledSkills().map((skill) => skill.id)).not.toContain(
      imported!.id,
    );

    expect(store.uninstallSkill(imported!.id)).toBe(true);
    expect(store.getSkillDetail(imported!.id)).toBeNull();
  });

  it("exposes enabled local skills through the workspace skills query path", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-"));
    tempDirs.push(dataRoot);

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });
    const project = store.createProject({ name: "Local Agent Skills" });
    const client = createLocalUserClient(store);

    const workspaceSkills = await loadWorkspaceSkills(
      client as never,
      project.primaryCanvas.id,
    );

    expect(workspaceSkills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "canvas-director",
          path: "/workspace-skills/canvas-director/SKILL.md",
          content: expect.stringContaining("Inspect the real element bounds"),
        }),
        expect.objectContaining({
          name: "imagegen",
          path: "/workspace-skills/imagegen/SKILL.md",
          content: expect.stringContaining(
            "Use the app's canonical `generate_image` tool",
          ),
        }),
      ]),
    );
  });

  it("persists local workspace model and provider settings across store reloads", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-"));
    tempDirs.push(dataRoot);

    const firstStore = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    firstStore.updateWorkspaceSettings({
      defaultModel: "google:gemini-2.5-flash",
      providerModels: {
        openai: ["openai:gpt-4.1"],
        anthropic: ["anthropic:claude-sonnet-4-5"],
        agnes: ["agnes:agnes-2.0-flash"],
        google: ["google:gemini-2.5-flash"],
        vertex: [],
      },
      openAIApiKey: "sk-local-openai",
      openAIApiBase: "http://127.0.0.1:4000/v1",
      anthropicApiKey: "sk-local-anthropic",
      anthropicBaseUrl: "https://api.anthropic.com",
      agnesApiKey: "sk-local-agnes",
      agnesBaseUrl: "https://local.agnes.example/v1",
      agnesDefaultModel: "agnes:agnes-2.0-flash",
      googleApiKey: "google-local-key",
      googleVertexProject: "vertex-project",
      googleVertexLocation: "global",
      googleVertexVideoLocation: "us-central1",
      replicateApiToken: "replicate-local-token",
      kieApiKey: "",
      kieBaseUrl: "",
      volcesApiKey: "volces-local-key",
      volcesBaseUrl: "https://volces.example.com/api/v3",
      codexImagegenDelegation: "ask",
    });

    const reopenedStore = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    expect(reopenedStore.getWorkspaceSettings()).toEqual({
      defaultModel: "google:gemini-2.5-flash",
      providerModels: {
        openai: ["openai:gpt-4.1"],
        anthropic: ["anthropic:claude-sonnet-4-5"],
        agnes: ["agnes:agnes-2.0-flash"],
        google: ["google:gemini-2.5-flash"],
        vertex: [],
      },
      openAIApiKey: "sk-local-openai",
      openAIApiBase: "http://127.0.0.1:4000/v1",
      anthropicApiKey: "sk-local-anthropic",
      anthropicBaseUrl: "https://api.anthropic.com",
      agnesApiKey: "sk-local-agnes",
      agnesBaseUrl: "https://local.agnes.example/v1",
      agnesDefaultModel: "agnes:agnes-2.0-flash",
      googleApiKey: "google-local-key",
      googleVertexProject: "vertex-project",
      googleVertexLocation: "global",
      googleVertexVideoLocation: "us-central1",
      replicateApiToken: "replicate-local-token",
      kieApiKey: "",
      kieBaseUrl: "",
      volcesApiKey: "volces-local-key",
      volcesBaseUrl: "https://volces.example.com/api/v3",
      codexImagegenDelegation: "ask",
    });
  });

  it("migrates legacy workspace settings rows in existing sqlite data", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-"));
    tempDirs.push(dataRoot);

    const db = new DatabaseSync(join(dataRoot, "ai-media-canvas.db"));
    db.exec(`
      CREATE TABLE workspace_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        default_model TEXT NOT NULL
      );
      INSERT INTO workspace_settings (id, default_model)
      VALUES (1, 'openai:gpt-4o');
    `);
    db.close();

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    expect(store.getWorkspaceSettings()).toEqual({
      defaultModel: "openai:gpt-4o",
      providerModels: {
        openai: [],
        anthropic: [],
        agnes: [],
        google: [],
        vertex: [],
      },
      openAIApiKey: "",
      openAIApiBase: "",
      anthropicApiKey: "",
      anthropicBaseUrl: "",
      agnesApiKey: "",
      agnesBaseUrl: "",
      agnesDefaultModel: "",
      googleApiKey: "",
      googleVertexProject: "",
      googleVertexLocation: "",
      googleVertexVideoLocation: "",
      replicateApiToken: "",
      kieApiKey: "",
      kieBaseUrl: "",
      volcesApiKey: "",
      volcesBaseUrl: "",
      codexImagegenDelegation: "ask",
    });
  });

  it("updates migrated legacy workspace settings rows without inserting a second record", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "aimc-store-"));
    tempDirs.push(dataRoot);

    const db = new DatabaseSync(join(dataRoot, "ai-media-canvas.db"));
    db.exec(`
      CREATE TABLE workspace_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        default_model TEXT NOT NULL
      );
      INSERT INTO workspace_settings (id, default_model)
      VALUES (1, 'openai:gpt-4o');
    `);
    db.close();

    const store = createLocalStore({
      assetBaseUrl: "http://127.0.0.1:3001",
      dataRoot,
    });

    expect(
      store.updateWorkspaceSettings({
        defaultModel: "agnes:agnes-2.0-flash",
        providerModels: {
          openai: [],
          anthropic: [],
          agnes: ["agnes:agnes-2.0-flash"],
          google: [],
          vertex: [],
        },
        openAIApiKey: "",
        openAIApiBase: "",
        anthropicApiKey: "",
        anthropicBaseUrl: "",
        agnesApiKey: "sk-local-agnes",
        agnesBaseUrl: "",
        agnesDefaultModel: "agnes:agnes-2.0-flash",
        googleApiKey: "",
        googleVertexProject: "",
        googleVertexLocation: "",
        googleVertexVideoLocation: "",
        replicateApiToken: "",
        kieApiKey: "",
        kieBaseUrl: "",
        volcesApiKey: "",
        volcesBaseUrl: "",
        codexImagegenDelegation: "ask",
      }),
    ).toEqual({
      defaultModel: "agnes:agnes-2.0-flash",
      providerModels: {
        openai: [],
        anthropic: [],
        agnes: ["agnes:agnes-2.0-flash"],
        google: [],
        vertex: [],
      },
      openAIApiKey: "",
      openAIApiBase: "",
      anthropicApiKey: "",
      anthropicBaseUrl: "",
      agnesApiKey: "sk-local-agnes",
      agnesBaseUrl: "",
      agnesDefaultModel: "agnes:agnes-2.0-flash",
      googleApiKey: "",
      googleVertexProject: "",
      googleVertexLocation: "",
      googleVertexVideoLocation: "",
      replicateApiToken: "",
      kieApiKey: "",
      kieBaseUrl: "",
      volcesApiKey: "",
      volcesBaseUrl: "",
      codexImagegenDelegation: "ask",
    });
  });
});
