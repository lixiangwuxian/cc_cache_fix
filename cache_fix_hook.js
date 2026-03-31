// cache_fix_hook.js — Fetch hook to fix Claude Code prompt cache bugs.
//
// Bug 1: Bypassed by running extracted JS via standard Bun (no native scanner).
// Bug 2: Fixed by normalizing messages[] payload before each API request.
//
// Usage:
//   bun run --preload cache_fix_hook.js claude_patched.js [claude args...]
//
// What this hook does:
//   On every /v1/messages request (non-batch, non-count_tokens), it normalizes
//   the message payload so that:
//
//   1. System-reminder blocks (hooks, skills) in the LAST user message are
//      moved to messages[1] (the first user message), matching fresh-session
//      structure. This aligns the token prefix for cache hits on --resume.
//
//   2. Skills listing entries are sorted alphabetically so the skills block
//      is deterministic across requests.
//
//   3. <session_knowledge> tags are stripped from hooks blocks to remove
//      resume-specific content that would break prefix alignment.
//
//   4. cache_control breakpoints are adjusted: ephemeral is placed on the
//      last block of messages[1] (the user's actual text), matching fresh.

const fs = require("fs");
const path = require("path");

const CAPTURE_DIR = path.join(__dirname, "captures");
let captureEnabled = !!process.env.CLAUDE_CACHE_FIX_CAPTURE;
let mockEnabled = !!process.env.CLAUDE_CACHE_FIX_MOCK;
if (mockEnabled) captureEnabled = true;
let captureCounter = 0;

function isSystemReminder(text) {
  return typeof text === "string" && text.startsWith("<system-reminder>");
}

function isHooksBlock(text) {
  return isSystemReminder(text) && text.includes("SessionStart hook");
}

function isSkillsBlock(text) {
  return isSystemReminder(text) && text.includes("following skills are available");
}

function isDeferredToolsBlock(text) {
  return typeof text === "string" && text.includes("<available-deferred-tools>");
}

function extractSessionKnowledge(text) {
  const parts = [];
  const stripped = text.replace(/\n(<session_knowledge[^>]*>[\s\S]*?<\/session_knowledge>)/g, (_, m) => {
    parts.push(m);
    return "";
  });
  return { stripped, extracted: parts.join("\n") };
}

