import Bolt from "@slack/bolt";
import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { config } from "dotenv";

config();

const { App } = Bolt;

// Directory for generated DDR files (./data; on Railway mount volume to /app/data).
const DATA_DIR = join(process.cwd(), "data");
const JOBS_DIR = join(DATA_DIR, "jobs");
const JOB_PROGRESS = {
  context: { percent: 10, label: "Assembling context" },
  calling_model: { percent: 35, label: "Calling model" },
  model_done: { percent: 75, label: "Model response received" },
  writing_file: { percent: 90, label: "Writing markdown file" },
  posting_result: { percent: 100, label: "Posting results" },
};

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
const CODA_API_BASE = "https://coda.io/apis/v1";
const DEFAULT_DESIGN_DECISION_RECORDS_URL =
  "https://coda.io/d/Design-system_d_JJUOCLqA5/Design-Decision-Records-DDRs_su5gqDzd#Decisions_tuMiWlSr";
const CODA_FEATURE_ENABLED = Boolean(process.env.CODA_API_TOKEN);
const CODA_DEFAULT_STATUS = process.env.CODA_DEFAULT_STATUS || "Under Review";
const CODA_COLUMN_ALIASES = {
  Title: ["Title", "Name"],
  "Date Proposed": ["Date Proposed", "Date proposed", "Date Created", "Date created"],
};
let modelOptionsCache = {
  fetchedAt: 0,
  options: [],
};
const codaColumnsCache = new Map();

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
  const metadata = {
    channelId,
    userId: command.user_id,
    initiatedBy,
    sessionId,
    origin: "slash",
  };

  await client.views.open({
    trigger_id: triggerId,
    view: buildDdrChooserModal(sessionId, metadata),
  });
});

app.command("/ddr-jobs", async ({ command, ack, client }) => {
  await ack();

  const query = parseDdrJobsQuery(command.text);
  const jobs = loadAllJobs()
    .filter((job) => {
      if (query.jobId && job.id !== query.jobId) {
        return false;
      }
      if (query.status && job.status !== query.status) {
        return false;
      }
      if (query.scope !== "all" && job?.session?.userId !== command.user_id) {
        return false;
      }
      return true;
    })
    .slice(0, query.limit);

  const payload = buildDdrJobsPayload(jobs, { query });

  try {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      ...payload,
    });
  } catch (err) {
    await client.chat.postMessage({
      channel: command.user_id,
      ...payload,
    });
  }
});

