(function attachCouncilBridgeOrchestration(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.CouncilBridgeOrchestration = api;
})(typeof globalThis === "object" ? globalThis : this, function createCouncilBridgeOrchestration() {
  const AGENT_KEYS = ["gemini", "chatgpt"];
  const DEFAULT_AUTONOMOUS_TURNS = 6;
  const MAX_AUTONOMOUS_TURNS = 10;

  function normalizeRoundtableState(value) {
    const nextFirst = isAgentKey(value?.nextFirst) ? value.nextFirst : "gemini";

    return {
      enabled: Boolean(value?.enabled),
      nextFirst,
      autonomous: {
        enabled: Boolean(value?.autonomous?.enabled),
        maxTurns: clampTurnCount(value?.autonomous?.maxTurns)
      },
      pending: normalizeRoundtablePending(value?.pending)
    };
  }

  function normalizeRoundtablePending(value) {
    if (!value?.id) {
      return null;
    }

    // Migrate the original two-reviewer transaction shape without replaying it.
    const firstAgent = isAgentKey(value.firstAgent) ? value.firstAgent : "";
    const expectedAgent = isAgentKey(value.expectedAgent)
      ? value.expectedAgent
      : (value.status === "waiting_first_reply" ? firstAgent : "");

    if (!firstAgent || !expectedAgent) {
      return null;
    }

    const maxTurns = Boolean(value.autonomous)
      ? clampTurnCount(value.maxTurns)
      : 2;

    return {
      id: String(value.id),
      sourceTurnId: String(value.sourceTurnId || ""),
      firstAgent,
      expectedAgent,
      lastSpeaker: isAgentKey(value.lastSpeaker) ? value.lastSpeaker : "",
      createdAt: normalizeTimestamp(value.createdAt),
      lastSentAt: Number(value.lastSentAt || value.firstSentAt) || 0,
      completedTurns: Math.max(0, Number(value.completedTurns) || 0),
      maxTurns,
      autonomous: Boolean(value.autonomous),
      status: "waiting_reply"
    };
  }

  function createRoundtableTransaction(options) {
    const firstAgent = isAgentKey(options?.firstAgent) ? options.firstAgent : "gemini";
    const autonomous = Boolean(options?.autonomous);

    return {
      id: String(options?.id || `roundtable_${Date.now()}`),
      sourceTurnId: String(options?.sourceTurnId || ""),
      firstAgent,
      expectedAgent: firstAgent,
      lastSpeaker: "",
      createdAt: normalizeTimestamp(options?.createdAt),
      lastSentAt: 0,
      completedTurns: 0,
      maxTurns: autonomous ? clampTurnCount(options?.maxTurns) : 2,
      autonomous,
      status: "waiting_reply"
    };
  }

  function markRoundtableSent(value, targetAgent, sentAt) {
    const pending = normalizeRoundtablePending(value);

    if (!pending || !isAgentKey(targetAgent)) {
      return null;
    }

    return {
      ...pending,
      expectedAgent: targetAgent,
      lastSentAt: normalizeTimestamp(sentAt)
    };
  }

  function acceptRoundtableReply(value, speakerAgent, turnCreatedAt) {
    const pending = normalizeRoundtablePending(value);

    if (!pending || speakerAgent !== pending.expectedAgent) {
      return { accepted: false, complete: false, pending };
    }

    const createdAt = normalizeTimestamp(turnCreatedAt);
    const earliestReplyAt = pending.lastSentAt || pending.createdAt;

    if (createdAt < earliestReplyAt) {
      return { accepted: false, complete: false, pending };
    }

    const completedTurns = pending.completedTurns + 1;

    if (completedTurns >= pending.maxTurns) {
      return {
        accepted: true,
        complete: true,
        nextAgent: "",
        pending: {
          ...pending,
          completedTurns,
          lastSpeaker: speakerAgent
        }
      };
    }

    const nextAgent = getCounterpartAgent(speakerAgent);

    return {
      accepted: true,
      complete: false,
      nextAgent,
      pending: {
        ...pending,
        expectedAgent: nextAgent,
        lastSpeaker: speakerAgent,
        completedTurns,
        lastSentAt: 0
      }
    };
  }

  function getCounterpartAgent(agentKey) {
    return agentKey === "gemini" ? "chatgpt" : "gemini";
  }

  function clampTurnCount(value) {
    const count = Math.round(Number(value) || DEFAULT_AUTONOMOUS_TURNS);
    return Math.min(MAX_AUTONOMOUS_TURNS, Math.max(2, count));
  }

  function isAgentKey(value) {
    return AGENT_KEYS.includes(value);
  }

  function normalizeTimestamp(value) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
  }

  return {
    acceptRoundtableReply,
    clampTurnCount,
    createRoundtableTransaction,
    getCounterpartAgent,
    markRoundtableSent,
    normalizeRoundtablePending,
    normalizeRoundtableState
  };
});
