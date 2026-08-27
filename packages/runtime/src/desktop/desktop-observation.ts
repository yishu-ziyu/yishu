export interface DesktopObservationTarget {
  targetId: string;
  role?: string;
  enabled?: boolean;
}

export interface DesktopObservation {
  observationId: string;
  capturedAt: string;
  expiresAt: string;
  frontmostBundleId?: string;
  frontmostPid?: number;
  windowId?: string;
  windowBounds?: { x: number; y: number; width: number; height: number };
  targets: DesktopObservationTarget[];
  focusedTargetId?: string;
  pixelSpace?: "global-top-left" | "appkit-bottom-left";
  warnings: string[];
  previousReadback?: string;
}

export function observationIsFresh(
  observation: DesktopObservation,
  now: Date,
): boolean {
  return Date.parse(observation.expiresAt) > now.getTime();
}

export function observationHasTarget(
  observation: DesktopObservation,
  targetId: string,
): boolean {
  return observation.targets.some((target) => target.targetId === targetId);
}