// ─── Modal Submission: Chooser ────────────────────────────────
app.view("ddr_chooser_submit", async ({ ack, view, client }) => {
  const metadata = JSON.parse(view.private_metadata);
  const mode = view.state.values.chooser.mode.selected_option.value;
  const publishToCoda = getPublishToCodaValue(view.state.values);
  const ddrTitle = (view.state.values.ddr_title?.title_input?.value || "").trim();
  if (publishToCoda && !ddrTitle) {
    await ack({
      response_action: "errors",
      errors: {
        ddr_title: "DDR Title is required when Publish to Coda is checked.",
      },
    });
    return;
  }

  const { channelId, userId, initiatedBy, sessionId, origin = "slash" } = metadata;

  sessions.set(sessionId, {
    channelId,
    userId,
    initiatedBy,
    origin,
    sourceMessageTs: null,
    threadTs: undefined,
    sourceMessages: "",
    additionalContext: [],
    pendingLinkInputs: [],
    clarifyingQuestions: [],
    selectedModel: DEFAULT_MODEL,
    publishToCoda,
    ddrTitle,
    codaRowUrl: null,
    codaError: null,
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
        false,
        session.publishToCoda,
        session.ddrTitle
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
    origin: "shortcut",
    sourceMessageTs: messageTs,
    threadTs: shortcut.message?.thread_ts || messageTs,
    sourceMessages: formattedMessages,
    additionalContext: [],
    pendingLinkInputs: [],
    clarifyingQuestions: [],
    selectedModel: DEFAULT_MODEL,
    publishToCoda: false,
    ddrTitle: "",
    codaRowUrl: null,
    codaError: null,
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
      appNotInChannel,
      false,
      ""
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
  const publishToCoda = getPublishToCodaValue(view.state.values);
  const ddrTitle = (view.state.values.ddr_title?.title_input?.value || "").trim();
  const gatherErrors = {};
  if (containsVideoReference(additionalLinks)) {
    gatherErrors.additional_links =
      "Video links/uploads are not supported in this form.";
  }
  if (containsVideoReference(additionalNotes)) {
    gatherErrors.additional_notes =
      "Video links/uploads are not supported in this form.";
  }
  if (publishToCoda && !ddrTitle) {
    gatherErrors.ddr_title = "DDR Title is required when Publish to Coda is checked.";
  }
  if (Object.keys(gatherErrors).length > 0) {
    await ack({ response_action: "errors", errors: gatherErrors });
    return;
  }
  console.log("[gather_context_submit] Submit received", {
    sessionId,
    selectedModel,
    publishToCoda,
    hasDdrTitle: Boolean(ddrTitle),
    hasAdditionalLinks: Boolean(additionalLinks.trim()),
    hasAdditionalNotes: Boolean(additionalNotes.trim()),
  });
  session.selectedModel = selectedModel;
  session.publishToCoda = publishToCoda;
  session.ddrTitle = ddrTitle;

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

  const job = createDdrJob(session, sessionId);
  await persistJob(job);

  try {
    const progressRef = await postProgressMessage(client, job);
    if (progressRef) {
      job.progressChannel = progressRef.channel;
      job.progressTs = progressRef.ts;
      await persistJob(job);
    }
  } catch (err) {
    console.warn("[clarifying_submit] Unable to post initial progress", err.message);
  }

  try {
    await executeDdrJob(job, client);
  } finally {
    // Session data is now persisted in the job and no longer needs to stay in-memory.
    sessions.delete(sessionId);
  }
});

app.action("resume_ddr_job", async ({ ack, body, action, client }) => {
  await ack();

  const jobId = action?.value;
  if (!jobId) {
    return;
  }

  const job = loadJob(jobId);
  if (!job) {
    await safePostEphemeralOrDM(
      client,
      body.channel?.id,
      body.user.id,
      ":warning: I couldn't find that DDR recovery job anymore."
    );
    return;
  }

  if (job.status === "in_progress") {
    await safePostEphemeralOrDM(
      client,
      body.channel?.id || job.session?.channelId,
      body.user.id,
      `:hourglass_flowing_sand: Job \`${job.id}\` is already running.`
    );
    return;
  }

  if (!job.session) {
    await safePostEphemeralOrDM(
      client,
      body.channel?.id || job.session?.channelId,
      body.user.id,
      `:x: Job \`${job.id}\` is missing recovery context and cannot be resumed.`
    );
    return;
  }

  job.status = "in_progress";
  job.updatedAt = Date.now();
  job.lastError = null;
  await persistJob(job);

  await executeDdrJob(job, client, { resumedBy: body.user.id });
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

function parseDdrJobsQuery(text = "") {
  const tokens = String(text)
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const query = {
    scope: "mine",
    status: null,
    jobId: null,
    limit: 8,
  };

  for (const token of tokens) {
    const tokenLower = token.toLowerCase();
    if (tokenLower === "all") {
      query.scope = "all";
      continue;
    }
    if (tokenLower === "mine") {
      query.scope = "mine";
      continue;
    }
    if (["failed", "completed", "in_progress"].includes(tokenLower)) {
      query.status = tokenLower;
      continue;
    }
    if (tokenLower.startsWith("ddr-")) {
      query.jobId = token;
      continue;
    }
    if (/^\d+$/.test(token)) {
      query.limit = Math.max(1, Math.min(20, Number(token)));
    }
  }

  return query;
}

function loadAllJobs() {
  if (!existsSync(JOBS_DIR)) {
    return [];
  }

  const files = readdirSync(JOBS_DIR)
    .filter((name) => name.endsWith(".json"))
    .slice(0, 500);

  const jobs = [];
  for (const filename of files) {
    try {
      const raw = readFileSync(join(JOBS_DIR, filename), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.id) {
        jobs.push(parsed);
      }
    } catch (err) {
      console.warn("[loadAllJobs] Could not parse job file", {
        filename,
        message: err.message,
      });
    }
  }

  return jobs.sort((a, b) => {
    const aTime = Number(a.updatedAt || a.createdAt || 0);
    const bTime = Number(b.updatedAt || b.createdAt || 0);
    return bTime - aTime;
  });
}

function buildDdrJobsPayload(jobs, context) {
  const { query } = context;
  const statusText = query.status ? `status=${query.status}` : "status=any";
  const scopeText = query.scope === "all" ? "scope=all" : "scope=mine";
  const titleText = `Showing ${jobs.length} job(s) (${scopeText}, ${statusText}, limit=${query.limit})`;

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*DDR Jobs*\n${titleText}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Usage: `/ddr-jobs`, `/ddr-jobs failed`, `/ddr-jobs all failed 15`, `/ddr-jobs ddr-<id>`",
        },
      ],
    },
    {
      type: "divider",
    },
  ];

  if (jobs.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_No matching jobs found._",
      },
    });
    return {
      text: `DDR Jobs: ${titleText}`,
      blocks,
    };
  }

  for (const job of jobs) {
    const stage = JOB_PROGRESS[job.stage]?.label || job.stage || "Unknown stage";
    const updatedAt = formatTimestamp(job.updatedAt || job.createdAt);
    const model = job?.session?.selectedModel || DEFAULT_MODEL;
    const filename = job.filename ? `\nFile: \`${job.filename}\`` : "";
    const downloadUrl = job.filename ? getJobDownloadUrl(job.filename) : null;
    const downloadLine = downloadUrl ? `\nDownload: <${downloadUrl}|open file>` : "";
    const errorLine = job.lastError?.code
      ? `\nError: \`${job.lastError.code}\``
      : "";

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${job.id}* - \`${job.status}\`\nStage: ${stage}\nUpdated: ${updatedAt}\nModel: \`${model}\`${filename}${downloadLine}${errorLine}`,
      },
    });

    if (job.status === "failed") {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "resume_ddr_job",
            text: {
              type: "plain_text",
              text: "Resume DDR generation",
            },
            style: "primary",
            value: job.id,
          },
        ],
      });
    }

    blocks.push({
      type: "divider",
    });
  }

  return {
    text: `DDR Jobs: ${titleText}`,
    blocks: blocks.slice(0, 50),
  };
}

