const assert = require("node:assert/strict");
const test = require("node:test");

const {
  acceptRoundtableReply,
  clampTurnCount,
  createRoundtableTransaction,
  markRoundtableSent,
  normalizeRoundtableState
} = require("../orchestration.js");

test("ordinary roundtable remains a deterministic two-reviewer transaction", () => {
  let pending = createRoundtableTransaction({
    id: "roundtable_normal",
    sourceTurnId: "turn_human",
    firstAgent: "gemini",
    autonomous: false,
    createdAt: 1000
  });

  assert.equal(pending.maxTurns, 2);
  pending = markRoundtableSent(pending, "gemini", 1100);

  const first = acceptRoundtableReply(pending, "gemini", 1200);
  assert.equal(first.accepted, true);
  assert.equal(first.complete, false);
  assert.equal(first.nextAgent, "chatgpt");

  pending = markRoundtableSent(first.pending, "chatgpt", 1300);
  const second = acceptRoundtableReply(pending, "chatgpt", 1400);
  assert.equal(second.accepted, true);
  assert.equal(second.complete, true);
  assert.equal(second.pending.completedTurns, 2);
});

test("have-at-it alternates until its bounded turn count", () => {
  let pending = createRoundtableTransaction({
    id: "roundtable_auto",
    sourceTurnId: "turn_human",
    firstAgent: "chatgpt",
    autonomous: true,
    maxTurns: 4,
    createdAt: 1000
  });
  const speakers = ["chatgpt", "gemini", "chatgpt", "gemini"];

  for (let index = 0; index < speakers.length; index += 1) {
    pending = markRoundtableSent(pending, speakers[index], 1100 + index * 100);
    const result = acceptRoundtableReply(pending, speakers[index], 1150 + index * 100);

    assert.equal(result.accepted, true);
    assert.equal(result.complete, index === speakers.length - 1);
    pending = result.pending;
  }

  assert.equal(pending.completedTurns, 4);
});

test("roundtable ignores the wrong agent and historical replies", () => {
  const pending = markRoundtableSent(createRoundtableTransaction({
    id: "roundtable_guarded",
    firstAgent: "gemini",
    autonomous: true,
    maxTurns: 6,
    createdAt: 1000
  }), "gemini", 1500);

  assert.equal(acceptRoundtableReply(pending, "chatgpt", 1600).accepted, false);
  assert.equal(acceptRoundtableReply(pending, "gemini", 1499).accepted, false);
});

test("autonomous turn limit is clamped to the supported range", () => {
  assert.equal(clampTurnCount(1), 2);
  assert.equal(clampTurnCount(7), 7);
  assert.equal(clampTurnCount(99), 10);
});

test("roundtable settings and pending transaction survive normalization", () => {
  const normalized = normalizeRoundtableState({
    enabled: true,
    nextFirst: "chatgpt",
    autonomous: { enabled: true, maxTurns: 8 },
    pending: createRoundtableTransaction({
      id: "roundtable_saved",
      firstAgent: "chatgpt",
      autonomous: true,
      maxTurns: 8,
      createdAt: 1000
    })
  });

  assert.equal(normalized.enabled, true);
  assert.equal(normalized.nextFirst, "chatgpt");
  assert.deepEqual(normalized.autonomous, { enabled: true, maxTurns: 8 });
  assert.equal(normalized.pending.maxTurns, 8);
});
