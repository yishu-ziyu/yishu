import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface ApprovalToken {
  requestId: string;
  actionDigest: string;
  appBundleId?: string;
  expiresAt: string;
  nonce: string;
  mac: string;
}

export function issueApprovalToken(input: {
  secret: string;
  requestId: string;
  actionDigest: string;
  appBundleId?: string;
  expiresAt: string;
  nonce?: string;
}): ApprovalToken {
  const nonce = input.nonce ?? randomBytes(16).toString("hex");
  const payload = canonicalize(input.requestId, input.actionDigest, input.appBundleId, input.expiresAt, nonce);
  return {
    requestId: input.requestId,
    actionDigest: input.actionDigest,
    expiresAt: input.expiresAt,
    nonce,
    mac: createHmac("sha256", input.secret).update(payload).digest("hex"),
    ...(input.appBundleId === undefined ? {} : { appBundleId: input.appBundleId }),
  };
}

export function verifyApprovalToken(input: {
  secret: string;
  token: ApprovalToken;
  requestId: string;
  actionDigest: string;
  appBundleId?: string;
  now: Date;
  seenNonces: Set<string>;
}): boolean {
  if (input.token.requestId !== input.requestId) return false;
  if (input.token.actionDigest !== input.actionDigest) return false;
  if (input.appBundleId !== undefined && input.token.appBundleId !== input.appBundleId) return false;
  if (Date.parse(input.token.expiresAt) <= input.now.getTime()) return false;
  if (input.seenNonces.has(input.token.nonce)) return false;
  const payload = canonicalize(
    input.token.requestId,
    input.token.actionDigest,
    input.token.appBundleId,
    input.token.expiresAt,
    input.token.nonce,
  );
  const expected = createHmac("sha256", input.secret).update(payload).digest();
  const actual = Buffer.from(input.token.mac, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  input.seenNonces.add(input.token.nonce);
  return true;
}

function canonicalize(
  requestId: string,
  actionDigest: string,
  appBundleId: string | undefined,
  expiresAt: string,
  nonce: string,
): string {
  return [requestId, actionDigest, appBundleId ?? "", expiresAt, nonce].join("\n");
}