function formatTimestamp(epochMs) {
  if (!epochMs) {
    return "unknown";
  }
  try {
    return new Date(epochMs).toLocaleString("en-US");
  } catch {
    return "unknown";
  }
}

function getJobFilePath(jobId) {
  return join(JOBS_DIR, `${jobId}.json`);
}

function getJobDownloadUrl(filename) {
  if (!process.env.PUBLIC_URL) {
    return null;
  }
  return `${process.env.PUBLIC_URL.replace(/\/$/, "")}/download/${filename}`;
}

function getDesignDecisionRecordsUrl() {
  const docId = process.env.CODA_DOC_ID;
  const tableId = process.env.CODA_TABLE_ID;
  if (docId && tableId) {
    return `https://coda.io/d/_d${docId}#_tu${tableId}`;
  }
  return DEFAULT_DESIGN_DECISION_RECORDS_URL;
}

function getPublishToCodaValue(viewStateValues) {
  const selectedOptions =
    viewStateValues.coda_publish?.publish_to_coda?.selected_options || [];
  return selectedOptions.some((option) => option?.value === "publish");
}

function parseDdrMarkdown(markdown, fallbackTitle = "") {
  const normalized = String(markdown || "").replace(/\r\n/g, "\n");
  const titleMatch = normalized.match(/^#\s+(.+)$/m);
  const markdownTitle = titleMatch
    ? titleMatch[1].replace(/^Design Decision:\s*/i, "").trim()
    : "";
  const title = markdownTitle || String(fallbackTitle || "").trim() || "Untitled DDR";

  const sectionHeadingPattern = /^##\s+(.+)$/gm;
  const sections = {};
  const headingMatches = [...normalized.matchAll(sectionHeadingPattern)];

  for (let i = 0; i < headingMatches.length; i += 1) {
    const current = headingMatches[i];
    const heading = current[1].trim().toLowerCase();
    const contentStart = current.index + current[0].length;
    const contentEnd =
      i + 1 < headingMatches.length ? headingMatches[i + 1].index : normalized.length;
    const content = normalized.slice(contentStart, contentEnd).trim();
    sections[heading] = content;
  }

  return {
    title,
    problem: sections.problem || "",
    decision: sections.decision || "",
    consequences: sections.consequences || "",
    alternativesConsidered: sections["alternatives considered"] || "",
    additionalContext: sections["additional context"] || "",
  };
}

function getCodaHeaders() {
  if (!process.env.CODA_API_TOKEN) {
    throw new Error("CODA_API_TOKEN is not set");
  }
  return {
    Authorization: `Bearer ${process.env.CODA_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function getCodaTablePath() {
  const docId = process.env.CODA_DOC_ID;
  const tableId = process.env.CODA_TABLE_ID;
  if (!docId || !tableId) {
    throw new Error("CODA_DOC_ID and CODA_TABLE_ID must be set to publish to Coda");
  }
  return {
    docId,
    tableId,
    tablePath: `docs/${encodeURIComponent(docId)}/tables/${encodeURIComponent(tableId)}`,
  };
}

async function getCodaColumnMap() {
  const { tablePath } = getCodaTablePath();
  const cacheKey = tablePath;
  if (codaColumnsCache.has(cacheKey)) {
    return codaColumnsCache.get(cacheKey);
  }

  const response = await fetch(`${CODA_API_BASE}/${tablePath}/columns`, {
    method: "GET",
    headers: getCodaHeaders(),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Coda columns lookup failed (${response.status}): ${body}`);
  }

  const payload = await response.json();
  const map = new Map();
  for (const column of payload.items || []) {
    if (!column?.name || !column?.id) {
      continue;
    }
    map.set(column.name.toLowerCase(), column.id);
  }
  codaColumnsCache.set(cacheKey, map);
  return map;
}

