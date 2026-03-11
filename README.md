# Design Decision Logger

A Slack app that synthesizes conversations into structured design decision logs (ADRs) using Claude.

## How It Works

1. Open any Slack message > click **Connect to apps** (or **More actions**) > **Log Design Decision**
2. The app captures the message (and its full thread if applicable)
3. A modal pops up asking for additional context (more Slack links, notes)
   and which Claude model to use
4. Claude asks clarifying questions so you can fill in any missing context
5. Claude synthesizes everything into a structured markdown decision log saved locally
6. The channel gets a simple confirmation: `a ddr was created from this message`

## Setup

### 1. Create the Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** > **From scratch**
3. Name it "Design Decision Logger" and select your workspace

### 2. Configure the App

**Enable Socket Mode** (this is the key for local development, no ngrok needed):
1. Go to **Settings > Socket Mode** in the left sidebar
2. Toggle it **ON**
3. You'll be prompted to create an App-Level Token
4. Give it a name like "socket-token" and add the scope `connections:write`
5. Copy the token (starts with `xapp-`), you'll need it for `.env`

**Create the Message Shortcut:**
1. Go to **Features > Interactivity & Shortcuts**
2. Toggle **Interactivity** ON
3. Click **Create New Shortcut** > **On messages**
4. Name: `Log Design Decision`
5. Description: `Synthesize this conversation into a design decision log`
6. Callback ID: `log_design_decision`
7. Save changes, then reinstall the app to the workspace

**Set OAuth Scopes:**
1. Go to **Features > OAuth & Permissions**
2. Under **Bot Token Scopes**, add:
   - `chat:write` (post messages)
   - `channels:history` (read public channel messages)
   - `groups:history` (read private channel messages)
   - `im:write` (open DMs)
   - `users:read` (resolve usernames)
   - `files:write` (upload the markdown file)
   - `commands` (for the shortcut)

**Install the App:**
1. Go to **Settings > Install App**
2. Click **Install to Workspace** and authorize
3. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

### 3. Get Your Signing Secret

1. Go to **Settings > Basic Information**
2. Under **App Credentials**, find and copy the **Signing Secret**

### 4. Set Up the Project

```bash
# Clone / copy the project
cd design-decision-logger

# Install dependencies
npm install

# Create your .env file
cp .env.example .env
```

Edit `.env` with your tokens:
```
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_APP_TOKEN=xapp-your-app-level-token
ANTHROPIC_API_KEY=sk-ant-your-key
```

### 5. Run It

```bash
npm run dev
```

You should see:
```
⚡ Design Decision Logger is running on port 3000
   Using Socket Mode (no public URL needed for local dev!)
```

### 6. Test It

1. Go to any Slack message
2. Click the three dots (or right-click)
3. Look for `Log Design Decision` under **Connect to apps**
4. If you don't see it, check **More actions** and ensure the app was reinstalled after adding the shortcut

## Debug Checklist

If the shortcut is missing or the app is not running:

1. Confirm startup works:
   ```bash
   npm run dev
   ```
2. Verify `.env` contains all 4 required values (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`, `ANTHROPIC_API_KEY`)
3. In Slack app config, verify:
   - Message shortcut callback id is exactly `log_design_decision`
   - Socket Mode is enabled
   - Bot scopes were added and app was reinstalled
4. Re-open Slack (or refresh) and test again from **Connect to apps** on a message
5. If model list is empty in the modal, confirm your Anthropic key can access
   models in the selected org/workspace and retry

## Output

Decision logs are saved to each user's local `~/Downloads` folder. The app does not upload the markdown into Slack.

## Architecture

```
Slack Message Action
  |
  v
Bolt (Socket Mode, runs locally)
  |
  ├── Fetches thread / linked messages via Slack API
  ├── Opens modal for additional context
  |
  v
Claude API (synthesizes into structured ADR)
  |
  v
Markdown file + Slack DM
```

## Moving to Production

When you're ready to host this permanently (so it works even when your laptop is closed):

1. **Cheapest**: Deploy to Railway, Render, or Fly.io (free tier or ~$5/mo)
2. **Serverless**: Adapt to Cloudflare Workers or Vercel (requires switching from Socket Mode to HTTP mode with a public URL)
3. Socket Mode works great for personal use from a laptop or always-on machine
