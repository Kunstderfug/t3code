import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import type { RunId, ServerSettingsError, TextGenerationError, ThreadId } from "@t3tools/contracts";
import { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

/** Suggests the user's next message from a completed run. Nothing is persisted; clients cache it. */
export class ReplySuggestionService extends Context.Service<
  ReplySuggestionService,
  {
    readonly suggest: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) => Effect.Effect<
      string | null,
      | OrchestratorV2Error
      | ProjectStore.ProjectStoreV2Error
      | ServerSettingsError
      | TextGenerationError
    >;
  }
>()("t3/orchestration-v2/ReplySuggestionService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const suggest: ReplySuggestionService["Service"]["suggest"] = Effect.fn(
    "ReplySuggestionService.suggest",
  )(function* (input) {
    const records = yield* threads.getThreadRecords(input.threadId, ["runs", "messages"], {
      runIds: [input.runId],
      messageRunIds: [input.runId],
      messageRoles: ["user", "assistant"],
    });
    // Interrupted or failed runs are better answered by the user than by a guess.
    if (records.runs.find((run) => run.id === input.runId)?.status !== "completed") return null;

    const context = formatThreadTitleContext(
      records.messages.filter((message) => !message.streaming),
    );
    if (context.message.length === 0) return null;

    const project = yield* projects.get(records.thread.projectId);
    if (Option.isNone(project)) return null;

    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings,
      records.thread.projectId,
    ).settings;
    const result = yield* textGeneration.generateReplySuggestion({
      cwd: records.thread.worktreePath ?? project.value.workspaceRoot,
      conversation: context.message,
      modelSelection: settings.textGenerationModelSelection,
    });
    return result.suggestion.length > 0 ? result.suggestion : null;
  });

  return ReplySuggestionService.of({ suggest });
});

export const layer = Layer.effect(ReplySuggestionService, make);
