import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EVEROS_PROFILE_ID_PREFIX,
  EverOSHttpClient,
  everosMessagesForTurn,
  mapEverOSProfiles,
  mapEverOSSearchHits,
} from "../src/memory/everos-client.js";
import {
  everosProjectId,
  memoryScopeFromEverOSProject,
} from "../src/memory/everos-ids.js";

describe("everos ids", () => {
  it("maps personal and project scopes to path-safe project ids", () => {
    assert.equal(everosProjectId("personal"), "personal");
    assert.equal(
      everosProjectId("project:11111111-1111-4111-8111-111111111111"),
      "11111111-1111-4111-8111-111111111111",
    );
    assert.equal(everosProjectId("project:../etc"), "personal");
    assert.equal(
      everosProjectId("personal", {
        appId: "jarvis",
        userId: "yishu",
        personalProjectId: "yishu",
      }),
      "yishu",
    );
    assert.equal(
      everosProjectId("project:../etc", {
        appId: "jarvis",
        userId: "owner",
        personalProjectId: "yishu",
      }),
      "yishu",
    );
    assert.equal(memoryScopeFromEverOSProject("yishu", {
      appId: "jarvis",
      userId: "owner",
      personalProjectId: "yishu",
    }), "personal");
  });
});

describe("EverOSHttpClient", () => {
  it("posts add, flush, and keyword search against the EverOS routes", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = new EverOSHttpClient({
      baseUrl: "http://127.0.0.1:18765/",
      fetchImpl: async (input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push({ url, body });
        if (url.endsWith("/api/v2/memory/search")) {
          return new Response(JSON.stringify({
            request_id: "r1",
            data: {
              episodes: [{
                id: "ep_1",
                summary: "User climbs in Yosemite every spring",
                timestamp: "2026-08-18T00:00:00.000Z",
                project_id: "personal",
                atomic_facts: [{
                  id: "af_1",
                  content: "User climbs in Yosemite every spring",
                }],
              }],
              profiles: [],
              agent_cases: [],
              agent_skills: [],
              unprocessed_messages: [],
            },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          request_id: "r1",
          data: { message_count: 2, status: "extracted" },
        }), { status: 200 });
      },
    });

    await client.add({
      sessionId: "conv-1",
      scopeKey: "personal",
      deferExtraction: true,
      messages: everosMessagesForTurn({
        utterance: "I climb in Yosemite every spring",
        replyText: "Got it.",
        timestampMs: 1_720_000_000_000,
      }),
    });
    await client.flush({ sessionId: "conv-1", scopeKey: "personal" });
    const hits = await client.search({
      scopeKey: "personal",
      query: "Where do I climb?",
    });

    assert.equal(calls[0]?.url, "http://127.0.0.1:18765/api/v2/memory/add");
    assert.equal(calls[0]?.body.app_id, "yishu");
    assert.equal(calls[0]?.body.project_id, "personal");
    assert.equal(calls[0]?.body.defer_extraction, true);
    assert.deepEqual(
      (calls[0]?.body.messages as Array<{ role: string }>).map((row) => row.role),
      ["user", "assistant"],
    );
    assert.equal(calls[1]?.url, "http://127.0.0.1:18765/api/v2/memory/flush");
    assert.equal(calls[2]?.body.method, "keyword");
    assert.equal(calls[2]?.body.top_k, -1);
    assert.equal(calls[2]?.body.user_id, "owner");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.id, "af_1");
    assert.match(hits[0]?.claim ?? "", /Yosemite/);
  });

  it("gets only explicit profile facts with the attached identity", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = new EverOSHttpClient({
      baseUrl: "http://127.0.0.1:18000/",
      identity: { appId: "yishu", userId: "owner", personalProjectId: "personal" },
      fetchImpl: async (input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push({ url, body });
        return new Response(JSON.stringify({
          request_id: "r-profile",
          data: {
            profiles: [{
              id: "yishu",
              profile_data: {
                summary: "艺书，本名马浩宣，现居深圳。",
                explicit_info: [{ description: "日常手机助手用墨思，不要卸。" }],
                implicit_traits: [{ description: "对设备和数据安全有清晰底线。" }],
              },
            }],
          },
        }), { status: 200 });
      },
    });

    const hits = await client.profile({ scopeKey: "personal" });
    assert.equal(calls[0]?.url, "http://127.0.0.1:18000/api/v2/memory/get");
    assert.equal(calls[0]?.body.app_id, "yishu");
    assert.equal(calls[0]?.body.user_id, "owner");
    assert.equal(calls[0]?.body.project_id, "personal");
    assert.equal(calls[0]?.body.memory_type, "profile");
    assert.deepEqual(hits.map((row) => row.claim), ["日常手机助手用墨思，不要卸。"]);
    assert.ok(hits.every((row) => row.id.startsWith(EVEROS_PROFILE_ID_PREFIX)));
    assert.ok(hits.every((row) => row.authority === "derived"));
  });

  it("maps explicit profile facts and drops weak search scores", () => {
    const profiles = mapEverOSProfiles([
      {
        id: "yishu",
        profile_data: {
          summary: "艺书，本名马浩宣，现居深圳。",
          explicit_info: [{ description: "日常手机助手用墨思，不要卸。" }],
          implicit_traits: [{ description: "对设备和数据安全有清晰底线。" }],
        },
      },
    ], "personal");
    assert.deepEqual(profiles.map((row) => row.claim), ["日常手机助手用墨思，不要卸。"]);
    assert.ok(profiles.every((row) => row.id.startsWith(EVEROS_PROFILE_ID_PREFIX)));

    const weak = mapEverOSSearchHits({
      data: {
        episodes: [{
          id: "ep_weak",
          timestamp: "2026-08-18T00:00:00.000Z",
          project_id: "personal",
          atomic_facts: [{
            id: "af_weak",
            content: "实验室包桌面名是 Operit Debug。",
            score: 0.01,
          }],
        }],
      },
    }, "personal");
    assert.equal(weak.length, 0);
  });

  it("drops secret-looking search hits", () => {
    const hits = mapEverOSSearchHits({
      data: {
        episodes: [{
          id: "ep_secret",
          summary: "api_key = sk-abcdefghijklmnopqrstuvwxyz",
          timestamp: "2026-08-18T00:00:00.000Z",
          project_id: "personal",
        }],
      },
    }, "personal");
    assert.equal(hits.length, 0);
  });

  it("rejects a user identity that collides with the assistant sender", () => {
    assert.throws(() => new EverOSHttpClient({
      baseUrl: "http://127.0.0.1:18765",
      identity: { appId: "yishu", userId: "yishu", personalProjectId: "personal" },
    }), /everos_user_assistant_identity_collision/);
  });

  it("rejects path-unsafe identity partitions", () => {
    assert.throws(() => new EverOSHttpClient({
      baseUrl: "http://127.0.0.1:18765",
      identity: { appId: "../other", userId: "owner", personalProjectId: "personal" },
    }), /everos_invalid_identity/);
  });
});
