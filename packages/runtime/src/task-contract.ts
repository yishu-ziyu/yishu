// Runtime compatibility surface. The product contract has one canonical
// definition in @yishu/kernel and is only re-exported here for existing imports.
export {
  createTaskExecutionContract,
  decideTaskRetry,
  evaluateTaskCompletion,
  evaluateActionBoundary,
} from "@yishu/kernel";
export type {
  ExternalTaskVerification,
  ActionBoundaryDecision,
  ActionBoundaryInput,
  TaskCompletionKind,
  TaskCompletionObservation,
  TaskExecutionContract,
  TaskExecutionContractInput,
  TaskRetryDecision,
  TaskRetryInput,
  TaskSuccessMode,
} from "@yishu/kernel";

import type { TaskExecutionContract } from "@yishu/kernel";
import type { TurnStartCommand } from "./protocol.js";

const TASK_EXECUTION_CONTRACT = Symbol("yishu.taskExecutionContract");
type ContractCommand = TurnStartCommand & {
  [TASK_EXECUTION_CONTRACT]?: TaskExecutionContract;
};

/** Product-runtime-only attachment; never accepted from the wire schema. */
export function attachTaskExecutionContract(
  command: TurnStartCommand,
  contract: TaskExecutionContract,
): TurnStartCommand {
  Object.defineProperty(command, TASK_EXECUTION_CONTRACT, {
    value: contract,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return command;
}

export function taskExecutionContractFromCommand(
  command: TurnStartCommand,
): TaskExecutionContract | undefined {
  return (command as ContractCommand)[TASK_EXECUTION_CONTRACT];
}
