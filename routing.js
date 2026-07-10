(function attachCouncilBridgeRouting(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.CouncilBridgeRouting = api;
})(typeof globalThis === "object" ? globalThis : this, function createCouncilBridgeRouting() {
  const TAG_PATTERN = /(^|[^\w-])(@([a-z0-9_-]+)[,:;.!?]?)(?=\s|$)/gi;
  const FENCED_CODE_BLOCK_PATTERN = /```[\s\S]*?(?:```|$)/g;

  function findRoutingTags(text) {
    const value = String(text || "");
    const searchableText = maskFencedCodeBlocks(value);
    const tags = [];

    for (const match of searchableText.matchAll(TAG_PATTERN)) {
      tags.push({
        tag: match[2],
        alias: match[3],
        index: match.index + match[1].length
      });
    }

    return tags;
  }

  function resolveTargetFromTag(tag, targets, getAgentName) {
    const normalized = normalizeTagAlias(tag);

    if ([
      "gemini",
      "gem",
      normalizeTagAlias(getAgentName(targets.gemini))
    ].includes(normalized)) {
      return targets.gemini;
    }

    if ([
      "lobo",
      "chatgpt",
      "gpt",
      normalizeTagAlias(getAgentName(targets.chatgpt))
    ].includes(normalized)) {
      return targets.chatgpt;
    }

    if (["both", "council", "all"].includes(normalized)) {
      return "both";
    }

    return null;
  }

  function parseHandoffTag(text, fromAgent, resolveTarget) {
    for (const tagMatch of findRoutingTags(text)) {
      const target = resolveTarget(tagMatch.tag);

      if (!target || target === "both" || target.key === fromAgent) {
        continue;
      }

      return {
        tag: tagMatch.tag,
        toAgent: target.key
      };
    }

    return null;
  }

  function normalizeTagAlias(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/^@/, "")
      .replace(/[,:;.!?]+$/g, "")
      .replace(/[^a-z0-9_-]+/g, "");
  }

  function maskFencedCodeBlocks(text) {
    return String(text || "").replace(FENCED_CODE_BLOCK_PATTERN, (block) => {
      return block.replace(/[^\n]/g, " ");
    });
  }

  return {
    findRoutingTags,
    maskFencedCodeBlocks,
    normalizeTagAlias,
    parseHandoffTag,
    resolveTargetFromTag
  };
});
