# Threat model

Type: architecture
Status: current
Verified: local-eval 2026-08-27
Review: new privileged action, credential storage change, or IPC change

| Asset | Attack | Current control | Residual risk | Test |
| --- | --- | --- | --- | --- |
| Desktop / AX | Malicious webpage Prompt Injection | Untrusted wrapping; tool policy; typed actions | Model still sees page text | `untrusted-content` + browser policy |
| Desktop / AX | Malicious model output | Typed `DesktopAction`; no arbitrary shell | A allowed action can still click the wrong control | desktop policy + approval token |
| Local IPC | Other process forges Runtime commands | Random capability token planned; stdio child today | Local attacker with the App's fd | privileged-action allowlist |
| Secrets | Config/log leak | `writeModelConfig` refuses `apiKey`; quality allowlist | Legacy files may still contain secrets until migration | model-config + quality redaction |
| Stale target | Click after UI change | Observation expiry; target must match current observation | Clock skew | desktop-loop stale test |
| Approval replay | Reuse of an approval token | HMAC + nonce set | Secret must stay in the App | approval-token test |
| Browser session | Compromised agent browser | Isolated profile; no user Chrome cookies | Site XSS inside the agent profile | browser policy private-network deny |
| Runtime binary | Child process replaced | App-owned launch; no extra PATH tools in CI | Supply chain of Node runtime | generated-file / release scripts |
| Update | Tampered Sparkle feed | Release scripts require notarized artifacts | Signing identity not yet in CI | `docs/runbooks/release.md` |
| Workspace | Symlink / `..` escape | Realpath prefix check | Race between check and write | files-workspace test |

Runtime must not accept a model-claimed approval boolean. Executor actions are an allowlist; unknown kinds fail closed.
