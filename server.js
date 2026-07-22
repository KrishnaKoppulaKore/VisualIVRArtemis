require("dotenv").config();

const express = require("express");
const axios = require("axios");
const path = require("path");
const crypto = require("node:crypto");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Malformed JSON in a request body throws inside body-parser. Catch it here and
// reply with a clean 400 instead of letting Express print a raw stack trace.
app.use((err, req, res, next) => {
  if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) {
    console.error("Bad JSON in request body:", err.message);
    return res.status(400).json({ error: "Invalid JSON in request body" });
  }
  next(err);
});

/**
 * Correlation store: request_id -> { callbackUrl, callbackSecret, createdAt }
 *
 * NOTE (serverless): this is in-memory and only works for a single long-lived
 * process. If you deploy to Lambda / multiple instances, replace this Map with
 * an external store (Redis, DynamoDB, etc.) so /start and /submit-form can run
 * on different instances.
 */
const pending = new Map();

/**
 * ---------------------------------------------------------------------------
 * START  (invoked by the Kore workflow Tool node in async_wait mode)
 * ---------------------------------------------------------------------------
 * The node sends callbackUrl + callbackSecret in the HEADERS (per the tool
 * config: Callback Location = header, keys = callbackUrl / callbackSecret).
 *
 * We DO NOT block here. We store the callback info, kick off the side channel
 * (SMS with a form link), and immediately acknowledge. The workflow node stays
 * paused until we POST the result to callbackUrl from /submit-form.
 */
