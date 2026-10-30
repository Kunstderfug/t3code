import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ThreadRunSummary } from "@t3tools/client-runtime/state/models";

import { useDeadlinePassed } from "../../hooks/useDeadline";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";

// Revisiting an old thread should not spend a model call on a stale outcome.
const SUGGESTION_WINDOW_MS = 60 * 60_000;

/**
 * The suggested next message for a thread whose latest run just completed, or null.
 * Asks only while `wanted` holds, so typing before the run ends never spends a call;
 * once answered the result stays cached for that run.
 */
export function useReplySuggestion(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly latestRun: ThreadRunSummary | null | undefined;
  readonly wanted: boolean;
}): string | null {
  const run = input.latestRun;
  const completedAt = run?.status === "completed" ? (run.completedAt ?? null) : null;
  const expired = useDeadlinePassed(
    completedAt === null ? null : Date.parse(completedAt) + SUGGESTION_WINDOW_MS,
  );
  const runId = input.wanted && run && completedAt !== null && !expired ? run.runId : null;
  const query = useEnvironmentQuery(
    input.threadId !== null && runId !== null
      ? orchestrationEnvironment.replySuggestion({
          environmentId: input.environmentId,
          input: { threadId: input.threadId, runId },
        })
      : null,
  );
  return input.threadId !== null && runId !== null ? (query.data?.suggestion ?? null) : null;
}
