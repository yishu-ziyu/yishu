#!/usr/bin/env node
/**
 * M0 「像人」 latency evaluator (#1–#9, #15–#17).
 * Reads the real-device log unless --fixture is passed.
 *
 *   node evals/voice/check-latency.mjs --last 30
 *   node evals/voice/check-latency.mjs --last 30 --require-fields
 *   node evals/voice/check-latency.mjs --metric partial-before-keyup
 *   node evals/voice/check-latency.mjs --fixture evals/voice/fixtures/quality.sample.jsonl --json
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../..");

export const DEFAULT_QUALITY_PATH = join(
  homedir(),
  "Library/Application Support/Yishu/Diagnostics/quality.jsonl",
);

export const REQUIRED_FIELDS = [
  "ptt.key_down",
  "ptt.key_up",
  "asr.first_partial",
  "asr.final",
  "turn.start",
  "model.first_byte",
  "tts.first_audio",
];

const EVENT_ALIASES = {
  "asr.final": ["asr.completed"],
  "turn.start": ["turn.started"],
};

export const SPEECH_MIN_MS = 2500;
const ACK_MIN_TOOL_TURNS = 20;
const PRESENCE_CUE_MAX_MS = 300;
const INTERRUPT_PAIR_MAX_MS = 2000;

export const TARGETS = {
  partialBeforeKeyup: { id: "2", metric: "partial-before-keyup", target: "≥80%", min: 0.8 },
  modelP50: { id: "3", metric: "key_up→model.first_byte p50", target: "≤1800", max: 1800 },
  modelP95: { id: "3", metric: "key_up→model.first_byte p95", target: "≤3000", max: 3000 },
  ttsP50: { id: "4", metric: "key_up→tts.first_audio p50", target: "≤2300", max: 2300 },
  ttsP95: { id: "4", metric: "key_up→tts.first_audio p95", target: "≤3500", max: 3500 },
  presence: { id: "5", metric: "key_up→presence.cue ≤300", target: "100%", min: 1 },
  interrupt: { id: "6", metric: "key_down→tts.stopped p95", target: "≤100", max: 100 },
  ack: { id: "9", metric: "ack-before-tool", target: "100% (n≥20)", min: 1 },
  fields: { id: "1", metric: "require-fields", target: "7 timestamps / turn", min: 1 },
  listen: { id: "16", metric: "listen-mode", target: "10 turn.start, no PTT", min: 1 },
  backchannel: { id: "17", metric: "backchannel", target: "aligned, ≤2 / turn", min: 1 },
  stall: { id: "7", metric: "model-stall", target: "response.delta before turn.failed", min: 1 },
  utterances: { id: "8", metric: "hardcoded-utterances", target: "0 hits", max: 0 },
  clipPlayed: { id: "20", metric: "tts.clip_done played≥95%", target: "100%", min: 1 },
  clipGap: { id: "22", metric: "tts.clip_gap p95", target: "≤120", max: 120 },
};

const BANNED_UTTERANCES = [
  "点好了。",
  "这一轮没做成",
  "等太久了",
  "好的，我去查查看",
  "界面结果还没确认",
];

export function parseArgs(argv) {
  const args = { last: 30, requireFields: false, metric: null, json: false, fixture: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--last") args.last = Number(argv[++i]);
    else if (a === "--require-fields") args.requireFields = true;
    else if (a === "--metric") args.metric = String(argv[++i] ?? "");
    else if (a === "--json") args.json = true;
    else if (a === "--fixture") args.fixture = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
  }
  if (!Number.isFinite(args.last) || args.last < 1) args.last = 30;
  return args;
}

export function parseJSONL(text) {
  const events = [];
  let skipped = 0;
  for (const line of String(text).split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && typeof row === "object") events.push(row);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { events, skipped };
}

function turnIdOf(event) {
  const attrs = event.attributes && typeof event.attributes === "object" ? event.attributes : {};
  const raw = event.turnId ?? event.turn_id ?? attrs.turnId ?? attrs.turn_id;
  return raw == null || raw === "" ? null : String(raw);
}

function fieldTms(event) {
  const attrs = event.attributes && typeof event.attributes === "object" ? event.attributes : {};
  const raw = event.t_ms ?? event.tMs ?? attrs.t_ms ?? attrs.tMs;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function occurredAtMs(event) {
  if (!event) return null;
  if (typeof event.occurredAt === "string") {
    const n = Date.parse(event.occurredAt);
    if (Number.isFinite(n)) return n;
  }
  if (typeof event.t === "number" && Number.isFinite(event.t)) return event.t;
  if (typeof event.ts === "number" && Number.isFinite(event.ts)) return event.ts;
  return null;
}

function eventName(event) {
  return typeof event?.name === "string" ? event.name : "";
}

function namesMatch(actual, canonical) {
  if (actual === canonical) return true;
  const aliases = EVENT_ALIASES[canonical] || [];
  return aliases.includes(actual);
}

function findEvents(turnEvents, canonical) {
  return turnEvents.filter((e) => namesMatch(eventName(e), canonical));
}

function firstEvent(turnEvents, canonical) {
  return findEvents(turnEvents, canonical)[0] ?? null;
}

export function percentile(values, p) {
  const xs = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const i = (p / 100) * (xs.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return round1(xs[lo]);
  return round1(xs[lo] + (xs[hi] - xs[lo]) * (i - lo));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function pct(num, den) {
  if (!den) return null;
  return num / den;
}

function fmtPct(rate) {
  if (rate == null) return "n/a";
  return `${(rate * 100).toFixed(1)}%`;
}

function fmtMs(n) {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return String(round1(n));
}

export function groupTurns(events) {
  const byId = new Map();
  const order = [];
  const ensure = (id) => {
    if (!byId.has(id)) {
      const turn = { id, events: [] };
      byId.set(id, turn);
      order.push(turn);
    }
    return byId.get(id);
  };
  let current = null;
  let seq = 0;
  for (const event of events) {
    const id = turnIdOf(event);
    if (id) {
      current = ensure(id);
      current.events.push(event);
      continue;
    }
    if (eventName(event) === "ptt.key_down") {
      current = ensure(`anon-${++seq}`);
      current.events.push(event);
      continue;
    }
    if (!current) current = ensure(`anon-${++seq}`);
    current.events.push(event);
  }
  return order.map(enrichTurn);
}

function enrichTurn(turn) {
  const ev = turn.events;
  const keyUp = firstEvent(ev, "ptt.key_up");
  const keyDown = firstEvent(ev, "ptt.key_down");
  const keyUpAbs = occurredAtMs(keyUp);
  const keyDownAbs = occurredAtMs(keyDown);

  const rel = (canonical) => {
    const e = firstEvent(ev, canonical);
    if (!e) return null;
    const tms = fieldTms(e);
    if (tms != null) return tms;
    const abs = occurredAtMs(e);
    if (abs != null && keyUpAbs != null) return abs - keyUpAbs;
    return null;
  };

  let speechMs = null;
  if (typeof keyUp?.durationMs === "number" && Number.isFinite(keyUp.durationMs)) {
    speechMs = keyUp.durationMs;
  } else if (keyUpAbs != null && keyDownAbs != null) {
    speechMs = keyUpAbs - keyDownAbs;
  } else {
    const downRel = rel("ptt.key_down");
    if (downRel != null) speechMs = Math.abs(downRel);
  }

  const times = {};
  for (const name of [
    ...REQUIRED_FIELDS,
    "tts.stopped",
    "presence.cue",
    "presence.backchannel",
    "tool.started",
    "response.delta",
    "turn.failed",
  ]) {
    times[name] = rel(name);
  }

  const has = (canonical) => firstEvent(ev, canonical) != null;

  return {
    id: turn.id,
    events: ev,
    speechMs,
    keyUpAbs,
    keyDownAbs,
    times,
    has,
    isPtt: has("ptt.key_up") || has("ptt.key_down"),
  };
}

export function lastPttTurns(turns, n) {
  const ptt = turns.filter((t) => t.isPtt);
  return ptt.slice(-n);
}

function eventTimeMs(event, fallbackKeyUpAbs = null) {
  const abs = occurredAtMs(event);
  if (abs != null) return abs;
  const tms = fieldTms(event);
  if (tms != null && fallbackKeyUpAbs != null) return fallbackKeyUpAbs + tms;
  return null;
}

export function interruptDeltas(events) {
  const timed = events
    .map((event) => ({ event, t: eventTimeMs(event) }))
    .filter((row) => row.t != null)
    .sort((a, b) => a.t - b.t);
  const deltas = [];
  let ttsOpen = false;
  let interruptDown = null;
  for (const { event, t } of timed) {
    const name = eventName(event);
    if (name === "tts.first_audio") ttsOpen = true;
    if (name === "ptt.key_down" && ttsOpen) interruptDown = t;
    if (name === "tts.stopped") {
      if (interruptDown != null && t >= interruptDown && t - interruptDown <= INTERRUPT_PAIR_MAX_MS) {
        deltas.push(t - interruptDown);
      }
      interruptDown = null;
      ttsOpen = false;
    }
  }
  return deltas;
}

function ackBeforeTool(turns) {
  const toolTurns = [];
  for (const turn of turns) {
    const tools = findEvents(turn.events, "tool.started");
    if (!tools.length) continue;
    const deltas = findEvents(turn.events, "response.delta");
    const firstTool = Math.min(
      ...tools.map((e) => eventTimeMs(e, turn.keyUpAbs)).filter((n) => n != null),
    );
    const firstDelta = deltas
      .map((e) => eventTimeMs(e, turn.keyUpAbs))
      .filter((n) => n != null);
    const ok =
      Number.isFinite(firstTool) &&
      firstDelta.some((t) => t < firstTool);
    toolTurns.push({ id: turn.id, ok });
  }
  return toolTurns;
}

function numericAttr(turns, canonical, key) {
  const values = [];
  for (const turn of turns) {
    for (const event of findEvents(turn.events, canonical)) {
      const n = Number(event.attributes?.[key]);
      if (Number.isFinite(n)) values.push(n);
    }
  }
  return values;
}

/** #20: a clip counts as played in full when wall time ≥95% of its trimmed duration. */
function clipPlayedReport(turns) {
  const clips = [];
  for (const turn of turns) {
    for (const event of findEvents(turn.events, "tts.clip_done")) {
      const durationMs = Number(event.attributes?.durationMs);
      const playedMs = Number(event.attributes?.playedMs);
      if (Number.isFinite(durationMs) && durationMs > 0 && Number.isFinite(playedMs)) {
        clips.push({ id: turn.id, ok: playedMs >= 0.95 * durationMs });
      }
    }
  }
  const ok = clips.filter((c) => c.ok).length;
  return { n: clips.length, ok, pass: clips.length > 0 && ok === clips.length };
}

