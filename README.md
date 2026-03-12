# Design Decision Logger

A Slack app that turns Slack discussions into structured Design Decision Records (DDRs) using Claude.

## Slack App Description Snippet (Copy/Paste)

Use this in your Slack app "App Description" field:

```text
Design Decision Logger helps teams capture architecture and product decisions from Slack conversations and save them as structured markdown Design Decision Records (DDRs).

Commands and shortcuts:
- /ddr
  Starts the DDR flow with a chooser:
  - Start from scratch: paste context manually.
  - From a Slack message: provide links/notes to pull conversation context.
  You can choose a Claude model, answer clarifying questions, then generate a DDR.

- /ddr-jobs
  Shows recent DDR jobs and their status (in_progress, completed, failed), including job IDs and recovery actions.
  Examples:
  - /ddr-jobs
  - /ddr-jobs failed
  - /ddr-jobs all failed 15
  - /ddr-jobs ddr-<job-id>

- Message shortcut: "Log Design Decision"
  Run from any Slack message to capture that message/thread directly, then add extra links/notes before generating the DDR.

What this app does:
- Gathers thread content plus optional extra Slack links and notes
- Asks clarifying questions before drafting
- Generates a markdown DDR with standard sections (Problem, Decision, Consequences, Alternatives)
- Saves files locally and provides a downloadable link when PUBLIC_URL is configured
- Supports retry/resume for failed jobs

Notes:
- Text-only context in modal inputs (video links/uploads are rejected in those fields)
- The app must be in the channel to read full thread context and post there
```

## Command and Shortcut Reference

- `/ddr`: Starts a modal flow to create a DDR from scratch or from message-based context.
- `/ddr-jobs`: Lists DDR jobs with filtering by status, scope (`mine` or `all`), job ID, and limit.
- `Log Design Decision` (message shortcut): Captures the clicked message (and thread when available) and starts DDR creation.

## How It Works

1. Start with `/ddr` or the `Log Design Decision` message shortcut.
2. Add context (Slack links and notes) and select a Claude model.
3. Answer clarifying questions.
4. The app generates markdown and stores it in `data/`.
5. Slack posts progress and completion updates, plus recovery actions if generation fails.

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
2. Add `/ddr` (short description: "Start a design decision record flow").
3. Add `/ddr-jobs` (short description: "List/recover DDR generation jobs").

Create message shortcut:
1. Go to **Features > Interactivity & Shortcuts**.
2. Enable **Interactivity**.
3. Click **Create New Shortcut** > **On messages**.
4. Name: `Log Design Decision`.
5. Callback ID: `log_design_decision`.
6. Save and reinstall the app.

Add OAuth scopes:
1. Go to **Features > OAuth & Permissions**.
2. Add bot scopes:
   - `chat:write`
   - `channels:history`
   - `groups:history`
   - `im:write`
   - `users:read`
   - `commands`

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
# Optional for Coda publishing:
CODA_API_TOKEN=
CODA_DOC_ID=
CODA_TABLE_ID=
# Optional; must match your Status options in Coda.
CODA_DEFAULT_STATUS=Under Review
```

### 5. Run

```bash
npm run dev
```

## Output and Storage

- Generated markdown files are saved in `data/` as `design-decision-<timestamp>.md`.
- Job state is persisted in `data/jobs/` for recovery and `/ddr-jobs`.
- If `PUBLIC_URL` is configured, Slack messages include a direct download link.

## Coda API Setup

1. Go to [coda.io/account](https://coda.io/account) and scroll to **API Settings**.
2. Click **Generate API token**.
3. Give it a name (for example, "DDR Slack Bot") and click **Generate**.
4. Copy the token and set it as `CODA_API_TOKEN` in your environment.
5. Open the Coda doc that contains your Design Decision Records table.
6. Get the **Doc ID** from the URL: `https://coda.io/d/Your-Doc_d<DOC_ID>/...` (the part after `_d`).
7. Get the **Table ID** from the URL after `_su`, or use the table name (for example, `Design Decision Records`).
8. Set `CODA_DOC_ID` and `CODA_TABLE_ID` in your environment.

If `CODA_API_TOKEN` is not set, Coda controls are hidden and DDR generation works as usual without publishing.

Required Coda table columns:
- Title (or `Name`)
- Author
- Status
- Date proposed (or `Date Proposed`; `Date Created`/`Date created` also supported as fallback)
- Problem
- Decision
- Consequences
- Alternatives Considered
- Additional Context

The bot resolves Coda column IDs from these names and caches them for the running process.
For Status, the default published value is `Under Review` (or `CODA_DEFAULT_STATUS` if set).

## Troubleshooting

- Slash command says "app did not respond":
  - Confirm process is running and Socket Mode is connected.
  - Verify `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`, `ANTHROPIC_API_KEY`.
  - Ensure `/ddr` and `/ddr-jobs` are created on the same Slack app as your tokens.
- Shortcut missing:
  - Verify callback ID is `log_design_decision`.
  - Reinstall app after adding or editing shortcuts/scopes.
- Thread not captured:
  - Add the app to that channel first.