function getRequiredCodaColumnId(columnMap, columnName) {
  const candidateNames = CODA_COLUMN_ALIASES[columnName] || [columnName];
  const columnId = candidateNames
    .map((name) => columnMap.get(name.toLowerCase()))
    .find(Boolean);
  if (!columnId) {
    throw new Error(
      `Missing required Coda column: ${columnName} (accepted: ${candidateNames.join(", ")})`
    );
  }
  return columnId;
}

async function publishToCoda(session, parsedSections) {
  try {
    const columnMap = await getCodaColumnMap();
    const { docId, tableId, tablePath } = getCodaTablePath();
    const today = new Date().toLocaleDateString("en-US");
    const title = String(session.ddrTitle || parsedSections.title || "Untitled DDR").trim();

    const cells = [
      { column: getRequiredCodaColumnId(columnMap, "Title"), value: title },
      {
        column: getRequiredCodaColumnId(columnMap, "Author"),
        value: session.initiatedBy || session.userId || "Unknown",
      },
      { column: getRequiredCodaColumnId(columnMap, "Status"), value: CODA_DEFAULT_STATUS },
      { column: getRequiredCodaColumnId(columnMap, "Date Proposed"), value: today },
      { column: getRequiredCodaColumnId(columnMap, "Problem"), value: parsedSections.problem },
      { column: getRequiredCodaColumnId(columnMap, "Decision"), value: parsedSections.decision },
      {
        column: getRequiredCodaColumnId(columnMap, "Consequences"),
        value: parsedSections.consequences,
      },
      {
        column: getRequiredCodaColumnId(columnMap, "Alternatives Considered"),
        value: parsedSections.alternativesConsidered,
      },
      {
        column: getRequiredCodaColumnId(columnMap, "Additional Context"),
        value: parsedSections.additionalContext,
      },
    ];

    const insertResponse = await fetch(`${CODA_API_BASE}/${tablePath}/rows`, {
      method: "POST",
      headers: getCodaHeaders(),
      body: JSON.stringify({
        rows: [{ cells }],
      }),
    });
    if (!insertResponse.ok) {
      const body = await insertResponse.text();
      throw new Error(`Coda row insert failed (${insertResponse.status}): ${body}`);
    }

    const insertPayload = await insertResponse.json();
    const rowId = insertPayload?.addedRowIds?.[0];
    if (!rowId) {
      throw new Error("Coda row insert succeeded but no row ID was returned");
    }
    const fallbackRowUrl = `https://coda.io/d/_d${docId}/_su${tableId}#_ri${rowId}`;

    const rowResponse = await fetch(
      `${CODA_API_BASE}/${tablePath}/rows/${encodeURIComponent(rowId)}`,
      {
        method: "GET",
        headers: getCodaHeaders(),
      }
    );
    if (!rowResponse.ok) {
      return {
        success: true,
        rowUrl: fallbackRowUrl,
        error: null,
      };
    }
    const rowPayload = await rowResponse.json();
    return {
      success: true,
      rowUrl: rowPayload?.browserLink || fallbackRowUrl,
      error: null,
    };
  } catch (err) {
    console.error("[publishToCoda] Publish failed:", err);
    return {
      success: false,
      rowUrl: null,
      error: err?.message || String(err),
    };
  }
}

