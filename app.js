import Bolt from "@slack/bolt";
import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { config } from "dotenv";

config();

const { App } = Bolt;

// Directory for generated DDR files (./data; on Railway mount volume to /app/data).
const DATA_DIR = join(process.cwd(), "data");

// ─── Initialize ─────────────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
let modelOptionsCache = {
  fetchedAt: 0,
  options: [],
};

const THINKING_WORDS = [
  "thinking",
  "cooking",
  "matriculating",
  "reasoning",
  "synthesizing",
  "contemplating",
  "percolating",
  "analyzing",
  "distilling",
  "triaging",
  "cross-referencing",
  "mapping",
  "inferring",
  "comparing",
  "drafting",
  "assembling",
  "compiling",
  "brainstorming",
  "interrogating",
  "evaluating",
  "aligning",
  "reframing",
  "prioritizing",
  "exploring",
  "calibrating",
  "harmonizing",
  "validating",
  "crunching",
];

// In-memory store for gathering context across interactions.
// Keyed by a unique session ID (we use trigger_id or a generated one).
const sessions = new Map();

// HTTP server for file downloads (used when deployed; links in Slack point here).
const downloadApp = express();
downloadApp.get("/download/:filename", (req, res) => {
  const filename = req.params.filename.replace(/\.\./g, "").replace(/[/\\]/g, "");
  if (!filename.endsWith(".md")) {
    res.status(400).send("Invalid file");
    return;
  }
  const filepath = join(DATA_DIR, filename);
  if (!existsSync(filepath)) {
    res.status(404).send("File not found");
    return;
  }
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.sendFile(filepath);
});

// Keep the process alive on unexpected runtime failures so local dev can recover.
app.error(async (error) => {
  console.error("[bolt] Unhandled app error:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[process] Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[process] Uncaught exception:", error);
});

app.options({ action_id: "model_choice" }, async ({ ack, body }) => {
  try {
    const query = (body.value || "").trim().toLowerCase();
    const options = await getModelOptions();
    console.log("[model_select_options] Options requested", {
      query,
      available: options.length,
    });
    const filteredOptions = query
      ? options.filter((option) =>
          option.text.text.toLowerCase().includes(query)
        )
      : options;

    await ack({ options: filteredOptions.slice(0, 100) });
  } catch (err) {
    console.error("[model_select_options] Failed to load model options:", err);
    await ack({
      options: [buildModelOption(DEFAULT_MODEL, true)],
    });
  }
});

// ─── Slash Command: /ddr ───────────────────────────────────────
// Opens a chooser modal to start from scratch or from a Slack message.
app.command("/ddr", async ({ command, ack, client }) => {
  await ack();

  const triggerId = command.trigger_id;
  const channelId = command.channel_id;
  const initiatedBy = await resolveUserName(command.user_id, client);

  const sessionId = triggerId;
  const metadata = { channelId, userId: command.user_id, initiatedBy, sessionId };

  await client.views.open({
    trigger_id: triggerId,
    view: buildDdrChooserModal(sessionId, metadata),
  });
});

// ─── Modal Submission: Chooser ────────────────────────────────
app.view("ddr_chooser_submit", async ({ ack, view, client }) => {
  const metadata = JSON.parse(view.private_metadata);
  const mode = view.state.values.chooser.mode.selected_option.value;

  const { channelId, userId, initiatedBy, sessionId } = metadata;

  sessions.set(sessionId, {
    channelId,
    userId,
    initiatedBy,
    sourceMessageTs: null,
    threadTs: undefined,
    sourceMessages: "",
    additionalContext: [],
    pendingLinkInputs: [],
    clarifyingQuestions: [],
    selectedModel: DEFAULT_MODEL,
    createdAt: Date.now(),
    appNotInChannel: false,
  });

  if (mode === "from_scratch") {
    await ack({
      response_action: "update",
      view: buildFromScratchModal(sessionId, DEFAULT_MODEL),
    });
  } else {
    const noMessagePlaceholder =
      "(No message selected. Add Slack message links and/or notes in the form below.)";
    const session = sessions.get(sessionId);
    session.sourceMessages = noMessagePlaceholder;

    await ack({
      response_action: "update",
      view: buildGatherContextModal(
        sessionId,
        noMessagePlaceholder,
        [],
        DEFAULT_MODEL,
        false
      ),
    });
  }
});

