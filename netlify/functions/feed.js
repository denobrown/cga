// ═══════════════════════════════════════════════════════════════
// CloudGrid Africa — RSS feed proxy
// ═══════════════════════════════════════════════════════════════
//
// Backs the homepage's Tech Intelligence Hub widget (the client JS
// calls /.netlify/functions/feed?url=<encoded RSS URL>). Exists
// because RSS feeds don't send CORS headers, so the browser can't
// fetch them directly — this function fetches server-side (no CORS
// restriction applies to server-to-server requests) and hands the
// raw XML back to the browser as same-origin content.
//
// SECURITY: this takes a URL as a query parameter and fetches it
// server-side — without restriction, that's an open proxy / SSRF
// vector (anyone could use this endpoint to make your Netlify
// function fetch arbitrary internal or external URLs). Locked down
// to an explicit allowlist of the exact source hosts the widget
// actually uses, matching FEEDS in index.html. Add a host here only
// when you add it to FEEDS on the homepage too — keep the two in sync.

const ALLOWED_HOSTS = new Set([
  'aws.amazon.com',
  'azure.microsoft.com',
  'disrupt-africa.com',
  'feeds.arstechnica.com',
  'feeds.bbci.co.uk',
  'krebsonsecurity.com',
  'techcabal.com',
  'techcrunch.com',
  'techpoint.africa',
  'venturebeat.com',
  'www.bleepingcomputer.com',
  'www.darkreading.com'
]);

exports.handler = async (event) => {
  const target = event.queryStringParameters && event.queryStringParameters.url;

  if (!target) {
    return { statusCode: 400, body: 'missing url parameter' };
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch (e) {
    return { statusCode: 400, body: 'invalid url' };
  }

  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
    return { statusCode: 403, body: 'host not allowed' };
  }

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 9000);
    const r = await fetch(parsed.href, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'CloudGridAfrica-TechIntelHub/1.0' }
    });
    clearTimeout(timeout);

    if (!r.ok) {
      return { statusCode: r.status, body: `upstream returned ${r.status}` };
    }

    const xml = await r.text();
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        // short edge cache so many visitors hitting the homepage in the
        // same few minutes don't each trigger a fresh upstream fetch
        'Cache-Control': 'public, max-age=600'
      },
      body: xml
    };
  } catch (err) {
    console.error('[feed proxy] fetch failed for', parsed.hostname, err.message);
    return { statusCode: 502, body: 'upstream fetch failed' };
  }
};