function createDdrJob(session, sessionId) {
  return {
    id: `ddr-${randomUUID()}`,
    status: "in_progress",
    stage: "context",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sessionId,
    session: JSON.parse(JSON.stringify(session)),
    progressChannel: null,
    progressTs: null,
    filename: null,
    lastError: null,
  };
}

function loadJob(jobId) {
  try {
    const filepath = getJobFilePath(jobId);
    if (!existsSync(filepath)) {
      return null;
    }
    return JSON.parse(readFileSync(filepath, "utf8"));
  } catch (err) {
    console.warn("[loadJob] Failed to load job", { jobId, message: err.message });
    return null;
  }
}

async function persistJob(job) {
  mkdirSync(JOBS_DIR, { recursive: true });
  job.updatedAt = Date.now();
  writeFileSync(getJobFilePath(job.id), JSON.stringify(job, null, 2), "utf8");
}

function renderAsciiProgressBar(percent, width = 20) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((safePercent / 100) * width);
  const empty = width - filled;
  return `[${"=".repeat(filled)}${" ".repeat(empty)}] ${safePercent}%`;
}

function buildProgressText(job, stageKey, extra = "") {
  const stage = JOB_PROGRESS[stageKey] || { percent: 0, label: "Working" };
  const base = [
    ":hourglass_flowing_sand: Creating DDR locally...",
    `\`${renderAsciiProgressBar(stage.percent)}\``,
    `Stage: ${stage.label}`,
    `Job ID: \`${job.id}\``,
  ];
  if (extra) {
    base.push(extra);
  }
  return base.join("\n");
}

async function postProgressMessage(client, job) {
  const session = job.session || {};
  const text = buildProgressText(job, "context", "_You can keep working; I'll update this message._");

  try {
    if (session.origin === "slash") {
      const result = await client.chat.postMessage({
        channel: session.userId,
        text,
      });
      return { channel: result.channel, ts: result.ts };
    }

    const payload = {
      channel: session.channelId,
      text,
    };
    if (session.threadTs) {
      payload.thread_ts = session.threadTs;
    }
    const result = await client.chat.postMessage(payload);
    return { channel: result.channel, ts: result.ts };
  } catch (err) {
    console.warn("[postProgressMessage] Channel/thread post failed, falling back to DM", err.message);
    const dm = await client.chat.postMessage({
      channel: session.userId,
      text,
    });
    return { channel: dm.channel, ts: dm.ts };
  }
}

async function updateProgressMessage(client, job, stageKey, extra = "") {
  job.stage = stageKey;
  await persistJob(job);

  if (!job.progressChannel || !job.progressTs) {
    return;
  }

  try {
    await client.chat.update({
      channel: job.progressChannel,
      ts: job.progressTs,
      text: buildProgressText(job, stageKey, extra),
    });
  } catch (err) {
    console.warn("[updateProgressMessage] Unable to update progress message", err.message);
  }
}