// ─── Modal Submission: From Scratch ───────────────────────────
app.view("scratch_prompt_submit", async ({ ack, view, client }) => {
  const sessionId = view.private_metadata;
  const session = sessions.get(sessionId);

  if (!session) {
    console.warn("[scratch_prompt_submit] Missing session", { sessionId });
    await ack({
      response_action: "update",
      view: buildSessionExpiredModal(sessionId),
    });
    return;
  }

  const promptText = view.state.values.scratch_prompt?.prompt_input?.value || "";
  const selectedModel =
    view.state.values.model_select?.model_choice?.selected_option?.value ||
    DEFAULT_MODEL;

  session.sourceMessages = promptText;
  session.selectedModel = selectedModel;

  // Continue directly to clarifying questions
  await ack({
    response_action: "update",
    view: buildClarifyingLoadingModal(sessionId, pickRandomThinkingWord()),
  });
  console.log("[scratch_prompt_submit] Acked with loading modal", { sessionId });
  const loadingStartedAt = Date.now();

  const stopLoadingUpdates = startClarifyingLoadingUpdates(
    client,
    view.id,
    sessionId
  );

  try {
    console.log("[scratch_prompt_submit] Generating clarifying questions", {
      sessionId,
    });
    const questions = await withTimeout(
      generateClarifyingQuestions(session),
      25000,
      "clarifying question generation timed out"
    );
    session.clarifyingQuestions = questions;
    console.log("[scratch_prompt_submit] Clarifying questions generated", {
      sessionId,
      count: questions.length,
    });

    await ensureMinimumElapsed(loadingStartedAt, 3000);
    await client.views.update({
      view_id: view.id,
      view: buildClarifyingQuestionsModal(
        sessionId,
        session.sourceMessages,
        questions,
        session.additionalContext
      ),
    });
    console.log("[scratch_prompt_submit] Updated to clarifying modal", {
      sessionId,
    });
    stopLoadingUpdates();
  } catch (err) {
    console.error("[scratch_prompt_submit] Clarifying flow error:", err);
    const fallbackQuestions = [
      "What exact problem are we trying to solve?",
      "What decision should be documented as the outcome?",
      "What are the key tradeoffs or risks?",
      "What alternatives were considered and why not chosen?",
      "Any more context to include before finalizing?",
    ];
    session.clarifyingQuestions = fallbackQuestions;

    try {
      await ensureMinimumElapsed(loadingStartedAt, 3000);
      await client.views.update({
        view_id: view.id,
        view: buildClarifyingQuestionsModal(
          sessionId,
          session.sourceMessages,
          fallbackQuestions,
          session.additionalContext
        ),
      });
      stopLoadingUpdates();
      await safePostEphemeralOrDM(
        client,
        session.channelId,
        session.userId,
        ":warning: Clarifying question generation was slow, so I used fallback questions. You can continue."
      );
    } catch (updateErr) {
      console.error(
        "[scratch_prompt_submit] Fallback clarifying modal update error:",
        updateErr
      );
      stopLoadingUpdates();
      await safePostEphemeralOrDM(
        client,
        session.channelId,
        session.userId,
        ":x: I hit a timeout preparing clarifying questions. Please retry the shortcut."
      );
      sessions.delete(sessionId);
    }
  }
});

// ─── Message Shortcut: "Log Design Decision" ───────────────────
// This fires when a user clicks the shortcut from the message context menu.
app.shortcut("log_design_decision", async ({ shortcut, ack, client }) => {
  await ack();

  const messageTs = shortcut.message_ts || shortcut.message?.ts;
  const channelId = shortcut.channel?.id;
  const triggerId = shortcut.trigger_id;

  // Fetch the thread if the message is part of one, otherwise just the message
  let messages = [];
  let appNotInChannel = false;
  try {
    if (shortcut.message?.thread_ts) {
      // It's in a thread, grab the whole thread
      const threadResult = await client.conversations.replies({
        channel: channelId,
        ts: shortcut.message.thread_ts,
        limit: 100,
      });
      messages = threadResult.messages || [];
    } else {
      // Single message, but check if it's a thread parent
      const threadResult = await client.conversations.replies({
        channel: channelId,
        ts: messageTs,
        limit: 100,
      });
      messages = threadResult.messages || [];
    }
  } catch (err) {
    console.error("Error fetching messages:", err);
    if (err.data?.error === 'channel_not_found' || err.data?.error === 'not_in_channel') {
      appNotInChannel = true;
    }
    // Fall back to just the clicked message
    messages = [shortcut.message];
  }

  // Format messages into readable text
  const formattedMessages = await formatMessages(messages, client);
  const initiatedBy = await resolveUserName(shortcut.user.id, client);

  // Store session
  const sessionId = triggerId;
  sessions.set(sessionId, {
    channelId,
    userId: shortcut.user.id,
    initiatedBy,
    sourceMessageTs: messageTs,
    threadTs: shortcut.message?.thread_ts || messageTs,
    sourceMessages: formattedMessages,
    additionalContext: [],
    pendingLinkInputs: [],
    clarifyingQuestions: [],
    selectedModel: DEFAULT_MODEL,
    createdAt: Date.now(),
    appNotInChannel,
  });

  // Open modal asking if they want to add more context
  await client.views.open({
    trigger_id: triggerId,
    view: buildGatherContextModal(
      sessionId,
      formattedMessages,
      [],
      DEFAULT_MODEL,
      appNotInChannel
    ),
  });
});

