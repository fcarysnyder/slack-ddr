# Design Decision Logger

A Slack app that turns Slack discussions into structured Design Decision Records (DDRs) using Claude.

## Slack App Description Snippet (Copy/Paste)

Use this in your Slack app "App Description" field:

```text
Design Decision Logger helps teams capture architecture and product decisions from Slack conversations and save them as structured markdown records.

Commands and shortcuts:
- /ddr
  Starts the Design Decision Record (DDR) flow directly.
  You choose start mode (scratch or message-based context).

- /odc
  Starts with a mode chooser:
  - Start from scratch
  - From a Slack message
  Both paths continue into the same context modal UX (ODC-specific fields and outputs).

- /ddr-jobs
  Shows recent DDR jobs and their status (in_progress, completed, failed), including job IDs and recovery actions.
  Examples:
  - /ddr-jobs
  - /ddr-jobs failed
  - /ddr-jobs all failed 15
  - /ddr-jobs ddr-<job-id>

- /odc-jobs
  Shows recent ODC jobs only.
  Examples:
  - /odc-jobs
  - /odc-jobs failed
  - /odc-jobs all failed 15
  - /odc-jobs odc-<job-id>

- Message shortcut: "Log Design Decision"
  Run from any Slack message to capture that message/thread directly, then add extra links/notes before generating the DDR.

- Message shortcut: "Log Design Challenge"
  Run from any Slack message to capture that message/thread directly, then route to the ODC flow.

What this app does:
- Gathers thread content plus optional extra Slack links and notes
- Asks clarifying questions before drafting
- Generates markdown for DDRs and ODCs with structured sections
- Saves files locally and provides a downloadable link when PUBLIC_URL is configured
- Supports retry/resume for failed jobs

Notes:
- Text-only context in modal inputs (video links/uploads are rejected in those fields)
- Existing Slack thread images/files can be referenced automatically; no new file uploads are required in the modal flow
- The app must be in the channel to read full thread context and post there
```

## Command and Shortcut Reference

- `/ddr`: Starts the DDR flow directly.
- `/odc`: Starts ODC flow with a start mode chooser (scratch or message-based context).
- `/ddr-jobs`: Lists DDR jobs with filtering by status, scope (`mine` or `all`), job ID, and limit.
- `/odc-jobs`: Lists ODC jobs with the same filters.
- `Log Design Decision` (message shortcut): Captures the clicked message (and thread when available) and starts DDR creation.
- `Log Design Challenge` (message shortcut): Captures the clicked message (and thread when available) and starts ODC creation.

## How It Works

1. Start with `/ddr`, `/odc`, `Log Design Decision`, or `Log Design Challenge`.
2. Add context (Slack links and notes) and select a Claude model.
3. Answer clarifying questions.
4. The app generates markdown and stores it in `data/`.
5. Slack posts progress and completion updates, plus recovery actions if generation fails.

## User Journey Map (From `app.js`)

This map reflects the implemented flow in `app.js` (commands, shortcuts, modal callbacks, and job recovery actions).

```mermaid
flowchart TD
  A[User in Slack] --> B{Entry point}

  B -->|/ddr| D1[DDR start mode chooser: from scratch or from message]
  B -->|/odc| O0[ODC start mode chooser: from scratch or from message]
  B -->|Log Design Decision or Log Design Challenge| S1[Capture clicked message or thread]

  D1 -->|From scratch| D1S[DDR scratch selected]
  D1 -->|From message| D1M[DDR message selected]
  O0 -->|From scratch| O0S[ODC scratch selected]
  O0 -->|From message| O0M[ODC message selected]
  D1S --> G1[Gather context modal]
  D1M --> G1
  O0S --> G1
  O0M --> G1
  S1 --> S2[Shortcut type chooser: DDR or ODC]
  S2 --> G1

  G1 --> G2[Add links + notes, choose model, optional Coda publish]
  G2 --> Q0
  Q0 --> Q1[Clarifying questions modal]
  Q1 --> J1[Create persisted job in data/jobs]

  J1 --> P1[Post progress message: DM for slash, thread or channel for shortcut]
  P1 --> E1[Synthesize DDR/ODC with selected Claude model]
  E1 --> F1[Write markdown file to data/]
  F1 --> Coda{Publish to Coda?}
  Coda -->|Yes| C1[Publish row + attach row URL/error]
  Coda -->|No| R1[Skip publish]
  C1 --> R2[Post final Slack completion message]
  R1 --> R2

  E1 -->|Failure or timeout| X1[Mark job failed + store diagnosis]
  X1 --> X2[Post Resume DDR/ODC generation button]
  X2 --> X3[User clicks resume action]
  X3 --> E1
```

### User-facing States

- **Start:** User invokes slash command or message shortcut.
- **Context Capture:** App gathers thread content, optional linked messages, and user notes.
- **Clarification:** App asks targeted follow-up questions before writing output.
- **Generation:** Job is created and tracked with progress updates and status.
- **Completion:** Markdown file is saved locally, optional Coda publish runs, and Slack shares result links.
- **Recovery:** If generation fails, users can resume from saved job state via `/ddr-jobs`, `/odc-jobs`, or in-message resume buttons.

## Setup

### 1. Create the Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps).
2. Click **Create New App** > **From scratch**.
3. Name it "Design Decision Logger" and choose your workspace.

### 2. Configure Features