function classifySynthesisError(err) {
  const status = err?.status || err?.statusCode || err?.response?.status || 0;
  const raw = String(
    err?.message ||
      err?.error?.message ||
      err?.response?.data?.error?.message ||
      ""
  ).toLowerCase();

  if (
    status === 429 ||
    raw.includes("rate limit") ||
    raw.includes("too many requests")
  ) {
    return {
      code: "rate_limited",
      retryable: true,
      userMessage:
        "Anthropic rate-limited this request. Please wait a minute, then click *Resume DDR generation*.",
    };
  }

  if (
    raw.includes("insufficient_quota") ||
    raw.includes("credit") ||
    raw.includes("billing") ||
    raw.includes("quota") ||
    raw.includes("usage limit")
  ) {
    return {
      code: "budget_exhausted",
      retryable: false,
      userMessage:
        "API usage/billing appears exhausted. After restoring budget, click *Resume DDR generation* to continue.",
    };
  }

  if (
    status === 401 ||
    status === 403 ||
    raw.includes("api key") ||
    raw.includes("authentication")
  ) {
    return {
      code: "auth_error",
      retryable: false,
      userMessage:
        "Authentication with the model API failed (likely API key/config). Fix credentials, then click *Resume DDR generation*.",
    };
  }

  if (
    status >= 500 ||
    raw.includes("overloaded") ||
    raw.includes("temporarily unavailable") ||
    raw.includes("timeout") ||
    raw.includes("timed out") ||
    raw.includes("econnreset") ||
    raw.includes("enotfound") ||
    raw.includes("fetch failed")
  ) {
    return {
      code: "provider_unavailable",
      retryable: true,
      userMessage:
        "The model API appears temporarily unavailable. Click *Resume DDR generation* to retry from saved context.",
    };
  }

  return {
    code: "unknown_error",
    retryable: true,
    userMessage:
      "The DDR run failed unexpectedly. You can retry with *Resume DDR generation* from the saved job state.",
  };
}

async function postRecoveryAction(client, job, detailsText) {
  const destinationChannel = job.progressChannel || job.session?.userId;
  if (!destinationChannel) {
    return;
  }

  try {
    await client.chat.postMessage({
      channel: destinationChannel,
      text: `DDR job ${job.id} failed. Use Resume DDR generation.`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:warning: *DDR generation failed*\n${detailsText}\nJob ID: \`${job.id}\``,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "resume_ddr_job",
              text: {
                type: "plain_text",
                text: "Resume DDR generation",
              },
              style: "primary",
              value: job.id,
            },
          ],
        },
      ],
    });
  } catch (err) {
    console.warn("[postRecoveryAction] Unable to post recovery action", err.message);
  }
}

async function postFinalDdrMessage(client, session, filename) {
  const baseText = `a ddr was created from this message (model: ${session.selectedModel || DEFAULT_MODEL})`;
  const downloadUrl = getJobDownloadUrl(filename);
  const codaRecordLink = session.codaRowUrl
    ? `<${session.codaRowUrl}| 🔗 Link to record>`
    : null;
  const designDecisionRecordsLink = `<${getDesignDecisionRecordsUrl()}| 🔗 Go to Design Decision Records>`;
  const fallbackLink = codaRecordLink || designDecisionRecordsLink;
  const codaWarning = session.codaError
    ? `:warning: Could not publish to Coda: ${session.codaError}`
    : null;
  const channelText = [
    baseText,
    downloadUrl ? `<${downloadUrl}| 💾 Download .md file>` : null,
    fallbackLink,
    codaWarning,
  ]
    .filter(Boolean)
    .join("\n");

  if (session.origin === "slash") {
    await client.chat.postMessage({
      channel: session.userId,
      text: channelText,
    });
    return;
  }

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
    const dmText = [
      downloadUrl
        ? `Your DDR was created, but I couldn't post in the channel. <${downloadUrl}|💾 Download .md file>`
        : "Your DDR was created and saved, but I couldn't post the confirmation in the original channel because I haven't been added to it.",
      fallbackLink,
      codaWarning,
    ]
      .filter(Boolean)
      .join("\n");
    await client.chat.postMessage({
      channel: session.userId,
      text: dmText,
    });
  }
}

