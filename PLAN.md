# Coda Integration Plan

## Overview

Add opt-in Coda publishing to the DDR flow: parse the generated markdown into sections, push them as a new row to a Coda table, and link to the new record in the final Slack message.

---

## 1. Configuration (env vars)

Add these environment variables:

```
CODA_API_TOKEN=           # Coda API token (required for Coda features)
CODA_DOC_ID=              # Coda document ID (from the doc URL)
CODA_TABLE_ID=            # Coda table ID or name (e.g. "Design Decision Records")
```

**Behavior when not set:** If `CODA_API_TOKEN` is missing, the "Publish to Coda" checkbox is hidden from all modals. The app degrades gracefully — everything works as it does today.

No npm dependency needed — Coda's REST API is simple enough to call with `fetch()` (available natively in Node 18+).

---

## 2. "Publish to Coda" checkbox + Title field

### Placement

**DDR Chooser modal** (`buildDdrChooserModal`, `/ddr` command flow):
- Add an optional checkbox: "Publish to Coda" (only shown if `CODA_API_TOKEN` is set)
- Add a text input: "DDR Title" (only shown if publish checkbox is checked — but since Slack modals can't do conditional visibility, we show it whenever Coda is configured and make it optional; if publish is checked but title is empty, reject with validation error)

**Gather Context modal** (`buildGatherContextModal`, message shortcut flow):
- Add the same checkbox + title field (since message shortcuts skip the chooser modal)

### Session propagation

When the chooser/gather-context modal is submitted:
- Read `publish_to_coda` checkbox state and `ddr_title` text input
- Store `session.publishToCoda` (boolean) and `session.ddrTitle` (string) on the session object
- These flow through to `executeDdrJob` → `postFinalDdrMessage` via the existing session/job persistence

---

## 3. Markdown parser

Add a function `parseDdrMarkdown(markdown)` that extracts sections from the generated markdown:

```js
function parseDdrMarkdown(markdown) {
  // Returns an object like:
  // {
  //   title: "Design Decision: ...",       // from # heading (fallback to session.ddrTitle)
  //   problem: "...",                       // from ## Problem
  //   decision: "...",                      // from ## Decision
  //   consequences: "...",                  // from ## Consequences (all subsections combined)
  //   alternativesConsidered: "...",        // from ## Alternatives Considered
  //   additionalContext: "..."              // from ## Additional Context
  // }
}
```

Strategy: Split the markdown by `## ` headings. For each heading, capture everything until the next `## ` heading. The `## Consequences` section includes its `### Positive`, `### Negative / Tradeoffs`, and `### Neutral` subsections as one combined block.

---

## 4. Coda API integration

### New function: `publishToCoda(session, parsedSections)`

1. **Resolve column IDs** — Call `GET /docs/{docId}/tables/{tableId}/columns` to list columns and match by name. Cache the column map for the lifetime of the process (columns don't change often).

2. **Insert row** — Call `POST /docs/{docId}/tables/{tableId}/rows` with:
   ```json
   {
     "rows": [{
       "cells": [
         { "column": "<Title column ID>",       "value": session.ddrTitle },
         { "column": "<Author column ID>",      "value": session.initiatedBy },
         { "column": "<Status column ID>",      "value": "Proposed" },
         { "column": "<Date Created column ID>","value": "<today's date>" },
         { "column": "<Problem column ID>",     "value": parsedSections.problem },
         { "column": "<Decision column ID>",    "value": parsedSections.decision },
         { "column": "<Consequences column ID>","value": parsedSections.consequences },
         { "column": "<Alternatives Considered column ID>", "value": parsedSections.alternativesConsidered },
         { "column": "<Additional Context column ID>",      "value": parsedSections.additionalContext }
       ]
     }]
   }
   ```

3. **Get row URL** — The insert response returns `addedRowIds`. Construct the row URL as:
   ```
   https://coda.io/d/_d{docId}/_su{tableId}#_ri{rowId}
   ```
   Or use `GET /docs/{docId}/tables/{tableId}/rows/{rowId}` to get the `browserLink` field.

### Error handling
- If Coda push fails, log the error but **do not** fail the DDR job. The markdown file is still saved and downloadable.
- Post a warning in the final message: "Could not publish to Coda: {error}" and fall back to the generic table link.

---

## 5. Update `executeDdrJob`

After the markdown file is written (line ~1188) and before posting the final message:

```
if (session.publishToCoda) {
  const parsed = parseDdrMarkdown(markdown);
  const codaResult = await publishToCoda(session, parsed);
  // codaResult = { success, rowUrl, error }
  session.codaRowUrl = codaResult.rowUrl;  // null if failed
  session.codaError = codaResult.error;    // null if succeeded
}
```

---

## 6. Update `postFinalDdrMessage`

Current behavior:
```
Download .md file
Go to Design Decision Records (hardcoded generic link)
```

New behavior when Coda publish succeeded:
```
Download .md file
Link to record (direct URL to the new Coda row)
```

New behavior when Coda publish failed:
```
Download .md file
Go to Design Decision Records (generic link, same as today)
(warning about Coda publish failure)
```

When Coda was not opted into: same as today.

---

## 7. Coda API Setup Instructions

Add to README.md:

### Coda API Setup

1. Go to https://coda.io/account and scroll to "API Settings"
2. Click "Generate API token"
3. Give it a name (e.g. "DDR Slack Bot") and click "Generate"
4. Copy the token — set it as `CODA_API_TOKEN` in your environment
5. Open your Coda doc containing the Design Decision Records table
6. Get the **Doc ID** from the URL: `https://coda.io/d/Your-Doc_d<DOC_ID>/...` — the part after `_d`
7. Get the **Table ID**: you can use the table name (e.g. `"Design Decision Records"`) or the ID from the URL after `_su`
8. Set `CODA_DOC_ID` and `CODA_TABLE_ID` in your environment

**Required Coda table columns** (names must match exactly):
- Title
- Author
- Status
- Date Created
- Date Approved
- Problem
- Decision
- Consequences
- Alternatives Considered
- Additional Context

The bot will auto-discover column IDs by name on startup.

---

## Files to modify

| File | Changes |
|------|---------|
| `app.js` | Add `parseDdrMarkdown()`, `publishToCoda()`, Coda column cache, checkbox/title to modals, session propagation, update `executeDdrJob` and `postFinalDdrMessage` |
| `.env.example` | Add `CODA_API_TOKEN`, `CODA_DOC_ID`, `CODA_TABLE_ID` |
| `README.md` | Add Coda API setup instructions |

No new dependencies needed (uses native `fetch`).