// ─── Modal Submission: Gather More Context ──────────────────────
app.view("gather_context_submit", async ({ ack, body, view, client }) => {
  const sessionId = view.private_metadata;
  const session = sessions.get(sessionId);

  if (!session) {
    console.warn("[gather_context_submit] Missing session", { sessionId });
    await ack({
      response_action: "update",
      view: buildSessionExpiredModal(sessionId),
    });
    return;
  }

  const additionalLinks =
    view.state.values.additional_links?.links_input?.value || "";
  const additionalNotes =
    view.state.values.additional_notes?.notes_input?.value || "";
  const selectedModel =
    view.state.values.model_select?.model_choice?.selected_option?.value ||
    DEFAULT_MODEL;
  const gatherErrors = {};
  if (containsVideoReference(additionalLinks)) {
    gatherErrors.additional_links =
      "Video links/uploads are not supported in this form.";
  }
  if (containsVideoReference(additionalNotes)) {
    gatherErrors.additional_notes =
      "Video links/uploads are not supported in this form.";
  }
  if (Object.keys(gatherErrors).length > 0) {
    await ack({ response_action: "errors", errors: gatherErrors });
    return;
  }
  console.log("[gather_context_submit] Submit received", {
    sessionId,
    selectedModel,
    hasAdditionalLinks: Boolean(additionalLinks.trim()),
    hasAdditionalNotes: Boolean(additionalNotes.trim()),
  });
  session.selectedModel = selectedModel;

  if (additionalLinks.trim()) {
    // Queue links so we can ack quickly, then fetch in background.
    session.pendingLinkInputs.push(additionalLinks.trim());
  }

  if (additionalNotes.trim()) {
    session.additionalContext.push(`\n--- Additional Notes ---\n${additionalNotes}`);
  }

  // Continue directly to clarifying questions after one context entry pass.
  await ack({
    response_action: "update",
    view: buildClarifyingLoadingModal(sessionId, pickRandomThinkingWord()),
  });
  console.log("[gather_context_submit] Acked with loading modal", { sessionId });
  const loadingStartedAt = Date.now();

  const stopLoadingUpdates = startClarifyingLoadingUpdates(
    client,
    view.id,
    sessionId
  );

  try {
    // Fetch linked messages after ack to avoid Slack modal timeout.
    if (session.pendingLinkInputs.length > 0) {
      const allLinkInputs = [...session.pendingLinkInputs];
      session.pendingLinkInputs = [];
      for (const linkInput of allLinkInputs) {
        console.log("[gather_context_submit] Fetching linked messages", {
          sessionId,
          inputLength: linkInput.length,
        });
        const fetchedMessages = await withTimeout(
          fetchLinkedMessages(linkInput, client),
          15000,
          "linked message fetch timed out"
        );
        session.additionalContext.push(...fetchedMessages);
      }
    }

    console.log("[gather_context_submit] Generating clarifying questions", {
      sessionId,
      contextItems: session.additionalContext.length,
    });
    const questions = await withTimeout(
      generateClarifyingQuestions(session),
      25000,
      "clarifying question generation timed out"
    );
    session.clarifyingQuestions = questions;
    console.log("[gather_context_submit] Clarifying questions generated", {
      sessionId,
      count: questions.length,
    });

    await ensureMinimumElapsed(loadingStartedAt, 3000);
    await client.views.update({
      view_id: view.id,
      view: buildClarifyingQuestionsModal(
        sessionId,
        session.sourceMessages,
        questions,
        session.additionalContext
      ),
    });
    console.log("[gather_context_submit] Updated to clarifying modal", {
      sessionId,
    });
    stopLoadingUpdates();
  } catch (err) {
    console.error("[gather_context_submit] Clarifying flow error:", err);
    const fallbackQuestions = [
      "What exact problem are we trying to solve?",
      "What decision should be documented as the outcome?",
      "What are the key tradeoffs or risks?",
      "What alternatives were considered and why not chosen?",
      "Any more Slack links/context/content to include before finalizing?",
    ];
    session.clarifyingQuestions = fallbackQuestions;

    try {
      await ensureMinimumElapsed(loadingStartedAt, 3000);
      await client.views.update({
        view_id: view.id,
        view: buildClarifyingQuestionsModal(
          sessionId,
          session.sourceMessages,
          fallbackQuestions,
          session.additionalContext
        ),
      });
      stopLoadingUpdates();
      await safePostEphemeralOrDM(
        client,
        session.channelId,
        session.userId,
        ":warning: Clarifying question generation was slow, so I used fallback questions. You can continue."
      );
    } catch (updateErr) {
      console.error(
        "[gather_context_submit] Fallback clarifying modal update error:",
        updateErr
      );
      stopLoadingUpdates();
      await safePostEphemeralOrDM(
        client,
        session.channelId,
        session.userId,
        ":x: I hit a timeout preparing clarifying questions. Please retry the shortcut."
      );
      sessions.delete(sessionId);
    }
  }
});

