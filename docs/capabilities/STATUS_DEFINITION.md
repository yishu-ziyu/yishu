# Capability status definition

Type: invariant
Status: current
Verified: local-eval 2026-08-27
Review: status vocabulary or README publication rule changes

Capabilities are graded by evidence, not by the existence of a code path.

| Status | Meaning | May appear in README | May appear in Release Notes |
| --- | --- | --- | --- |
| `implemented` | A code path exists. | no | no |
| `demoable` | Succeeded at least once on a developer Mac. | no | no |
| `accepted` | Passed the fixed scenario on a real Mac. | yes | no |
| `reliable` | Repeated across devices to the published metric. | yes, as "stable" | no |
| `shippable` | Ordinary users can install, recover, and observe it. | yes | yes |

Rules:

- Mock receipts never raise a capability above `implemented`.
- `false_completion_count` must stay 0 for any accepted-or-higher claim.
- README current-capability rows are generated from this matrix. Do not hand-edit a second list.
