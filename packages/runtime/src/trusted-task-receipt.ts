import type { RuntimeEvent } from "./protocol.js";

const trustedExternalReceipts = new WeakMap<object, boolean>();

/** Process-local actuator evidence marker; it cannot cross the stdio wire. */
export function markTrustedExternalReceipt(
  event: RuntimeEvent,
  verified: boolean,
): RuntimeEvent {
  trustedExternalReceipts.set(event, verified);
  return event;
}

export function trustedExternalReceiptFor(event: RuntimeEvent): boolean | undefined {
  return trustedExternalReceipts.get(event);
}
