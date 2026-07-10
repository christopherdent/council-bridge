const assert = require("node:assert/strict");
const test = require("node:test");

const {
  findRoutingTags,
  parseHandoffTag,
  resolveTargetFromTag
} = require("../routing.js");

const TARGETS = {
  chatgpt: {
    key: "chatgpt",
    label: "ChatGPT",
    defaultNickname: "ChatGPT"
  },
  gemini: {
    key: "gemini",
    label: "Gemini",
    defaultNickname: "Gemini"
  }
};

const nicknames = {
  chatgpt: "Wolf",
  gemini: "Spark"
};

function getAgentName(target) {
  return nicknames[target.key] || target.defaultNickname || target.label;
}

function resolveTarget(tag) {
  return resolveTargetFromTag(tag, TARGETS, getAgentName);
}

function collectComposerTargetKeys(text) {
  const targets = new Set();

  for (const tagMatch of findRoutingTags(text)) {
    const target = resolveTarget(tagMatch.tag);

    if (!target) {
      continue;
    }

    if (target === "both") {
      targets.add(TARGETS.gemini.key);
      targets.add(TARGETS.chatgpt.key);
    } else {
      targets.add(target.key);
    }
  }

  return targets.size > 0
    ? Array.from(targets)
    : [TARGETS.gemini.key, TARGETS.chatgpt.key];
}

test("valid agent tag is detected at message start", () => {
  assert.deepEqual(parseHandoffTag("@wolf please review this", "gemini", resolveTarget), {
    tag: "@wolf",
    toAgent: "chatgpt"
  });
});

test("valid agent tag is detected in message middle", () => {
  assert.deepEqual(parseHandoffTag("I want @wolf to review this", "gemini", resolveTarget), {
    tag: "@wolf",
    toAgent: "chatgpt"
  });
});

test("valid agent tag is detected at absolute end of string", () => {
  assert.deepEqual(parseHandoffTag("Over to you @wolf", "gemini", resolveTarget), {
    tag: "@wolf",
    toAgent: "chatgpt"
  });
});

test("valid agent tag is detected before trailing spaces", () => {
  assert.deepEqual(parseHandoffTag("Over to you @wolf   ", "gemini", resolveTarget), {
    tag: "@wolf",
    toAgent: "chatgpt"
  });
});

test("valid agent tag is detected before newline", () => {
  assert.deepEqual(parseHandoffTag("Over to you @wolf\n", "gemini", resolveTarget), {
    tag: "@wolf",
    toAgent: "chatgpt"
  });
});

test("valid agent tag is detected before supported punctuation", () => {
  assert.deepEqual(parseHandoffTag("Over to you @wolf.", "gemini", resolveTarget), {
    tag: "@wolf.",
    toAgent: "chatgpt"
  });
});

test("two identical messages remain distinct parser events", () => {
  const first = findRoutingTags("Same text @wolf");
  const second = findRoutingTags("Same text @wolf");

  assert.notEqual(first, second);
  assert.deepEqual(first, second);
});

test("multiple valid tags preserve first other-agent handoff behavior", () => {
  assert.deepEqual(parseHandoffTag("@spark then @wolf", "gemini", resolveTarget), {
    tag: "@wolf",
    toAgent: "chatgpt"
  });
});

test("composer routing resolves multiple valid agent tags", () => {
  assert.deepEqual(collectComposerTargetKeys("@spark and @wolf please compare"), [
    "gemini",
    "chatgpt"
  ]);
});

test("all supported aliases resolve through existing alias rules", () => {
  const chatgptAliases = ["@lobo", "@chatgpt", "@gpt", "@wolf"];
  const geminiAliases = ["@gemini", "@gem", "@spark"];
  const bothAliases = ["@both", "@council", "@all"];

  for (const alias of chatgptAliases) {
    assert.equal(resolveTarget(alias).key, "chatgpt", alias);
  }

  for (const alias of geminiAliases) {
    assert.equal(resolveTarget(alias).key, "gemini", alias);
  }

  for (const alias of bothAliases) {
    assert.equal(resolveTarget(alias), "both", alias);
  }
});

test("sender targeting itself does not create a handoff", () => {
  assert.equal(parseHandoffTag("I can take this @spark", "gemini", resolveTarget), null);
});

test("tag-like text inside fenced code blocks does not route", () => {
  const text = [
    "Example:",
    "```text",
    "@wolf should stay literal",
    "```"
  ].join("\n");

  assert.equal(parseHandoffTag(text, "gemini", resolveTarget), null);
});

test("tag-like text after fenced code blocks still routes", () => {
  const text = [
    "Example:",
    "```text",
    "@wolf should stay literal",
    "```",
    "Actual handoff @wolf"
  ].join("\n");

  assert.deepEqual(parseHandoffTag(text, "gemini", resolveTarget), {
    tag: "@wolf",
    toAgent: "chatgpt"
  });
});

test("malformed or partial tags do not route", () => {
  assert.equal(parseHandoffTag("Please ask @wol/f", "gemini", resolveTarget), null);
  assert.equal(parseHandoffTag("Please ask @", "gemini", resolveTarget), null);
  assert.equal(parseHandoffTag("Please ask name@wolf", "gemini", resolveTarget), null);
});

test("ordinary text containing an agent name without a routing token does not route", () => {
  assert.equal(parseHandoffTag("Wolf should review this later", "gemini", resolveTarget), null);
});

test("existing both-route composer scenarios remain unchanged", () => {
  assert.deepEqual(collectComposerTargetKeys("@all please compare"), [
    "gemini",
    "chatgpt"
  ]);
});
