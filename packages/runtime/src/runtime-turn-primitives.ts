export interface DeferredSignal {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

export interface SteerCycle {
  readonly generation: number;
  readonly submitted: DeferredSignal;
  readonly supersededSignal: DeferredSignal;
  readonly deadlineAt: number;
  operation?: Promise<void>;
  text?: string;
  userObserved?: boolean;
  assistantStarted?: boolean;
  superseded?: boolean;
}

export function deferredSignal(): DeferredSignal {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export class SteerReplacementFailedBeforeStartError extends Error {
  constructor() {
    super("Pi replacement failed before producing an assistant response.");
    this.name = "SteerReplacementFailedBeforeStartError";
  }
}