function requireFieldsRate(turns) {
  if (!turns.length) return { rate: null, missing: [], n: 0 };
  let ok = 0;
  const missing = [];
  for (const turn of turns) {
    const absent = REQUIRED_FIELDS.filter((name) => !turn.has(name));
    if (!absent.length) ok += 1;
    else missing.push({ id: turn.id, absent });
  }
  return { rate: ok / turns.length, missing, n: turns.length, ok };
}

function listenModeReport(events) {
  let enabled = false;
  let streak = [];
  let best = [];
  let sawSwitch = false;
  const isListenEvent = (name) =>
    name === "listen.mode" ||
    name === "listen.enabled" ||
    name === "listen.disabled" ||
    name === "handsfree.enabled" ||
    name === "handsfree.disabled" ||
    name === "handsfree.changed";

  const enabledOf = (event) => {
    const name = eventName(event);
    const attrs = event.attributes && typeof event.attributes === "object" ? event.attributes : {};
    if (name === "listen.disabled" || name === "handsfree.disabled") return false;
    if (name === "listen.enabled" || name === "handsfree.enabled") return true;
    if (typeof attrs.enabled === "boolean") return attrs.enabled;
    if (typeof event.status === "string") {
      return event.status === "on" || event.status === "enabled" || event.status === "true";
    }
    if (typeof attrs.mode === "string") {
      return attrs.mode === "on" || attrs.mode === "enabled" || attrs.mode === "handsfree";
    }
    return true;
  };

  for (const event of events) {
    const name = eventName(event);
    if (isListenEvent(name)) {
      sawSwitch = true;
      enabled = enabledOf(event);
      if (!enabled) {
        if (streak.length > best.length) best = streak;
        streak = [];
      }
      continue;
    }
    if (name === "ptt.key_down" || name === "ptt.key_up") {
      if (streak.length > best.length) best = streak;
      streak = [];
      enabled = false;
      continue;
    }
    if (namesMatch(name, "turn.start") && enabled) {
      streak.push(event);
    }
  }
  if (streak.length > best.length) best = streak;
  return { sawSwitch, streak: best.length, pass: sawSwitch && best.length >= 10 };
}

