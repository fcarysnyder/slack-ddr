---
name: Deploy to Railway
overview: Deploy the Slack bot to Railway with a persistent volume to store and serve the generated markdown files.
todos:
  - id: install-express
    content: Install express dependency
    status: completed
  - id: add-express-server
    content: Update app.js to include an Express server for file downloads
    status: completed
  - id: update-save-location
    content: Change file save location to ./data instead of ~/Downloads
    status: completed
  - id: update-slack-message
    content: Update Slack success message to include the download link
    status: completed
  - id: update-env-example
    content: Add PUBLIC_URL to .env.example
    status: completed
isProject: false
---

# Deploying Slack DDR to Railway

To deploy this app so it runs 24/7 and serves the generated markdown files for download, we'll use **Railway**. It's an easy-to-use hosting platform that supports **Persistent Volumes** (crucial for keeping the `.md` files safe when the server restarts).

Here is the plan to adapt the code and deploy it:

### 1. Code Changes

- **Install Express**: Add `express` to dependencies to serve the files over HTTP.
- **Add Download Endpoint**: Add a simple Express server to `app.js` that listens on `process.env.PORT` and serves a `/download/:filename` endpoint. This endpoint will set the `Content-Disposition: attachment` header to trigger an automatic download.
- **Change Save Location**: Update the file saving logic in `app.js` to write to a local `./data` directory instead of the OS `~/Downloads` folder.
- **Update Slack Message**: Modify the success message in `app.js` to include a direct download link using a new `PUBLIC_URL` environment variable.

### 2. Environment Variables

- Add `PUBLIC_URL` to `.env` and `.env.example`. This will be the public URL of the Railway app (e.g., `https://slack-ddr-production.up.railway.app`).

### 3. Deployment Steps

1. **GitHub**: Commit and push the code to a private GitHub repository.
2. **Railway Setup**:
  - Create a new project on Railway and connect it to your GitHub repository.
  - Add a **Persistent Volume** in Railway and mount it to `/app/data` (this ensures the `.md` files survive server restarts).
3. **Configure Variables**: Set your Slack and Anthropic tokens in Railway's environment variables, along with the `PUBLIC_URL` (Railway provides a domain you can use).
4. **Deploy**: Railway will automatically build and deploy the app.

Once you confirm this plan, I will make the necessary code changes. Then, you can push the code to GitHub and follow the deployment steps!