Enable **Socket Mode**:
1. Go to **Settings > Socket Mode**.
2. Toggle **On**.
3. Create an app-level token with `connections:write`.
4. Save the token (`xapp-...`) for `.env`.

Create slash commands:
1. Go to **Features > Slash Commands**.
2. Add `/ddr` (short description: "Start a design record flow").
3. Add `/odc` (short description: "Start an open design challenge flow").
4. Add `/ddr-jobs` (short description: "List/recover DDR generation jobs").
5. Add `/odc-jobs` (short description: "List/recover ODC generation jobs").

Create message shortcut:
1. Go to **Features > Interactivity & Shortcuts**.
2. Enable **Interactivity**.
3. Click **Create New Shortcut** > **On messages**.
4. Name: `Log Design Decision`.
5. Callback ID: `log_design_decision`.
6. Name: `Log Design Challenge`.
7. Callback ID: `log_design_challenge`.
8. Save and reinstall the app.

Add OAuth scopes:
1. Go to **Features > OAuth & Permissions**.
2. Add bot scopes:
   - `chat:write`
   - `channels:history`
   - `channels:read` (optional; needed when `SLACK_DDR_ANNOUNCE_CHANNEL` is set by `#channel-name`)
   - `groups:history`
   - `groups:read` (optional; needed when announce channel is a private `#channel-name`)
   - `im:write`
   - `users:read`
   - `commands`
   - `files:read` (required to analyze existing Slack image attachments)

Install app:
1. Go to **Settings > Install App**.
2. Install to workspace.
3. Copy the bot token (`xoxb-...`).

### 3. Get Signing Secret

1. Go to **Settings > Basic Information**.
2. Copy **Signing Secret** from **App Credentials**.

### 4. Local Project Setup

```bash
npm install
cp .env.example .env
```

Set `.env` values:

```text
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_APP_TOKEN=xapp-your-app-level-token
ANTHROPIC_API_KEY=sk-ant-your-key
# Optional but recommended for download links:
PUBLIC_URL=https://your-hostname
# Optional: route final "DDR created" announcements to one channel.
# Use channel ID (recommended) or #channel-name.
SLACK_DDR_ANNOUNCE_CHANNEL=
# Optional for Coda publishing:
CODA_API_TOKEN=
CODA_DOC_DDR_ID=
CODA_TABLE_DDR_ID=
CODA_DOC_ODC_ID=
CODA_TABLE_ODC_ID=
# Optional; must match your Status options in Coda.
CODA_DEFAULT_STATUS=Under Review
```

### 5. Run

```bash
npm run dev
```

## Output and Storage

- Generated markdown files are saved in `data/` as:
  - `design-decision-<timestamp>.md` for DDR
  - `open-design-challenge-<timestamp>.md` for ODC
- Job state is persisted in `data/jobs/` for recovery and `/ddr-jobs`.
- If `PUBLIC_URL` is configured, Slack messages include a direct download link.
- If `SLACK_DDR_ANNOUNCE_CHANNEL` is set, final DDR completion messages are posted there.
- Anthropic synthesis can include existing Slack images from source/linked threads (when file access permits).
- Coda publishing stays link-only for Slack references; image binaries are not uploaded to Coda.

## Coda API Setup

1. Go to [coda.io/account](https://coda.io/account) and scroll to **API Settings**.
2. Click **Generate API token**.
3. Give it a name (for example, "DDR Slack Bot") and click **Generate**.
4. Copy the token and set it as `CODA_API_TOKEN` in your environment.
5. Open the Coda doc that contains your Design Decision Records table.
6. Get the **Doc ID** from the URL: `https://coda.io/d/Your-Doc_d<DOC_ID>/...` (the part after `_d`).
7. Get the **Table ID** from the URL after `_su`, or use the table name (for example, `Design Decision Records`).
8. Set `CODA_DOC_DDR_ID`, `CODA_TABLE_DDR_ID`, `CODA_DOC_ODC_ID`, and `CODA_TABLE_ODC_ID` in your environment.

If `CODA_API_TOKEN` is not set, Coda controls are hidden and DDR generation works as usual without publishing.

Required Coda table columns (DDR):
- Title (or `Name`)
- Status
- Date proposed (or `Date Proposed`; `Date Created`/`Date created` also supported as fallback)
- Problem
- Decision
- Consequences
- Alternatives Considered
- Additional Context
- Slack References (optional; if present, receives deduped Slack links used during generation)

Required Coda table columns (ODC):
- Title (or `Name`)
- Date Created (or `Date created`)
- Challenge
- Why It's Hard
- Paths Considered
- Cost of No Action
- Additional Context
- Status
- Slack References (optional; if present, receives deduped Slack links used during generation)

The bot resolves Coda column IDs from these names and caches them for the running process.
For DDR Status, the default published value is `Under Review` (or `CODA_DEFAULT_STATUS` if set).
For ODC Status, the default is `Open`.

## Troubleshooting

- Slash command says "app did not respond":
  - Confirm process is running and Socket Mode is connected.
  - Verify `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`, `ANTHROPIC_API_KEY`.
  - Ensure `/ddr`, `/odc`, `/ddr-jobs`, and `/odc-jobs` are created on the same Slack app as your tokens.
- Shortcut missing:
  - Verify callback IDs are `log_design_decision` and `log_design_challenge`.
  - Reinstall app after adding or editing shortcuts/scopes.
- Thread not captured:
  - Add the app to that channel first.
