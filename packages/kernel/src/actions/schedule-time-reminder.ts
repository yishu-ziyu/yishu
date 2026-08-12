import { z } from "zod";
import { defineYishuAction } from "../action/define.js";
import type {
  ScheduleTimeReminderRequest,
  ScheduleTimeReminderResult,
} from "../action/types.js";

const scheduleTimeReminderInputSchema = z.object({
  reminderId: z.string().uuid(),
  delaySeconds: z.number().int().min(60).max(86_400),
  body: z.string().trim().min(1).max(500),
  intentId: z.string().uuid(),
  attemptId: z.string().uuid(),
  basisFrameId: z.string().uuid(),
}).strict();

export type ScheduleTimeReminderInput = z.infer<typeof scheduleTimeReminderInputSchema>;

/** Schedule one relative system notification and verify it by its identifier. */
export function createScheduleTimeReminderAction() {
  return defineYishuAction({
    name: "schedule_time_reminder",
    description: "Schedule one explicit relative-time reminder through macOS notifications.",
    inputSchema: scheduleTimeReminderInputSchema,
    authority: "explicit_approval",
    risk: "medium",
    reversible: false,
    context: "none",
    run: async (ctx): Promise<ScheduleTimeReminderResult> => {
      const executor = ctx.deps?.scheduleTimeReminder;
      if (!executor) {
        return { succeeded: false, verified: false, status: "failed", code: "runtime_error", method: "unknown", message: "The reminder bridge is unavailable." };
      }
      const request: ScheduleTimeReminderRequest = ctx.input;
      const result = await executor.perform(request, ctx.signal);
      if (result.succeeded) ctx.markCommitted();
      return { ...result, verified: isVerified(result) };
    },
    verify: async (ctx) => ({
      verified: isVerified(ctx.output),
      message: isVerified(ctx.output)
        ? "The exact system reminder was read back."
        : "The reminder was not verified as scheduled.",
    }),
  });
}

function isVerified(result: ScheduleTimeReminderResult): boolean {
  return result.succeeded === true
    && result.verified === true
    && result.status === "verified"
    && result.code === "verified_system_notification"
    && result.method === "native_command";
}
