import { randomUUID } from "node:crypto";

export interface ResourceLeaseGrant {
  granted: true;
  token: string;
  epoch: number;
}

export interface ResourceLeaseBusy {
  granted: false;
  reason: "busy";
}

export type ResourceLeaseResult = ResourceLeaseGrant | ResourceLeaseBusy;

interface ResourceOwner {
  ownerId: string;
  token: string;
  epoch: number;
}

/** Single-process, non-queuing lease for exclusive execution resources. */
export class ResourceLease {
  private readonly owners = new Map<string, ResourceOwner>();
  private readonly epochs = new Map<string, number>();

  acquire(resource: string, ownerId: string): ResourceLeaseResult {
    if (this.owners.has(resource)) {
      return { granted: false, reason: "busy" };
    }

    const epoch = (this.epochs.get(resource) ?? 0) + 1;
    const token = randomUUID();
    this.epochs.set(resource, epoch);
    this.owners.set(resource, { ownerId, token, epoch });
    return { granted: true, token, epoch };
  }

  holds(resource: string, token: string, epoch: number): boolean {
    const owner = this.owners.get(resource);
    return owner?.token === token && owner.epoch === epoch;
  }

  ownerOf(resource: string): string | null {
    return this.owners.get(resource)?.ownerId ?? null;
  }

  release(resource: string, token: string, epoch: number): boolean {
    if (!this.holds(resource, token, epoch)) return false;
    this.owners.delete(resource);
    return true;
  }

  /** Release a terminal owner without letting an old epoch evict a new lease. */
  forceRelease(resource: string, ownerId: string, epoch: number): boolean {
    const owner = this.owners.get(resource);
    if (owner?.ownerId !== ownerId || owner.epoch !== epoch) return false;
    this.owners.delete(resource);
    return true;
  }
}

/** The one lease coordinator shared by all runtime ports in this process. */
export const processResourceLease = new ResourceLease();
