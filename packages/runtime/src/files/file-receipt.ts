export type FileReceiptStatus =
  | "verified"
  | "delivered"
  | "blocked"
  | "stale"
  | "cancelled"
  | "unknown"
  | "failed"
  | "denied"
  | "needs_approval";

export interface FileReceipt {
  receiptId: string;
  workspaceId: string;
  op: string;
  status: FileReceiptStatus;
  committed: boolean;
  verified: boolean;
  beforeSha256?: string;
  afterSha256?: string;
  bytes?: number;
  restoreRef?: string;
  message: string;
}

export function fileReceiptIsComplete(receipt: FileReceipt): boolean {
  return receipt.status === "verified";
}
