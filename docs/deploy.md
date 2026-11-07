# Deploy

## Server (Fly)

```bash
fly launch --no-deploy --copy-config
```
```bash
fly volumes create msl_data --size 1
```
```bash
fly secrets set OPENAI_API_KEY=sk-...
```
```bash
fly deploy
```

- **Check it:** `https://<app>.fly.dev/api/health` returns `{"ok":true}`.
- **SQLite** lives on the `msl_data` volume.
- **One machine stays up,** because the session hang-up timers live in memory.

## Web (Vercel)

1. Import the repo and leave the root directory as the repo root.
2. `vercel.json` builds `web/` and rewrites `/api/*` to the Fly app, so the browser stays same-origin.
3. If the Fly app name isn't `msl-live-api`, update `vercel.json`.

Set a monthly spending limit on the OpenAI account before sharing the public link.
