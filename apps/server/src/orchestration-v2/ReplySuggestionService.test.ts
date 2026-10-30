import { assert, describe, it, vi } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ReplySuggestion from "./ReplySuggestionService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const projectId = ProjectId.make("project:reply-suggestion");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in reply suggestion tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

function makeHarness(suggestion: string) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "reply-suggestion" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest({});
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  const generateReplySuggestion = vi.fn((_input: TextGeneration.ReplySuggestionGenerationInput) =>
    Effect.succeed({ suggestion }),
  );
  const layerProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: () =>
      Effect.succeedSome({
        projectId,
        title: "Project",
        workspaceRoot: "/repo",
        defaultModelSelection: modelSelection,
        defaultThreadEnvMode: null,
        autoPull: false,
        faviconPath: null,
        projectIcon: null,
        scripts: [],
        createdAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
        deletedAt: null,
      }),
  });
  const layerReplySuggestion = ReplySuggestion.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerThreadManagement,
        layerProjects,
        Layer.mock(TextGeneration.TextGeneration)({ generateReplySuggestion }),
        layerServerSettings,
      ),
    ),
  );
  return {
    layer: Layer.mergeAll(layerOrchestrator, layerThreadManagement, layerReplySuggestion),
    generateReplySuggestion,
  };
}

/** Creates a thread holding one settled run with a single exchange. */
function seedThread(input: {
  readonly status: "completed" | "rolled_back";
  readonly user: string;
  readonly assistant: string;
}) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:reply-suggestion");
    const runId = RunId.make("run:reply-suggestion");
    const providerThreadId = ProviderThreadId.make(`${threadId}:provider`);
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make("command:reply-suggestion:create"),
      threadId,
      projectId,
      title: "Thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const message = (role: "user" | "assistant", text: string) => ({
      id: EventId.make(`${runId}:${role}`),
      type: "message.updated" as const,
      threadId,
      runId,
      occurredAt: now,
      payload: {
        id: MessageId.make(`${runId}:${role}`),
        threadId,
        runId,
        nodeId: null,
        role,
        text,
        attachments: [],
        streaming: false,
        createdBy: "user" as const,
        creationSource: "web" as const,
        createdAt: now,
        updatedAt: now,
      },
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${runId}:created`),
          type: "run.created",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`${runId}:user`),
            rootNodeId: null,
            activeAttemptId: null,
            status: input.status,
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        message("user", input.user),
        message("assistant", input.assistant),
      ],
    });
    return { threadId, runId };
  });
}

describe("ReplySuggestionService", () => {
  it.effect("suggests from the completed run's exchange in the thread's workspace", () =>
    Effect.gen(function* () {
      const harness = makeHarness("Now add tests for the parser");
      yield* Effect.gen(function* () {
        const service = yield* ReplySuggestion.ReplySuggestionService;
        const ids = yield* seedThread({
          status: "completed",
          user: "Fix the parser crash",
          assistant: "Fixed the crash. Want me to add regression tests?",
        });

        assert.equal(yield* service.suggest(ids), "Now add tests for the parser");
        const call = harness.generateReplySuggestion.mock.calls[0]?.[0];
        assert.equal(call?.cwd, "/repo");
        assert.isTrue(call?.conversation.includes("Fix the parser crash"));
        assert.isTrue(call?.conversation.includes("Want me to add regression tests?"));
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("skips the model for a run that did not complete", () =>
    Effect.gen(function* () {
      const harness = makeHarness("unused");
      yield* Effect.gen(function* () {
        const service = yield* ReplySuggestion.ReplySuggestionService;
        const ids = yield* seedThread({ status: "rolled_back", user: "Try it", assistant: "Ok" });

        assert.isNull(yield* service.suggest(ids));
        assert.equal(harness.generateReplySuggestion.mock.calls.length, 0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("returns null when the model has nothing useful to suggest", () =>
    Effect.gen(function* () {
      const harness = makeHarness("");
      yield* Effect.gen(function* () {
        const service = yield* ReplySuggestion.ReplySuggestionService;
        const ids = yield* seedThread({ status: "completed", user: "Thanks", assistant: "Bye" });

        assert.isNull(yield* service.suggest(ids));
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
