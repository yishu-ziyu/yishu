import { isAllowedBrowserUrl, type AllowedBrowserUrlOptions } from "@yishu/kernel";

export function browserUrlIsAllowed(
  url: string,
  options: AllowedBrowserUrlOptions = {},
): boolean {
  return isAllowedBrowserUrl(url, options);
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