// ─── Modal Submission: Clarifying Q&A + Synthesize ──────────────
app.view("clarifying_submit", async ({ ack, view, client }) => {
  const sessionId = view.private_metadata;
  const session = sessions.get(sessionId);

  if (!session) {
    console.warn("[clarifying_submit] Missing session", { sessionId });
    await ack({
      response_action: "update",
      view: buildSessionExpiredModal(sessionId),
    });
    return;
  }

  const questions = session.clarifyingQuestions || [];
  const clarifyingErrors = {};
  const qaLines = [];

  questions.forEach((question, index) => {
    const blockId = `clarifying_q_${index}`;
    const answer =
      view.state.values?.[blockId]?.answer_input?.value?.trim() || "";

    if (containsVideoReference(answer)) {
      clarifyingErrors[blockId] =
        "Video links/uploads are not supported in this form.";
    }

    if (answer) {
      qaLines.push(`- Q: ${question}\n  A: ${answer}`);
    }
  });

  if (Object.keys(clarifyingErrors).length > 0) {
    await ack({ response_action: "errors", errors: clarifyingErrors });
    return;
  }

  if (qaLines.length > 0) {
    session.additionalContext.push(
      `\n--- Clarifying Questions Asked & Answers ---\n${qaLines.join("\n\n")}`
    );
  }

  await ack();

  await safePostEphemeralOrDM(
    client,
    session.channelId,
    session.userId,
    ":hourglass_flowing_sand: Creating DDR locally..."
  );

  try {
    const markdown = await synthesizeDecision(session);

    mkdirSync(DATA_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `design-decision-${timestamp}.md`;
    const filepath = join(DATA_DIR, filename);
    writeFileSync(filepath, markdown);

    const baseText = `a ddr was created from this message (model: ${session.selectedModel || DEFAULT_MODEL})`;
    const downloadUrl = process.env.PUBLIC_URL
      ? `${process.env.PUBLIC_URL.replace(/\/$/, "")}/download/${filename}`
      : null;
    const designDecisionRecordsUrl =
      "https://coda.io/d/Design-system_d_JJUOCLqA5/Design-Decision-Records-DDRs_su5gqDzd#Decisions_tuMiWlSr";
    const designDecisionRecordsLink = `<${designDecisionRecordsUrl}| 🔗 Go to Design Decision Records>`;
    const channelText = downloadUrl
      ? `${baseText}\n<${downloadUrl}| 💾 Download .md file>\n${designDecisionRecordsLink}`
      : `${baseText}\n${designDecisionRecordsLink}`;

    try {
      const postPayload = {
        channel: session.channelId,
        text: channelText,
      };
      if (session.threadTs) {
        postPayload.thread_ts = session.threadTs;
      }
      await client.chat.postMessage(postPayload);
    } catch (postErr) {
      console.warn("Could not post to channel, falling back to DM", postErr.message);
      const dmText = downloadUrl
        ? `Your DDR was created, but I couldn't post in the channel. <${downloadUrl}|💾 Download .md file>\n${designDecisionRecordsLink}`
        : `Your DDR was created and saved, but I couldn't post the confirmation in the original channel because I haven't been added to it.\n${designDecisionRecordsLink}`;
      await client.chat.postMessage({
        channel: session.userId,
        text: dmText,
      });
    }
  } catch (err) {
    console.error("Synthesis error:", err);
    await safePostEphemeralOrDM(
      client,
      session.channelId,
      session.userId,
      `:x: Something went wrong generating the design decision: ${err.message}`
    );
  }

  // Clean up session
  sessions.delete(sessionId);
});

async function safePostEphemeralOrDM(client, channelId, userId, text) {
  try {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text,
    });
  } catch (err) {
    // If we can't post ephemeral (e.g. not in channel), try DMing the user
    try {
      await client.chat.postMessage({
        channel: userId,
        text,
      });
    } catch (dmErr) {
      console.warn("Could not post ephemeral or DM fallback:", dmErr.message);
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────

async function formatMessages(messages, client) {
  // Resolve user IDs to names for readability
  const userCache = new Map();

  const formatted = [];
  for (const msg of messages) {
    let userName = msg.user || "Unknown";
    if (msg.user && !userCache.has(msg.user)) {
      try {
        const userInfo = await client.users.info({ user: msg.user });
        userCache.set(
          msg.user,
          userInfo.user.real_name || userInfo.user.name
        );
      } catch {
        userCache.set(msg.user, msg.user);
      }
    }
    userName = userCache.get(msg.user) || userName;

    const time = new Date(parseFloat(msg.ts) * 1000).toLocaleString();
    formatted.push(`[${time}] ${userName}: ${msg.text}`);
  }

  return formatted.join("\n");
}

async function fetchLinkedMessages(linksText, client) {
  // Parse Slack message links like:
  // https://workspace.slack.com/archives/C01234/p1234567890123456
  const linkPattern =
    /https:\/\/[^/]+\/archives\/([A-Z0-9]+)\/p(\d+)/g;
  const results = [];

  let match;
  while ((match = linkPattern.exec(linksText)) !== null) {
    const channelId = match[1];
    // Slack encodes ts as digits without the dot; insert it back
    const rawTs = match[2];
    const ts = rawTs.slice(0, 10) + "." + rawTs.slice(10);

    try {
      // Try to get the thread
      const threadResult = await withTimeout(
        client.conversations.replies({
          channel: channelId,
          ts: ts,
          limit: 50,
        }),
        10000,
        `fetch thread timeout (${channelId} ${ts})`
      );

      if (threadResult.messages?.length) {
        const formatted = await formatMessages(threadResult.messages, client);
        results.push(`\n--- Linked Thread ---\n${formatted}`);
      }
    } catch (err) {
      console.error(`Could not fetch linked message: ${err.message}`);
      results.push(
        `\n--- Could not fetch linked message (channel: ${channelId}, ts: ${ts}) ---`
      );
    }
  }

  return results;
}

async function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function ensureMinimumElapsed(startedAtMs, minimumMs) {
  const elapsed = Date.now() - startedAtMs;
  if (elapsed < minimumMs) {
    await sleep(minimumMs - elapsed);
  }
}

function pickRandomThinkingWord() {
  return THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];
}

function startClarifyingLoadingUpdates(client, viewId, sessionId) {
  let stopped = false;

  (async () => {
    while (!stopped) {
      await sleep(10000);
      if (stopped) {
        break;
      }

      try {
        await client.views.update({
          view_id: viewId,
          view: buildClarifyingLoadingModal(sessionId, pickRandomThinkingWord()),
        });
      } catch (err) {
        // If the modal is already closed/replaced, stop the updater quietly.
        stopped = true;
      }
    }
  })();

  return () => {
    stopped = true;
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function containsVideoReference(text = "") {
  if (!text) {
    return false;
  }

  const videoPattern =
    /(\.(mp4|mov|avi|mkv|webm|m4v|wmv|flv)(\?|$))|(files\.slack\.com)/i;
  return videoPattern.test(text);
}

async function synthesizeDecision(session) {
  const dateProposed = new Date().toLocaleDateString("en-US");
  const sourceLabel = session.sourceMessageTs ? "--- Original Thread/Message ---" : "--- User-Provided Context ---";
  const allContext = [
    sourceLabel,
    session.sourceMessages,
    `--- Decision Metadata Defaults ---\nAuthor: ${
      session.initiatedBy || session.userId
    }\nStatus: Proposed\nDate proposed: ${dateProposed}\nDate approved: (leave blank by default)`,
    ...session.additionalContext,
  ].join("\n\n");

  const response = await anthropic.messages.create({
    model: session.selectedModel || DEFAULT_MODEL,
    max_tokens: 4000,
    system: `You are a design decision documentation assistant. Your job is to take raw Slack conversations and context about a design decision and synthesize them into a structured design decision log.

Analyze the conversation carefully to understand:
- What problem is being discussed
- What decision was made (or is being proposed)
- What tradeoffs were considered
- What alternatives came up

Write in a clear, professional tone. Be thorough but concise. Use the context provided to fill in as much as you can, and note where information is unclear or missing.

Output the decision log in this exact markdown format:

# Design Decision: [Short Title]

**Author:** [who initiated this app flow]
**Status:** Proposed
**Date proposed:** [today's date]
**Date approved:**

## Problem

[What problem this decision is trying to solve]

## Decision

[The decision that was made or is proposed. Be as thorough as necessary.]

## Consequences

### Positive
[Benefits of this decision]

### Negative / Tradeoffs
[Downsides or tradeoffs]

### Neutral
[Side effects that are neither clearly positive nor negative]

## Alternatives Considered

| Alternative | Why Not Chosen |
|---|---|
| [Alternative 1] | [Reason] |
| [Alternative 2] | [Reason] |

## Additional Context

[Any relevant links, references, or notes]`,
    messages: [
      {
        role: "user",
        content: `Here is the Slack conversation and additional context. Please synthesize this into a design decision log.\n\n${allContext}`,
      },
    ],
  });

  return applyDecisionHeaderDefaults(response.content[0].text, {
    author: session.initiatedBy || session.userId || "Unknown",
    dateProposed,
  });
}

function applyDecisionHeaderDefaults(markdown, metadata) {
  const lines = String(markdown || "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const titleIndex = lines.findIndex((line) =>
    line.trim().startsWith("# Design Decision:")
  );
  const sectionIndex = lines.findIndex(
    (line, index) => index > (titleIndex >= 0 ? titleIndex : 0) && line.trim().startsWith("## ")
  );

  const title =
    titleIndex >= 0 ? lines[titleIndex].trim() : "# Design Decision: Untitled";
  const sections = sectionIndex >= 0 ? lines.slice(sectionIndex) : [];

  return [
    title,
    "",
    `**Author:** ${metadata.author}`,
    "**Status:** Proposed",
    `**Date proposed:** ${metadata.dateProposed}`,
    "**Date approved:**",
    "",
    ...sections,
  ]
    .join("\n")
    .trimEnd();
}

async function resolveUserName(userId, client) {
  try {
    const userInfo = await client.users.info({ user: userId });
    return (
      userInfo?.user?.real_name ||
      userInfo?.user?.profile?.display_name ||
      userInfo?.user?.name ||
      userId
    );
  } catch (err) {
    console.warn("[resolveUserName] Unable to resolve user", { userId });
    return userId;
  }
}

async function generateClarifyingQuestions(session) {
  const sourceLabel = session.sourceMessageTs ? "--- Original Thread/Message ---" : "--- User-Provided Context ---";
  const context = [
    sourceLabel,
    session.sourceMessages,
    ...session.additionalContext,
  ].join("\n\n");

  const response = await anthropic.messages.create({
    model: session.selectedModel || DEFAULT_MODEL,
    max_tokens: 500,
    system: `You are helping prepare a design decision record from Slack context.

Before drafting the DDR, ask concise clarifying questions to fill any missing information.
Focus on these sections:
- Problem
- Decision
- Consequences (positive, negative/tradeoff, neutral)
- Alternatives considered

Also ask if any additional Slack links/context/content should be included.

Return ONLY a bullet list of 3-6 short questions, one question per line, each starting with "- ".`,
    messages: [
      {
        role: "user",
        content: `Generate clarifying questions based on this context:\n\n${context}`,
      },
    ],
  });

  const raw = response.content[0]?.text || "";
  const parsed = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.replace(/^- /, "").trim())
    .filter(Boolean)
    .slice(0, 6);

  if (parsed.length >= 1) {
    return parsed;
  }

  return [
    "What exact problem are we trying to solve?",
    "What decision do you want documented as the primary outcome?",
    "What are the key tradeoffs or risks?",
    "What alternatives were considered and why were they not chosen?",
    "Is there any other Slack link/context/content we should include?",
  ];
}

function buildDdrChooserModal(sessionId, metadata) {
  return {
    type: "modal",
    callback_id: "ddr_chooser_submit",
    private_metadata: JSON.stringify(metadata),
    title: {
      type: "plain_text",
      text: "Log Design Decision",
    },
    submit: {
      type: "plain_text",
      text: "Next",
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    blocks: [
      {
        type: "input",
        block_id: "chooser",
        element: {
          type: "radio_buttons",
          action_id: "mode",
          initial_option: {
            text: {
              type: "plain_text",
              text: "Start from scratch",
            },
            value: "from_scratch",
          },
          options: [
            {
              text: {
                type: "plain_text",
                text: "Start from scratch",
              },
              value: "from_scratch",
            },
            {
              text: {
                type: "plain_text",
                text: "From a Slack message",
              },
              value: "from_message",
            },
          ],
        },
        label: {
          type: "plain_text",
          text: "How would you like to start?",
        },
      },
    ],
  };
}

function buildFromScratchModal(sessionId, selectedModel = DEFAULT_MODEL) {
  return {
    type: "modal",
    callback_id: "scratch_prompt_submit",
    private_metadata: sessionId,
    title: {
      type: "plain_text",
      text: "Design Decision Log",
    },
    submit: {
      type: "plain_text",
      text: "Submit",
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    blocks: [
      {
        type: "input",
        block_id: "scratch_prompt",
        element: {
          type: "plain_text_input",
          action_id: "prompt_input",
          multiline: true,
          placeholder: {
            type: "plain_text",
            text: "Describe the design decision, problem, and context...",
          },
        },
        label: {
          type: "plain_text",
          text: "Decision Details",
        },
      },
      {
        type: "input",
        block_id: "model_select",
        element: {
          type: "external_select",
          action_id: "model_choice",
          min_query_length: 0,
          placeholder: {
            type: "plain_text",
            text: "Choose a Claude model",
          },
          initial_option: buildModelOption(selectedModel),
        },
        label: {
          type: "plain_text",
          text: "Claude Model",
        },
      },
    ],
  };
}

function buildGatherContextModal(
  sessionId,
  sourceMessages,
  additionalContext = [],
  selectedModel = DEFAULT_MODEL,
  appNotInChannel = false
) {
  const contextPreview =
    typeof sourceMessages === "string"
      ? sourceMessages.substring(0, 500)
      : String(sourceMessages).substring(0, 500);

  const additionalPreview =
    additionalContext.length > 0
      ? `\n\n_Plus ${additionalContext.length} additional context item(s) already added._`
      : "";

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:clipboard: *Captured conversation preview:*\n\`\`\`${contextPreview}...\`\`\`${additionalPreview}`,
      },
    },
    {
      type: "divider",
    },
    {
      type: "input",
      block_id: "model_select",
      element: {
        type: "external_select",
        action_id: "model_choice",
        min_query_length: 0,
        placeholder: {
          type: "plain_text",
          text: "Choose a Claude model",
        },
        initial_option: buildModelOption(selectedModel),
      },
      label: {
        type: "plain_text",
        text: "Claude Model",
      },
    },
    {
      type: "input",
      block_id: "additional_links",
      optional: true,
      element: {
        type: "plain_text_input",
        action_id: "links_input",
        multiline: true,
        placeholder: {
          type: "plain_text",
          text: "Paste Slack message links here (one per line)",
        },
      },
      label: {
        type: "plain_text",
        text: "Additional Slack Message Links",
      },
    },
    {
      type: "input",
      block_id: "additional_notes",
      optional: true,
      element: {
        type: "plain_text_input",
        action_id: "notes_input",
        multiline: true,
        placeholder: {
          type: "plain_text",
          text: "Any extra context, decisions, or reasoning not in the thread...",
        },
      },
      label: {
        type: "plain_text",
        text: "Additional Notes / Context",
      },
    },
  ];

  if (appNotInChannel) {
    blocks.unshift(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "⚠️ *Note: The app is not in this channel/DM.* It can only see the single message you clicked, not the full thread. It also won't be able to post a confirmation here. To fix this, add the app to the conversation.",
        },
      },
      {
        type: "divider",
      }
    );
  }

  return {
    type: "modal",
    callback_id: "gather_context_submit",
    private_metadata: sessionId,
    title: {
      type: "plain_text",
      text: "Design Decision Log",
    },
    submit: {
      type: "plain_text",
      text: "Submit",
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    blocks,
  };
}