function sortSkillsBlock(text) {
  const match = text.match(/^([\s\S]*?\n\n)(- [\s\S]+?)(\n<\/system-reminder>\s*)$/);
  if (!match) return text;

  const [, header, entriesText, footer] = match;
  const entries = entriesText.split(/\n(?=- )/);
  entries.sort();
  return header + entries.join("\n") + footer;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return messages;

  // Find the first user message with actual content (messages[1] typically)
  // and the last user message where resume injects reminders
  let firstUserIdx = -1;
  let lastUserIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      if (firstUserIdx === -1) firstUserIdx = i;
      lastUserIdx = i;
    }
  }

  // messages[0] is usually the deferred-tools listing (role=user, plain string)
  // messages[1] is the first real user message (role=user, content array)
  // On resume, messages[1] is small; hooks/skills are in messages[lastUserIdx]
  if (firstUserIdx === -1 || lastUserIdx === -1) return messages;

  // firstUserIdx should be 0 (deferred tools), so the "real" first user msg is index 1
  const realFirstIdx = firstUserIdx + 1;
  if (realFirstIdx >= messages.length) return messages;

  const firstMsg = messages[realFirstIdx];
  const lastMsg = messages[lastUserIdx];

  if (!Array.isArray(firstMsg.content) || !Array.isArray(lastMsg.content)) return messages;
  if (realFirstIdx === lastUserIdx) {
    // Single user message — just sort skills and normalize
    return normalizeSingleMessage(messages, realFirstIdx);
  }

  // Check if this is a resume scenario:
  // - firstMsg.content has NO hooks/skills blocks
  // - lastMsg.content HAS hooks/skills blocks
  const firstHasHooks = firstMsg.content.some(b => isHooksBlock(b.text));
  const lastHasHooks = lastMsg.content.some(b => isHooksBlock(b.text));

  if (firstHasHooks || !lastHasHooks) {
    // Not a resume pattern (or already normalized). Just sort skills.
    return normalizeSingleMessage(messages, realFirstIdx);
  }

  // Resume detected: move hooks & skills from lastMsg to firstMsg
  const hooksBlocks = [];
  const skillsBlocks = [];
  const lastMsgRemaining = [];
  let sessionKnowledgeText = "";

  for (const block of lastMsg.content) {
    const text = block.text || "";
    if (isHooksBlock(text)) {
      const { stripped, extracted } = extractSessionKnowledge(text);
      hooksBlocks.push({ ...block, text: stripped });
      if (extracted) sessionKnowledgeText += extracted;
    } else if (isSkillsBlock(text)) {
      skillsBlocks.push({ ...block, text: sortSkillsBlock(text) });
    } else {
      lastMsgRemaining.push(block);
    }
  }

  // Build normalized firstMsg: [hooks, skills, ...existing blocks]
  const existingBlocks = firstMsg.content.map(b => {
    const { cache_control, ...rest } = b;
    return rest;
  });

  if (existingBlocks.length > 0) {
    existingBlocks[existingBlocks.length - 1] = {
      ...existingBlocks[existingBlocks.length - 1],
      cache_control: { type: "ephemeral" }
    };
  }

  const normalizedFirst = [
    ...hooksBlocks,
    ...skillsBlocks,
    ...existingBlocks,
  ];

  // Remove cache_control from lastMsg blocks, inject session_knowledge
  // into the last text block of the last user message
  const normalizedLast = lastMsgRemaining.map(b => {
    const { cache_control, ...rest } = b;
    return rest;
  });

  if (sessionKnowledgeText && normalizedLast.length > 0) {
    const lastBlock = normalizedLast[normalizedLast.length - 1];
    if (lastBlock.type === "text" && typeof lastBlock.text === "string") {
      normalizedLast[normalizedLast.length - 1] = {
        ...lastBlock,
        text: lastBlock.text + "\n" + sessionKnowledgeText,
      };
    }
  }

  // Build the new messages array
  const result = [...messages];
  result[realFirstIdx] = { ...firstMsg, content: normalizedFirst };
  result[lastUserIdx] = { ...lastMsg, content: normalizedLast };

  return result;
}

function normalizeSingleMessage(messages, idx) {
  // Just sort skills blocks in-place
  const msg = messages[idx];
  if (!Array.isArray(msg.content)) return messages;

  const normalized = msg.content.map(block => {
    const text = block.text || "";
    if (isSkillsBlock(text)) {
      return { ...block, text: sortSkillsBlock(text) };
    }
    if (isHooksBlock(text)) {
      return { ...block, text: extractSessionKnowledge(text).stripped };
    }
    return block;
  });

  const result = [...messages];
  result[idx] = { ...msg, content: normalized };
  return result;
}

function capturePayload(tag, payload) {
  if (!captureEnabled) return;
  try {
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    captureCounter++;
    const outPath = path.join(CAPTURE_DIR, `${tag}_${String(captureCounter).padStart(4, "0")}.json`);
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
    process.stderr.write(`[cache_fix] Captured → ${outPath}\n`);
  } catch {}
}

// Wrap globalThis.fetch
const _originalFetch = globalThis.fetch;
globalThis.fetch = async function (url, options) {
  const urlStr = typeof url === "string" ? url : url?.url || String(url);

  if (
    urlStr.includes("/v1/messages") &&
    !urlStr.includes("batches") &&
    !urlStr.includes("count_tokens") &&
    options?.body
  ) {
    try {
      const payload = JSON.parse(options.body);

      if (payload.messages) {
        capturePayload("before", payload);

        payload.messages = normalizeMessages(payload.messages);
        options = { ...options, body: JSON.stringify(payload) };

        capturePayload("after", payload);
      }
    } catch {}

    if (mockEnabled) {
      const sseBody = [
        'event: message_start',
        `data: {"type":"message_start","message":{"id":"msg_mock","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}`,
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"[mock] request captured"}}',
        '',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n');

      return new Response(sseBody, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'request-id': 'mock-' + Date.now(),
        },
      });
    }
  }

  return _originalFetch.apply(this, arguments);
};
