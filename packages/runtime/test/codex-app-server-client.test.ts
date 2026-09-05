import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexAppServerClient, codexChildEnvironment } from "../src/providers/codex-app-server-client.js";

test("Codex child keeps normal environment but inherits neither host session nor API billing", () => {
  assert.deepEqual(codexChildEnvironment({ HOME: "/home", PATH: "/bin", CODEX_THREAD_ID: "x", CUA_CONTEXT: "y", OPENAI_API_KEY: "z" }), { HOME: "/home", PATH: "/bin" });
});

test("RPC handles fragmented UTF-8 lines, coalesced events and server request IDs independently", async () => {
  const script = `
    require('readline').createInterface({input:process.stdin}).on('line', line => {
      const m=JSON.parse(line);
      const body=Buffer.from(JSON.stringify({method:'event',params:{text:'奕枢'}})+'\\n'+JSON.stringify({id:m.id,method:'permission',params:{}})+'\\n'+JSON.stringify({id:m.id,result:{ok:true}})+'\\n');
      process.stdout.write(body.subarray(0,42)); setTimeout(()=>process.stdout.write(body.subarray(42)),10);
    });
  `;
  const client = new CodexAppServerClient({ cwd: process.cwd(), executable: process.execPath, args: ["-e", script] });
  const events: string[] = [];
  client.subscribe((message) => { if (message.method) events.push(message.method); });
  try {
    assert.deepEqual(await client.request("test", {}), { ok: true });
    assert.deepEqual(events, ["event", "permission"]);
  } finally { await client.close(); }
});

test("process death rejects in-flight RPC instead of hanging", async () => {
  const client = new CodexAppServerClient({ cwd: process.cwd(), executable: process.execPath, args: ["-e", "setTimeout(()=>process.exit(1),30)"] });
  try { await assert.rejects(client.request("test", {}), /退出/); }
  finally { await client.close(); }
});