function buildModelOption(modelId, fallbackLabel = false) {
  const label = fallbackLabel
    ? `${modelId} (fallback)`
    : prettifyModelLabel(modelId);

  return {
    text: {
      type: "plain_text",
      text: label.slice(0, 75),
    },
    value: modelId,
  };
}

function prettifyModelLabel(modelId) {
  if (!modelId) {
    return DEFAULT_MODEL;
  }

  const pretty = modelId
    .replace(/^claude-/, "")
    .replace(/-/g, " ")
    .trim();
  return `Claude ${pretty}`.slice(0, 75);
}

async function getModelOptions() {
  const now = Date.now();
  if (
    modelOptionsCache.options.length > 0 &&
    now - modelOptionsCache.fetchedAt < MODEL_CACHE_TTL_MS
  ) {
    return modelOptionsCache.options;
  }

  const fetchedModelIds = [];
  for await (const model of anthropic.models.list({ limit: 100 })) {
    if (!model?.id) {
      continue;
    }
    // Slack restricts option values to 75 chars.
    if (model.id.length <= 75) {
      fetchedModelIds.push(model.id);
    }
    if (fetchedModelIds.length >= 100) {
      break;
    }
  }

  const uniqueModelIds = [...new Set(fetchedModelIds)];
  uniqueModelIds.sort((a, b) => b.localeCompare(a));

  const options = uniqueModelIds.map((modelId) => buildModelOption(modelId));
  if (!options.some((option) => option.value === DEFAULT_MODEL)) {
    options.unshift(buildModelOption(DEFAULT_MODEL, true));
  }

  modelOptionsCache = {
    fetchedAt: now,
    options,
  };

  return options;
}