app.post("/start", async (req, res) => {
  try {
    const { email, request_id } = req.body;
    // dealID is used to prefill the form from DPD. Accept common casings.
    const dealId = req.body.dealID || req.body.dealId || req.body.deal_id;

    // Header keys mirror the tool node config. Express lowercases header names,
    // so this matches regardless of the casing the platform sends.
    const callbackUrl = req.headers["callbackurl"];
    const callbackSecret = req.headers["callbacksecret"];

    console.log("Start called:", { email, request_id, dealId, callbackUrl });

    if (!request_id) {
      return res.status(400).json({ error: "request_id is required" });
    }
    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }
    if (!callbackUrl) {
      // In real async_wait the platform always supplies this; guard anyway.
      return res.status(400).json({ error: "callbackUrl header missing" });
    }

    // Remember how to resume this workflow node later. dealId is kept so the
    // form can prefill itself from DPD (looked up by request_id, keeping the
    // DPD auth token server-side).
    pending.set(request_id, {
      callbackUrl,
      callbackSecret,
      dealId,
      createdAt: Date.now(),
    });

    // ---- Side channel: build the form link ----------------------------------
    // Trim a trailing slash off the base URL so we never emit a double slash.
    const baseUrl = (process.env.APP_BASE_URL || "").trim().replace(/\/+$/, "");
    const formLink = `${baseUrl}/form.html?request_id=${encodeURIComponent(
      request_id
    )}`;

    console.log("Form link for", request_id, ":", formLink);

    // Email the form link to the address from the request body.
    await sendEmail(email, formLink);

    console.log("Waiting for form submission for", request_id);

    // Immediate async_wait acknowledgement. The workflow proceeds only when the
    // callback fires later.
    res.json({ status: "ACCEPTED", request_id, formLink });
  } catch (err) {
    console.error("Start error:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * ---------------------------------------------------------------------------
 * DEAL INFO  (called by the form on load to prefill fields)
 * ---------------------------------------------------------------------------
 * Looks up the dealId stored for this request_id, fetches the matching record
 * from DPD, and returns it mapped to the form's field names. Proxying here
 * keeps the DPD auth token on the server (never exposed to the browser).
 * Always responds 200 with a (possibly empty) object so the form degrades
 * gracefully to a blank, editable form when nothing is found.
 */
app.get("/deal-info", async (req, res) => {
  try {
    const entry = pending.get(req.query.request_id);
    const dealId = entry?.dealId;
    if (!dealId) return res.json({});

    const resp = await axios.get(process.env.DPD_PROCESS_URL, {
      params: { DealId: dealId },
      headers: { Authorization: process.env.DPD_AUTH },
      timeout: 15000,
    });

    // Response is an array of records; use the first match.
    const record = Array.isArray(resp.data) ? resp.data[0] : resp.data;
    if (!record) return res.json({});

    // Treat DPD's "NA"/blank placeholders as no data so the field stays empty.
    const val = (v) => {
      const s = (v ?? "").toString().trim();
      return !s || s.toUpperCase() === "NA" ? "" : s;
    };

    res.json({
      deal_id: val(record.DealId) || dealId,
      deal_name: val(record.ProjectName) || val(record.DealName),
      se_email: val(record.SEName),
      ae_email: val(record.AEName),
      products: val(record.ProductsToBeUsed) || val(record.ProductsUsed),
      channels: val(record.Channels) || val(record.ChannelsUsed),
      dry_run_date: val(record.DryRunDate),
      demo_date: val(record.DemoDate),
      demo_type: val(record.DemoType),
      third_party: val(record.ThirdParty),
      demo_region: val(record.demoRegion) || val(record.DemoRegion),
    });
  } catch (err) {
    console.error("Deal info error:", err.response?.data || err.message);
    // Never block the form — just return empty so it renders blank + editable.
    res.json({});
  }
});

/**
 * ---------------------------------------------------------------------------
 * FORM SUBMISSION  (human fills the form)
 * ---------------------------------------------------------------------------
 * Collects the submitted fields -> fires the Kore callback.
 */
app.post("/submit-form", async (req, res) => {
  const {
    request_id,
    deal_id,
    deal_name,
    se_email,
    ae_email,
    products,
    channels,
    dry_run_date,
    demo_date,
    demo_type,
    third_party,
    demo_region,
  } = req.body;
  try {
    console.log("Form received:", { request_id, deal_id, deal_name });

    const result = {
      deal_id,
      deal_name,
      se_email,
      ae_email,
      products,
      channels,
      dry_run_date,
      demo_date,
      demo_type,
      third_party,
      demo_region,
    };
    console.log("Final result:", result);

    // ---- Persist to DPD, in parallel ---------------------------------------
    // Fire-and-forget: kicked off WITHOUT await so it never blocks or delays
    // the Kore callback below. Errors are logged, not surfaced to the workflow.
    storeToDpd(result).catch((e) =>
      console.error("DPD store error:", e.response?.data || e.message)
    );

    // ---- Resume the workflow via the Kore callback -------------------------
    const entry = pending.get(request_id);
    if (!entry) {
      // Node may have already timed out, or request_id is wrong.
      console.warn("No pending callback for request_id:", request_id);
    } else {
      // vis_ivr2 is an HTTP-type tool, so the async callback mirrors an HTTP
      // response: `status` is a NUMERIC status code (2xx = success). Strings
      // like "COMPLETED"/"success" are treated as non-success. `data` becomes
      // the tool OUTPUT. Confirmed end-to-end on staging (Flow Log = Completed).
      await sendCallback(entry, {
        request_id,
        status: 200,
        data: result,
      });
      pending.delete(request_id);
    }

    res.send(successPage());
  } catch (err) {
    console.error("Submit form error:", err.response?.data || err.message);

    // Fail the workflow step fast (non-2xx status) instead of letting the node
    // hang until its timeout. Routes through the node's ON FAILURE branch.
    const entry = pending.get(request_id);
    if (entry) {
      try {
        await sendCallback(entry, {
          request_id,
          status: 500,
          data: { error: err.message },
        });
      } catch (cbErr) {
        console.error("Failure callback error:", cbErr.message);
      }
      pending.delete(request_id);
    }

    res.status(500).send(`<h2>Error occurred</h2><pre>${err.message}</pre>`);
  }
});

/**
 * Persist a demo request to DPD. Called fire-and-forget so it runs in parallel
 * with (and never blocks) the Kore callback. Field names are mapped to the DPD
 * schema (DealId, SEName, ProductsUsed, ...).
 */
async function storeToDpd(result) {
  const payload = {
    DealId: result.deal_id,
    DealName: result.deal_name,
    SEName: result.se_email,
    AEName: result.ae_email,
    ProductsUsed: result.products,
    ChannelsUsed: result.channels,
    DryRunDate: result.dry_run_date,
    DemoDate: result.demo_date,
    DemoType: result.demo_type,
    ThirdParty: result.third_party,
    DemoRegion: result.demo_region,
  };

  const resp = await axios.post(process.env.DPD_URL, payload, {
    headers: {
      Authorization: process.env.DPD_AUTH,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });

  console.log("Stored to DPD:", resp.data?.id || resp.status);
  return resp.data;
}

/**
 * Branded confirmation page shown after a successful submission. Mirrors the
 * kore.ai styling used on the form.
 */
function successPage() {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Request Submitted · Agent Platform</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;600;700&display=swap" rel="stylesheet" />
    <style>
      :root {
        --bg: #f7f7f8;
        --card: #ffffff;
        --line: #e8e8ec;
        --ink: #18181b;
        --muted: #6e6e78;
        --ok: #16a34a;
        --ok-soft: rgba(22, 163, 74, 0.1);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0; min-height: 100vh;
        font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: var(--ink); background: var(--bg);
        -webkit-font-smoothing: antialiased;
        display: flex; align-items: center; justify-content: center;
        padding: 40px 16px;
      }
      .card {
        width: 100%; max-width: 440px; text-align: center;
        background: var(--card); border: 1px solid var(--line); border-radius: 16px;
        box-shadow: 0 1px 2px rgba(24,24,27,0.04), 0 12px 32px -20px rgba(24,24,27,0.18);
        padding: 42px 34px 34px;
        animation: rise 0.45s cubic-bezier(0.16, 1, 0.3, 1) both;
      }
      @keyframes rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
      .check {
        width: 64px; height: 64px; margin: 0 auto 20px;
        border-radius: 50%; background: var(--ok-soft);
        display: grid; place-items: center;
      }
      .check svg { width: 30px; height: 30px; }
      .check svg path {
        stroke: var(--ok); stroke-width: 2.6; fill: none;
        stroke-linecap: round; stroke-linejoin: round;
        stroke-dasharray: 30; stroke-dashoffset: 30;
        animation: draw 0.45s ease 0.2s forwards;
      }
      @keyframes draw { to { stroke-dashoffset: 0; } }
      h1 { margin: 0 0 9px; font-size: 20px; font-weight: 600; letter-spacing: -0.3px; }
      p { margin: 0; font-size: 14px; line-height: 1.55; color: var(--muted); }
      .brand {
        margin-top: 26px; padding-top: 18px; border-top: 1px solid var(--line);
        display: inline-flex; align-items: center; gap: 8px;
        font-size: 12.5px; font-weight: 600; color: var(--muted);
      }
      .brand__mark {
        width: 22px; height: 22px; border-radius: 7px;
        background: var(--ink); color: #fff;
        display: grid; place-items: center; font-weight: 700; font-size: 12px;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="check">
        <svg viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5" /></svg>
      </div>
      <h1>Request submitted</h1>
      <p>Your demo request has been received.<br />You can now safely close this page.</p>
      <div class="brand"><span class="brand__mark">k</span><span>Agent Platform</span></div>
    </div>
  </body>
</html>`;
}

/**
 * Email the form link via the SendGrid HTTP API (v3 mail/send).
 *
 * Uses a table-based, fully inline-styled layout so it renders consistently
 * across email clients (Gmail/Outlook strip <style> blocks and ignore
 * flex/grid). Styled to match the Artemis Agent Platform UI. A plaintext part
 * is included as a fallback.
 */
async function sendEmail(to, formLink) {
  const html = emailTemplate(formLink);
  const text = `Complete your demo request using this link:\n${formLink}`;

  const resp = await axios.post(
    "https://api.sendgrid.com/v3/mail/send",
    {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: process.env.SENDGRID_FROM, name: "Agent Platform" },
      subject: "Complete your demo request",
      content: [
        { type: "text/plain", value: text },
        { type: "text/html", value: html },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  // 202 = queued (NOT delivered). Log the message id so it can be traced in the
  // SendGrid Activity Feed if it never lands in the inbox.
  console.log(
    "Form link email queued to",
    to,
    "| status:",
    resp.status,
    "| x-message-id:",
    resp.headers["x-message-id"]
  );
}

/**
 * Branded HTML email body matching the Artemis Agent Platform styling.
 * Table + inline styles for maximum email-client compatibility.
 */
function emailTemplate(formLink) {
  const safeLink = formLink.replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light" />
    <title>Complete your demo request</title>
  </head>
  <body style="margin:0; padding:0; background-color:#f7f7f8;">
    <!-- preheader (hidden preview text) -->
    <div style="display:none; max-height:0; overflow:hidden; opacity:0; color:#f7f7f8; font-size:1px; line-height:1px;">
      Open your demo request form to review and submit the deal details.
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f7f7f8;">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="width:520px; max-width:520px; background-color:#ffffff; border:1px solid #e8e8ec; border-radius:16px; overflow:hidden; font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">

            <!-- Header -->
            <tr>
              <td style="padding:22px 32px; border-bottom:1px solid #e8e8ec;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="width:28px; height:28px; background-color:#18181b; border-radius:8px; text-align:center; vertical-align:middle; color:#ffffff; font-size:15px; font-weight:700;">k</td>
                    <td style="padding-left:10px; color:#6e6e78; font-size:13px; font-weight:600; vertical-align:middle;">Agent Platform&nbsp;&nbsp;/&nbsp;&nbsp;DemoProcess</td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:34px 32px 8px;">
                <h1 style="margin:0 0 12px; font-size:22px; font-weight:600; color:#18181b; letter-spacing:-0.3px;">Complete your demo request</h1>
                <p style="margin:0 0 8px; font-size:14.5px; line-height:1.6; color:#4a4a55;">
                  You've been asked to fill out a demo request. Click the button below to open your form — we'll prefill any details we already have, and you can review or edit everything before submitting.
                </p>
              </td>
            </tr>

            <!-- CTA button (bulletproof) -->
            <tr>
              <td style="padding:20px 32px 8px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="background-color:#18181b; border-radius:11px;">
                      <a href="${safeLink}" target="_blank"
                         style="display:inline-block; padding:13px 26px; font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:14.5px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:11px;">
                        Open demo request form
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Fallback link -->
            <tr>
              <td style="padding:16px 32px 30px;">
                <p style="margin:0 0 6px; font-size:12.5px; color:#8a8a94;">Or copy and paste this link into your browser:</p>
                <a href="${safeLink}" target="_blank" style="font-size:12.5px; color:#6d5ef6; word-break:break-all; text-decoration:none;">${formLink}</a>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="padding:18px 32px; border-top:1px solid #e8e8ec; background-color:#fbfbfc;">
                <p style="margin:0; font-size:12px; color:#8a8a94; line-height:1.5;">
                  This link is specific to your request. If you weren't expecting this email, you can safely ignore it.
                </p>
              </td>
            </tr>

          </table>

          <p style="margin:18px 0 0; font-size:11.5px; color:#a3a3ad; font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">Agent Platform · kore.ai</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * POST the result back to the workflow node's callback URL, signed the way the
 * platform requires (timestamped HMAC + Origin). See header details below.
 */
async function sendCallback(entry, payload) {
  // Kore verifies a timestamped HMAC (confirmed against staging):
  //   x-callback-timestamp : unix time in SECONDS
  //   x-callback-signature : hex( HMAC-SHA256( callbackSecret, `${ts}.${rawBody}` ) )
  // The secret is used as a UTF-8 string, and the signature must cover the EXACT
  // bytes we send — so serialize once and post that same string.
  const rawBody = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000).toString();
  const signature = crypto
    .createHmac("sha256", entry.callbackSecret)
    .update(`${ts}.${rawBody}`, "utf8")
    .digest("hex");

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: process.env.KORE_ORIGIN || "https://agents-staging.kore.ai",
    "x-callback-timestamp": ts,
    "x-callback-signature": signature,
  };

  const resp = await axios.post(entry.callbackUrl, rawBody, { headers });
  console.log("Callback sent:", resp.status);
}

app.get("/", (_req, res) => res.send("Server is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
