import { isAllowedBrowserUrl } from "@yishu/kernel";

export function browserUrlIsAllowed(url: string, allowPrivateNetwork = false): boolean {
  return isAllowedBrowserUrl(url, { allowPrivateNetwork });
}

export function observationTargetIsLive(
  observationId: string,
  currentObservationId: string | undefined,
  fingerprint: string | undefined,
  currentFingerprint: string | undefined,
): boolean {
  if (currentObservationId === undefined || observationId !== currentObservationId) return false;
  if (fingerprint !== undefined && currentFingerprint !== undefined && fingerprint !== currentFingerprint) {
    return false;
  }
  return true;
}