function buildClarifyingLoadingModal(sessionId, progressWord = "thinking") {
  return {
    type: "modal",
    callback_id: "clarifying_loading",
    private_metadata: sessionId,
    title: {
      type: "plain_text",
      text: "Preparing Questions",
    },
    close: {
      type: "plain_text",
      text: "Close",
    },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:hourglass_flowing_sand: ${progressWord}...\n_Generating clarifying questions. This usually takes under 30 seconds._`,
        },
      },
    ],
  };
}

function buildSessionExpiredModal(sessionId) {
  return {
    type: "modal",
    callback_id: "session_expired",
    private_metadata: sessionId,
    title: {
      type: "plain_text",
      text: "Session Expired",
    },
    close: {
      type: "plain_text",
      text: "Close",
    },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            ":warning: This DDR session expired (usually after an app restart).\nPlease run the shortcut again from the message.",
        },
      },
    ],
  };
}

function buildClarifyingQuestionsModal(
  sessionId,
  sourceMessages,
  clarifyingQuestions = [],
  additionalContext = []
) {
  const contextPreview =
    typeof sourceMessages === "string"
      ? sourceMessages.substring(0, 350)
      : String(sourceMessages).substring(0, 350);

  const additionalPreview =
    additionalContext.length > 0
      ? `\n\n_Plus ${additionalContext.length} additional context item(s) already added._`
      : "";

  const questionsToRender =
    clarifyingQuestions.length > 0
      ? clarifyingQuestions
      : [
          "What exact problem are we trying to solve?",
          "What decision should be documented as the outcome?",
          "What are the key tradeoffs or risks?",
        ];

  const questionBlocks = questionsToRender.map((question, index) => ({
    type: "input",
    block_id: `clarifying_q_${index}`,
    optional: true,
    element: {
      type: "plain_text_input",
      action_id: "answer_input",
      multiline: true,
      placeholder: {
        type: "plain_text",
        text: "Type your answer (text only; no video links/uploads).",
      },
    },
    label: {
      type: "plain_text",
      text: `${index + 1}. ${question}`.slice(0, 200),
    },
  }));

  return {
    type: "modal",
    callback_id: "clarifying_submit",
    private_metadata: sessionId,
    title: {
      type: "plain_text",
      text: "Clarify Before DDR",
    },
    submit: {
      type: "plain_text",
      text: "Create DDR",
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:clipboard: *Conversation preview:*\n\`\`\`${contextPreview}...\`\`\`${additionalPreview}`,
        },
      },
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            "*Please answer each clarifying question below before I generate the DDR.*\n_Text only in this UI (no video uploads/links)._",
        },
      },
      ...questionBlocks,
    ],
  };
}

// ─── Start ──────────────────────────────────────────────────────
const httpPort = Number(process.env.PORT) || 3000;
const boltPort = 3001;

(async () => {
  try {
    downloadApp.listen(httpPort, () => {
      console.log(`📥 Download server listening on port ${httpPort}`);
    });
    await app.start(boltPort);
    console.log("⚡ Design Decision Logger is running");
    console.log(`   Socket Mode (Bolt) on port ${boltPort}, downloads on port ${httpPort}`);
  } catch (err) {
    console.error("[startup] Failed to start app:", err);
  }
})();