function backchannelReport(turns) {
  let turnsWith = 0;
  let aligned = 0;
  let overCap = 0;
  for (const turn of turns) {
    const backs = findEvents(turn.events, "presence.backchannel");
    if (!backs.length) continue;
    turnsWith += 1;
    if (backs.length > 2) overCap += 1;
    const partial = turn.times["asr.first_partial"];
    const keyUp = 0;
    const ok = backs.every((event) => {
      const t = fieldTms(event);
      const abs = eventTimeMs(event, turn.keyUpAbs);
      if (t != null) {
        if (partial != null && t < partial) return false;
        if (turn.has("ptt.key_up") && t > keyUp) return false;
        return true;
      }
      if (abs != null && turn.keyUpAbs != null) {
        if (partial != null && abs < turn.keyUpAbs + partial) return false;
        if (abs > turn.keyUpAbs) return false;
        return true;
      }
      return false;
    });
    if (ok) aligned += 1;
  }
  return {
    turnsWith,
    aligned,
    overCap,
    pass: turnsWith > 0 && aligned === turnsWith && overCap === 0,
  };
}

function stallReport(turns) {
  const failed = turns.filter((t) => t.has("turn.failed"));
  if (!failed.length) return { n: 0, ok: 0, pass: false };
  let ok = 0;
  for (const turn of failed) {
    const failT = eventTimeMs(firstEvent(turn.events, "turn.failed"), turn.keyUpAbs);
    const deltas = findEvents(turn.events, "response.delta")
      .map((e) => eventTimeMs(e, turn.keyUpAbs))
      .filter((n) => n != null);
    if (failT != null && deltas.some((t) => t < failT)) ok += 1;
  }
  return { n: failed.length, ok, pass: ok === failed.length };
}

