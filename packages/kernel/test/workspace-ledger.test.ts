import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createWorkspaceLedger, grantIsActive } from "../src/index.js";

test("ingest reuses the client id and revoke stops the grant", () => {
  const ledger = createWorkspaceLedger();
  const id = randomUUID();
  const first = ledger.ingest({
    id,
    displayName: "Docs",
    rootPathReference: "/tmp/docs",
    scope: { kind: "personal" },
    capabilities: ["read", "create", "edit"],
  });
  assert.equal(first.id, id);
  const again = ledger.ingest({
    id,
    displayName: "Documents",
    rootPathReference: "/tmp/documents",
    scope: { kind: "personal" },
    capabilities: ["read", "create", "edit", "trash"],
  });
  assert.equal(again.id, id);
  assert.equal(again.displayName, "Documents");
  assert.equal(again.rootPathReference, "/tmp/documents");
  assert.equal(ledger.list({ kind: "personal" }).length, 1);

  const revoked = ledger.revoke(id);
  assert.ok(revoked?.revokedAt);
  assert.equal(grantIsActive(revoked!), false);

  const revived = ledger.ingest({
    id,
    displayName: "Docs",
    rootPathReference: "/tmp/docs",
    scope: { kind: "personal" },
    capabilities: ["read"],
  });
  assert.equal(revived.id, id);
  assert.equal(grantIsActive(revived), true);
  assert.equal(revived.revokedAt, undefined);
});

test("ingest rejects a non-uuid id", () => {
  const ledger = createWorkspaceLedger();
  assert.throws(() => ledger.ingest({
    id: "not-a-uuid",
    displayName: "Docs",
    rootPathReference: "/tmp/docs",
    scope: { kind: "personal" },
    capabilities: ["read"],
  }), /UUID/);
});
