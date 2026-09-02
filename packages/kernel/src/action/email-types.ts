export type EmailProvider = "google";

export interface OpenEmailRequest {
  provider: EmailProvider;
  intentId: string;
  attemptId: string;
  basisFrameId: string;
}

export interface OpenEmailResult {
  succeeded: boolean;
  verified: boolean;
  provider?: EmailProvider;
  learned?: boolean;
  needsClarification?: boolean;
  message: string;
  status?: string;
  code?: string;
  method?: string;
  receiptId?: string;
  attemptId?: string;
}

export interface OpenEmailExecutor {
  perform(
    request: OpenEmailRequest,
    signal?: AbortSignal,
  ): Promise<OpenEmailResult>;
}

export interface EmailDefaultStore {
  resolve(signal?: AbortSignal): Promise<EmailProvider | undefined>;
  remember(provider: EmailProvider, signal?: AbortSignal): Promise<boolean>;
}
