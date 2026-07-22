# Kore async_wait Callback Server

A small Express server that integrates with a **Kore.ai Agents workflow Tool node
running in `async_wait` mode**. It receives a trigger, drives a human side-channel
(SMS → form → image upload → OpenAI Vision analysis), then resumes the paused
workflow step by POSTing a **signed callback**.

## Setup

```bash
npm install
cp .env.example .env    # then fill in real values
npm start               # http://localhost:3000
```

Expose the port publicly (e.g. `ngrok http 3000`) and set `APP_BASE_URL` to that
public URL. Point the workflow Tool node's endpoint at `<public-url>/start`.

## Endpoints

- `POST /start` — called by the workflow Tool node. Reads `callbackUrl` +
  `callbackSecret` from **headers**, stores them by `request_id`, sends the SMS
  form link, and acks immediately (the node stays paused until the callback).
- `POST /submit-form` — the human form. Uploads the image, analyzes it, then
  fires the signed callback to resume the workflow.
- `GET /` — health check.

## The callback contract (important)

To resume an `async_wait` step, the callback POST to `callbackUrl` must include:

| Header | Value |
| --- | --- |
| `x-callback-timestamp` | Unix time in **seconds** |
| `x-callback-signature` | hex of `HMAC-SHA256(callbackSecret, "<ts>.<rawBody>")` |
| `Origin` | the environment URL (e.g. `https://agents-staging.kore.ai`) |

Body:

- `status` — a **numeric HTTP status code**; `200` (2xx) = success, non-2xx = fail.
  (A string like `"COMPLETED"` fails the step as "non-success".)
- `data` — object; becomes the tool **OUTPUT** in the workflow.

See `sendCallback()` in `server.js` for the reference implementation.

## Notes

- Set the Tool node **Timeout** to minutes (not the 30s default) — a human filling
  a form won't complete in 30s.
- The `pending` Map is in-memory (single process). For serverless / multi-instance,
  replace it with an external store (Redis, DynamoDB, ...).
- The OpenAI prompt is plant-health-specific; adjust in `/submit-form` as needed.