function walkFiles(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", ".build", "DerivedData"].includes(entry.name)) continue;
      walkFiles(full, acc);
    } else if (/\.(swift|ts|mjs|js)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

export function hardcodedUtteranceHits() {
  const roots = [
    join(REPO, "packages/runtime/src"),
    join(REPO, "apps/clicky/leanring-buddy"),
  ];
  const hits = [];
  for (const root of roots) {
    for (const file of walkFiles(root)) {
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const needle of BANNED_UTTERANCES) {
        if (text.includes(needle)) {
          hits.push({ file: file.slice(REPO.length + 1), needle });
        }
      }
    }
  }
  return hits;
}

function row(spec, actual, n, pass, note = "") {
  return {
    id: spec.id,
    metric: spec.metric,
    target: spec.target,
    actual,
    n,
    pass: Boolean(pass),
    note,
  };
}

function metricKey(name) {
  return String(name || "")
    .replace(/→/g, "->")
    .replace(/≤/g, "<=")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function rowMatchesMetric(rowMetric, wanted) {
  if (!wanted) return true;
  const a = metricKey(rowMetric);
  const b = metricKey(wanted);
  return a === b || a.startsWith(b) || b.startsWith(a.split(" p")[0]);
}

export function evaluate(events, options = {}) {
  const last = options.last ?? 30;
  const turns = lastPttTurns(groupTurns(events), last);
  const rows = [];

  const long = turns.filter((t) => (t.speechMs ?? 0) >= SPEECH_MIN_MS);
  const partialOk = long.filter((t) => {
    const tms = t.times["asr.first_partial"];
    return tms != null && tms < 0;
  });
  const partialRate = pct(partialOk.length, long.length);
  rows.push(
    row(
      TARGETS.partialBeforeKeyup,
      fmtPct(partialRate),
      long.length,
      partialRate != null && partialRate >= TARGETS.partialBeforeKeyup.min,
      `speech≥${SPEECH_MIN_MS}ms`,
    ),
  );

  const model = turns.map((t) => t.times["model.first_byte"]).filter((n) => n != null);
  const modelP50 = percentile(model, 50);
  const modelP95 = percentile(model, 95);
  rows.push(row(TARGETS.modelP50, fmtMs(modelP50), model.length, modelP50 != null && modelP50 <= TARGETS.modelP50.max));
  rows.push(row(TARGETS.modelP95, fmtMs(modelP95), model.length, modelP95 != null && modelP95 <= TARGETS.modelP95.max));

  const tts = turns.map((t) => t.times["tts.first_audio"]).filter((n) => n != null);
  const ttsP50 = percentile(tts, 50);
  const ttsP95 = percentile(tts, 95);
  rows.push(row(TARGETS.ttsP50, fmtMs(ttsP50), tts.length, ttsP50 != null && ttsP50 <= TARGETS.ttsP50.max));
  rows.push(row(TARGETS.ttsP95, fmtMs(ttsP95), tts.length, ttsP95 != null && ttsP95 <= TARGETS.ttsP95.max));

  const cueOk = turns.filter((t) => t.times["presence.cue"] != null && t.times["presence.cue"] <= PRESENCE_CUE_MAX_MS);
  const cueRate = pct(cueOk.length, turns.length);
  rows.push(
    row(
      TARGETS.presence,
      fmtPct(cueRate),
      turns.length,
      cueRate != null && cueRate >= 1 && turns.length > 0,
    ),
  );

  const interrupts = interruptDeltas(events);
  const interruptP95 = percentile(interrupts, 95);
  rows.push(
    row(
      TARGETS.interrupt,
      fmtMs(interruptP95),
      interrupts.length,
      interruptP95 != null && interruptP95 <= TARGETS.interrupt.max,
    ),
  );

  const clipPlayed = clipPlayedReport(turns);
  rows.push(
    row(
      TARGETS.clipPlayed,
      clipPlayed.n ? `${clipPlayed.ok}/${clipPlayed.n}` : "no tts.clip_done",
      clipPlayed.n,
      clipPlayed.pass,
    ),
  );

  const gaps = numericAttr(turns, "tts.clip_gap", "gapMs");
  const gapP95 = percentile(gaps, 95);
  rows.push(
    row(
      TARGETS.clipGap,
      gaps.length ? fmtMs(gapP95) : "no tts.clip_gap",
      gaps.length,
      gapP95 != null && gapP95 <= TARGETS.clipGap.max,
    ),
  );

  const ack = ackBeforeTool(turns);
  const ackOk = ack.filter((t) => t.ok).length;
  const ackRate = pct(ackOk, ack.length);
  rows.push(
    row(
      TARGETS.ack,
      ack.length ? `${fmtPct(ackRate)} (n=${ack.length})` : "n/a (n=0)",
      ack.length,
      ack.length >= ACK_MIN_TOOL_TURNS && ackOk === ack.length,
    ),
  );

  const fields = requireFieldsRate(turns);
  rows.push(
    row(
      TARGETS.fields,
      fields.n ? `${fields.ok}/${fields.n}` : "n/a",
      fields.n,
      fields.n > 0 && fields.rate === 1,
    ),
  );

  const listen = listenModeReport(events);
  rows.push(
    row(
      TARGETS.listen,
      listen.sawSwitch ? `streak ${listen.streak}` : "no listen.mode event",
      listen.streak,
      listen.pass,
    ),
  );

  const back = backchannelReport(turns);
  rows.push(
    row(
      TARGETS.backchannel,
      back.turnsWith ? `${back.aligned}/${back.turnsWith} aligned` : "none",
      back.turnsWith,
      back.pass,
    ),
  );

  const stall = stallReport(turns);
  rows.push(
    row(
      TARGETS.stall,
      stall.n ? `${stall.ok}/${stall.n}` : "no turn.failed",
      stall.n,
      stall.pass,
    ),
  );

  const hits = hardcodedUtteranceHits();
  rows.push(
    row(
      TARGETS.utterances,
      hits.length ? `${hits.length} hits` : "0",
      hits.length,
      hits.length === 0,
      hits[0] ? hits[0].file : "",
    ),
  );

  const wanted = options.metric ? metricKey(options.metric) : null;
  const requireFields = Boolean(options.requireFields);
  const faultStall = options.fault === "model_stall" || process.env.YISHU_FAULT === "model_stall";

  const gated = rows.filter((r) => {
    if (wanted) return rowMatchesMetric(r.metric, wanted);
    if (r.metric === TARGETS.fields.metric) return requireFields;
    if (r.metric === TARGETS.listen.metric) return false;
    if (r.metric === TARGETS.backchannel.metric) return false;
    if (r.metric === TARGETS.stall.metric) return faultStall;
    if (r.metric === TARGETS.utterances.metric) return wanted === metricKey(TARGETS.utterances.metric);
    return ["2", "3", "4", "5", "6", "9", "20", "22"].includes(r.id);
  });

  const failed = gated.filter((r) => !r.pass);
  return { rows: gated, gated, failed, turns, n: turns.length, listen, back, stall, hits };
}

export function formatTable(report) {
  const cols = [
    ["#", (r) => r.id],
    ["metric", (r) => r.metric],
    ["target", (r) => r.target],
    ["actual", (r) => r.actual],
    ["n", (r) => String(r.n)],
    ["result", (r) => (r.pass ? "PASS" : "FAIL")],
  ];
  const widths = cols.map((col) =>
    Math.max(col[0].length, ...report.rows.map((r) => String(col[1](r)).length)),
  );
  const line = (cells) =>
    cells.map((c, i) => String(c)[i === cols.length - 1 ? "padEnd" : "padEnd"](widths[i])).join("  ");
  const header = line(cols.map((c) => c[0]));
  const body = report.rows.map((r) => line(cols.map((c) => c[1](r))));
  return [header, "-".repeat(header.length), ...body].join("\n");
}

export function isoAt(baseMs, offsetMs) {
  return new Date(baseMs + offsetMs).toISOString();
}

export function qualityEvent({
  id,
  name,
  turnId,
  t_ms,
  occurredAt,
  durationMs,
  attributes = {},
  status,
  sessionId = "voice",
}) {
  const event = {
    schemaVersion: 1,
    eventId: id,
    occurredAt,
    appPid: 1,
    sessionId,
    name,
    attributes,
  };
  if (turnId != null) event.turnId = turnId;
  if (t_ms != null) event.t_ms = t_ms;
  if (durationMs != null) event.durationMs = durationMs;
  if (status != null) event.status = status;
  return event;
}

export function buildPassingFixture() {
  const base = Date.parse("2026-09-04T04:00:00.000Z");
  const events = [];
  events.push(
    qualityEvent({
      id: "listen-on",
      name: "listen.mode",
      occurredAt: isoAt(base, -180_000),
      attributes: {},
      status: "on",
    }),
  );
  for (let i = 0; i < 10; i++) {
    const t0 = base - 170_000 + i * 8_000;
    const tid = `hf-${String(i + 1).padStart(2, "0")}`;
    events.push(
      qualityEvent({
        id: `${tid}-start`,
        name: "turn.start",
        turnId: tid,
        t_ms: 0,
        occurredAt: isoAt(t0, 0),
      }),
    );
  }
  events.push(
    qualityEvent({
      id: "listen-off",
      name: "listen.mode",
      occurredAt: isoAt(base, -5_000),
      status: "off",
    }),
  );

  for (let i = 0; i < 30; i++) {
    const t0 = base + i * 8_000;
    const tid = `t${String(i + 1).padStart(2, "0")}`;
    const delayedStop = i >= 20 && i <= 24;
    const stopAt = delayedStop ? 8_000 + 40 : 3_500;
    events.push(
      qualityEvent({
        id: `${tid}-down`,
        name: "ptt.key_down",
        turnId: tid,
        t_ms: -3000,
        occurredAt: isoAt(t0, 0),
      }),
    );
    events.push(
      qualityEvent({
        id: `${tid}-partial`,
        name: "asr.first_partial",
        turnId: tid,
        t_ms: -1200,
        occurredAt: isoAt(t0, 1800),
      }),
    );
    if (i < 5) {
      events.push(
        qualityEvent({
          id: `${tid}-bc1`,
          name: "presence.backchannel",
          turnId: tid,
          t_ms: -800,
          occurredAt: isoAt(t0, 2200),
        }),
      );
      events.push(
        qualityEvent({
          id: `${tid}-bc2`,
          name: "presence.backchannel",
          turnId: tid,
          t_ms: -400,
          occurredAt: isoAt(t0, 2600),
        }),
      );
    }
    events.push(
      qualityEvent({
        id: `${tid}-up`,
        name: "ptt.key_up",
        turnId: tid,
        t_ms: 0,
        occurredAt: isoAt(t0, 3000),
        durationMs: 3000,
      }),
    );
    events.push(
      qualityEvent({
        id: `${tid}-cue`,
        name: "presence.cue",
        turnId: tid,
        t_ms: 50,
        occurredAt: isoAt(t0, 3050),
      }),
    );
    events.push(
      qualityEvent({
        id: `${tid}-turn`,
        name: "turn.start",
        turnId: tid,
        t_ms: 80,
        occurredAt: isoAt(t0, 3080),
      }),
    );
    events.push(
      qualityEvent({
        id: `${tid}-final`,
        name: "asr.final",
        turnId: tid,
        t_ms: 400,
        occurredAt: isoAt(t0, 3400),
      }),
    );
    events.push(
      qualityEvent({
        id: `${tid}-byte`,
        name: "model.first_byte",
        turnId: tid,
        t_ms: 1100,
        occurredAt: isoAt(t0, 4100),
      }),
    );
    events.push(
      qualityEvent({
        id: `${tid}-audio`,
        name: "tts.first_audio",
        turnId: tid,
        t_ms: 1700,
        occurredAt: isoAt(t0, 4700),
      }),
    );
    if (i < 20) {
      events.push(
        qualityEvent({
          id: `${tid}-delta`,
          name: "response.delta",
          turnId: tid,
          t_ms: 1800,
          occurredAt: isoAt(t0, 4800),
        }),
      );
      events.push(
        qualityEvent({
          id: `${tid}-tool`,
          name: "tool.started",
          turnId: tid,
          t_ms: 2100,
          occurredAt: isoAt(t0, 5100),
        }),
      );
    }
    events.push(
      qualityEvent({
        id: `${tid}-clip1`,
        name: "tts.clip_done",
        turnId: tid,
        t_ms: 3200,
        occurredAt: isoAt(t0, 6200),
        attributes: { durationMs: 1500, playedMs: 1504 },
      }),
    );
    events.push(
      qualityEvent({
        id: `${tid}-gap`,
        name: "tts.clip_gap",
        turnId: tid,
        t_ms: 3240,
        occurredAt: isoAt(t0, 6240),
        attributes: { gapMs: 40 },
      }),
    );
    events.push(
      qualityEvent({
        id: `${tid}-stop`,
        name: "tts.stopped",
        turnId: tid,
        t_ms: stopAt - 3000,
        occurredAt: isoAt(t0, stopAt),
      }),
    );
  }
  events.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  return events;
}

export function loadQualityLog(path) {
  if (!existsSync(path)) {
    throw new Error(`quality log not found: ${path}`);
  }
  return parseJSONL(readFileSync(path, "utf8"));
}

function printHelp() {
  console.log(`Usage:
  node evals/voice/check-latency.mjs --last 30 [--require-fields] [--metric <name>] [--json]
  node evals/voice/check-latency.mjs --fixture <path> --last 30 --require-fields

Default log: ${DEFAULT_QUALITY_PATH}
Metrics: partial-before-keyup | key_up→model.first_byte | key_up→tts.first_audio
         key_up→presence.cue | key_down→tts.stopped | ack-before-tool | require-fields
         listen-mode | backchannel | model-stall | hardcoded-utterances
         tts.clip_done | tts.clip_gap`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  const path = args.fixture ? resolve(args.fixture) : DEFAULT_QUALITY_PATH;
  let parsed;
  try {
    parsed = loadQualityLog(path);
  } catch (err) {
    console.error(String(err.message || err));
    return 1;
  }
  const report = evaluate(parsed.events, args);
  report.path = path;
  report.skipped = parsed.skipped;
  if (args.json) {
    console.log(JSON.stringify({ path, n: report.n, skipped: parsed.skipped, rows: report.rows }, null, 2));
  } else {
    console.log(`log: ${path}`);
    console.log(`turns: ${report.n} (last ${args.last} PTT)`);
    console.log(formatTable(report));
  }
  if (report.failed.length) {
    if (!args.json) {
      console.error(`FAIL ${report.failed.length} metric(s): ${report.failed.map((r) => r.metric).join(", ")}`);
    }
    return 1;
  }
  return 0;
}

const isMain =
  process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  process.exit(main());
}