async function executeDdrJob(job, client, options = {}) {
  const session = job.session || {};

  try {
    await updateProgressMessage(
      client,
      job,
      "context",
      options.resumedBy ? `_Resumed by <@${options.resumedBy}>._` : "_Preparing generation request._"
    );

    await updateProgressMessage(client, job, "calling_model");
    const markdown = await withTimeout(
      synthesizeDecision(session),
      120000,
      "DDR synthesis timed out while waiting for model output"
    );

    await updateProgressMessage(client, job, "model_done");
    await updateProgressMessage(client, job, "writing_file");

    mkdirSync(DATA_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `design-decision-${timestamp}.md`;
    const filepath = join(DATA_DIR, filename);
    writeFileSync(filepath, markdown);
    job.filename = filename;
    await persistJob(job);

    if (session.publishToCoda) {
      const parsed = parseDdrMarkdown(markdown, session.ddrTitle);
      const codaResult = await publishToCoda(session, parsed);
      session.codaRowUrl = codaResult.rowUrl;
      session.codaError = codaResult.error;
      await persistJob(job);
    }

    await updateProgressMessage(client, job, "posting_result");
    await postFinalDdrMessage(client, session, filename);

    job.status = "completed";
    job.lastError = null;
    await persistJob(job);

    if (job.progressChannel && job.progressTs) {
      await client.chat.update({
        channel: job.progressChannel,
        ts: job.progressTs,
        text: [
          ":white_check_mark: DDR generation complete.",
          `\`${renderAsciiProgressBar(100)}\``,
          `Job ID: \`${job.id}\``,
          job.filename ? `Saved as \`${job.filename}\`.` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }
  } catch (err) {
    console.error("[executeDdrJob] Synthesis error:", err);
    const diagnosis = classifySynthesisError(err);

    job.status = "failed";
    job.lastError = {
      code: diagnosis.code,
      message: err?.message || String(err),
      retryable: diagnosis.retryable,
      at: new Date().toISOString(),
    };
    await persistJob(job);

    const failureText = [
      diagnosis.userMessage,
      job.filename
        ? `Recovered work saved in \`${job.filename}\`${getJobDownloadUrl(job.filename) ? ` (<${getJobDownloadUrl(job.filename)}|download>)` : ""}.`
        : "No markdown file was written yet, but all context is saved in this job.",
    ].join("\n");

    await updateProgressMessage(client, job, job.stage || "calling_model", `:x: ${diagnosis.userMessage}`);
    await postRecoveryAction(client, job, failureText);

    await safePostEphemeralOrDM(
      client,
      session.channelId,
      session.userId,
      `:x: ${diagnosis.userMessage}\nJob ID: \`${job.id}\``
    );
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
  const blocks = [
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
  ];

  if (CODA_FEATURE_ENABLED) {
    blocks.push(
      {
        type: "input",
        block_id: "coda_publish",
        optional: true,
        element: {
          type: "checkboxes",
          action_id: "publish_to_coda",
          options: [
            {
              text: {
                type: "plain_text",
                text: "Publish to Coda",
              },
              value: "publish",
            },
          ],
        },
        label: {
          type: "plain_text",
          text: "Coda",
        },
      },
      {
        type: "input",
        block_id: "ddr_title",
        optional: true,
        element: {
          type: "plain_text_input",
          action_id: "title_input",
          placeholder: {
            type: "plain_text",
            text: "Required if Publish to Coda is checked",
          },
        },
        label: {
          type: "plain_text",
          text: "DDR Title",
        },
      }
    );
  }

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
    blocks,
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
  appNotInChannel = false,
  publishToCoda = false,
  ddrTitle = ""
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

  if (CODA_FEATURE_ENABLED) {
    blocks.push(
      {
        type: "input",
        block_id: "coda_publish",
        optional: true,
        element: {
          type: "checkboxes",
          action_id: "publish_to_coda",
          initial_options: publishToCoda
            ? [
                {
                  text: {
                    type: "plain_text",
                    text: "Publish to Coda",
                  },
                  value: "publish",
                },
              ]
            : undefined,
          options: [
            {
              text: {
                type: "plain_text",
                text: "Publish to Coda",
              },
              value: "publish",
            },
          ],
        },
        label: {
          type: "plain_text",
          text: "Coda",
        },
      },
      {
        type: "input",
        block_id: "ddr_title",
        optional: true,
        element: {
          type: "plain_text_input",
          action_id: "title_input",
          initial_value: ddrTitle,
          placeholder: {
            type: "plain_text",
            text: "Required if Publish to Coda is checked",
          },
        },
        label: {
          type: "plain_text",
          text: "DDR Title",
        },
      }
    );
  }

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
