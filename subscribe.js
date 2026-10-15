// Vercel serverless function — POST /api/subscribe
// The EmailOctopus API key stays on the server (Vercel env vars), never in the page.
//   EMAILOCTOPUS_API_KEY   your EmailOctopus API key
//   EMAILOCTOPUS_LIST_ID   the list ID for the book waitlist

const EO_BASE = "https://emailoctopus.com/api/1.6";
const TAG = "come-into-me-waitlist";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (v, max) => String(v ?? "").trim().slice(0, max);

// Supports both EmailOctopus key styles:
//   newer keys start with "eo_"  -> API v2 (Bearer auth, upsert)
//   older keys have no prefix    -> API v1.6 (key in body)
async function addContact(apiKey, listId, payload) {
  const isV2 = apiKey.startsWith("eo_");
  const url = isV2
    ? `https://api.emailoctopus.com/lists/${encodeURIComponent(listId)}/contacts`
    : `${EO_BASE}/lists/${encodeURIComponent(listId)}/contacts`;
  const r = await fetch(url, {
    method: isV2 ? "PUT" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(isV2 ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(isV2 ? payload : { api_key: apiKey, ...payload }),
  });
  const data = await r.json().catch(() => ({}));
  return { r, data, code: data?.error?.code || data?.code };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  const { EMAILOCTOPUS_API_KEY: apiKey, EMAILOCTOPUS_LIST_ID: listId } = process.env;
  if (!apiKey || !listId) {
    console.error("Missing EMAILOCTOPUS_API_KEY or EMAILOCTOPUS_LIST_ID");
    return res.status(500).json({ ok: false, error: "Signup isn't set up yet." });
  }

  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  // Honeypot — real people never fill this in. Pretend it worked.
  if (clean(body.company, 200)) return res.status(200).json({ ok: true });

  const email = clean(body.email, 254).toLowerCase();
  const firstName = clean(body.firstName, 80);
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: "That email doesn't look right." });
  }

  // status omitted on purpose: EmailOctopus follows the list's own opt-in setting.
  const isV2 = apiKey.startsWith("eo_");
  const email_address = email;
  // Try the tag in each format EmailOctopus has used; as a last resort add the
  // contact without a tag so a signup is never lost over a label.
  const variants = isV2
    ? [{ tags: { [TAG]: true } }, { tags: [TAG] }, {}]
    : [{ tags: [TAG] }, {}];

  let last = null;
  try {
    for (const v of variants) {
      const out = await addContact(apiKey, listId, { email_address, ...v });
      last = out;
      if (out.r.ok) return res.status(200).json({ ok: true });
      if (out.code === "MEMBER_EXISTS_WITH_EMAIL_ADDRESS") return res.status(200).json({ ok: true, already: true });
      // Wrong key / list: no point trying other formats.
      if ([401, 403, 404].includes(out.r.status)) break;
    }
    console.error("EmailOctopus error", last?.r.status, last?.code, JSON.stringify(last?.data).slice(0, 300));
    return res.status(502).json({
      ok: false,
      error: "Something snagged on our side. Try again in a moment.",
      detail: `${last?.r.status || ""} ${last?.code || ""}`.trim(),
    });
  } catch (err) {
    console.error("EmailOctopus request failed", err);
    return res.status(502).json({ ok: false, error: "Something snagged on our side. Try again in a moment.", detail: "network" });
  }
}
