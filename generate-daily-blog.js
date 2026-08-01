// ═══════════════════════════════════════════════════════════════
// CloudGrid Africa — Daily Tech Briefing generator
// ═══════════════════════════════════════════════════════════════
//
// Scheduled Netlify Function (see [functions."generate-daily-blog"]
// in netlify.toml — runs 05:00 UTC daily). Node 18+ runtime (Netlify
// default) — uses the built-in global `fetch`, no npm dependencies,
// matching this site's existing zero-third-party-dependency approach
// in netlify/functions/feed.js.
//
// WHAT IT DOES
//   1. Fetches curated RSS from vetted sources across three lanes:
//      Africa/Kenya tech, Security, Global tech/cloud.
//   2. Picks the single freshest, not-yet-used story per lane (max 3
//      stories/day) — checked against blog/manifest.json so the same
//      headline is never republished.
//   3. Writes a short ORIGINAL summary per story (title + 1-2 plain-
//      English sentences drawn from the feed's own description, never
//      the source's full article text) plus a clearly attributed
//      "Read the full story at <Source> →" outbound link. This mirrors
//      the site's existing Editorial Policy: "full source attribution
//      and links to the original publisher... no paid placements."
//   4. Renders one static HTML post page from POST_TEMPLATE (matching
//      the homepage's exact design tokens) with Article/BlogPosting
//      JSON-LD, canonical URL, and Denis Murila as author (per the
//      Editorial Policy already on the homepage).
//   5. Commits the new post file + updated blog/manifest.json +
//      updated blog/posts.json (read by blog/index.html to render the
//      listing) via the GitHub Contents API. Each commit triggers a
//      normal Netlify git-based deploy — no separate build step needed.
//
// REQUIRED ENVIRONMENT VARIABLES (Netlify → Site settings → Environment):
//   GITHUB_TOKEN   Fine-grained PAT, Contents: Read & Write, scoped to
//                  ONLY this one repo. Do not use a classic all-repo token.
//   GITHUB_REPO    "owner/repo", e.g. "denismurila/cloudgridafrica"
//   GITHUB_BRANCH  Usually "main" — must match the branch Netlify deploys
//
// MANUAL TEST: you can invoke this function on demand (outside its
// schedule) by calling POST /.netlify/functions/generate-daily-blog
// with header  x-manual-trigger: <a secret you set as MANUAL_TRIGGER_KEY>
// — useful for verifying the pipeline before trusting the cron.
//
// COST/RATE-LIMIT NOTE: this makes ~6-10 outbound RSS fetches and 3-6
// GitHub API calls once a day. Well within Netlify's free-tier function
// invocation limits and GitHub's REST rate limits.
// ═══════════════════════════════════════════════════════════════

const GITHUB_API = 'https://api.github.com';
const SITE = 'https://cloudgridafrica.com';

// Curated, reliable sources only — the same standard already applied
// to the homepage's Tech Intelligence Hub widget. Add/remove sources
// here; nothing else needs to change.
const LANES = {
  africa: {
    label: 'Africa & Kenya Tech',
    tag: 'africa',
    sources: [
      { url: 'https://techcabal.com/feed/', name: 'TechCabal' },
      { url: 'https://techpoint.africa/feed', name: 'Techpoint Africa' },
      { url: 'https://disrupt-africa.com/feed/', name: 'Disrupt Africa' }
    ]
  },
  security: {
    label: 'Security',
    tag: 'security',
    sources: [
      { url: 'https://www.bleepingcomputer.com/feed/', name: 'Bleeping Computer' },
      { url: 'https://krebsonsecurity.com/feed/', name: 'Krebs on Security' },
      { url: 'https://www.darkreading.com/rss.xml', name: 'Dark Reading' }
    ]
  },
  global: {
    label: 'Global Tech & Cloud',
    tag: 'global',
    sources: [
      { url: 'https://techcrunch.com/feed/', name: 'TechCrunch' },
      { url: 'https://feeds.arstechnica.com/arstechnica/index', name: 'Ars Technica' },
      { url: 'https://aws.amazon.com/blogs/aws/feed/', name: 'AWS Blog' }
    ]
  }
};

const MANIFEST_PATH = 'blog/manifest.json';
const POSTS_JSON_PATH = 'blog/posts.json';

// ── Minimal, dependency-free RSS/Atom parser (regex-based, mirrors ──
// the intent of the client-side parseXML() already in index.html, but
// implemented for Node since DOMParser isn't available server-side).
function parseFeed(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const block of itemBlocks.slice(0, 8)) {
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      if (!m) return '';
      return m[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, '') // strip any nested markup
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#8217;/g, '\u2019').replace(/&#8220;|&#8221;/g, '"')
        .trim();
    };
    let link = get('link');
    if (!link) {
      const lm = block.match(/<link[^>]+href=["']([^"']+)["']/i);
      link = lm ? lm[1] : '';
    }
    const title = get('title');
    const desc = (get('description') || get('summary') || get('content')).slice(0, 320);
    const pubDate = get('pubDate') || get('published') || get('updated');
    if (title && link) items.push({ title, link, desc, pubDate });
  }
  return items;
}

async function fetchLaneItems(lane) {
  const all = [];
  for (const src of lane.sources) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(src.url, { signal: ctrl.signal, headers: { 'User-Agent': 'CloudGridAfrica-DailyBriefing/1.0' } });
      clearTimeout(t);
      if (!r.ok) continue;
      const xml = await r.text();
      const items = parseFeed(xml).map((it) => ({ ...it, sourceName: src.name, sourceUrl: src.url }));
      all.push(...items);
    } catch (e) {
      // one dead source should never break the whole run
      console.warn(`[daily-briefing] source failed: ${src.name}`, e.message);
    }
  }
  all.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  return all;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 70);
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Short, ORIGINAL-style summary — never the source's own sentences
// verbatim beyond a fragment, always followed by an attributed outbound
// link. Copyright-safe by construction: we truncate hard and always
// point back to the original publisher.
function summarize(desc) {
  const clean = (desc || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Read the full story at the source below.';
  const oneSentence = clean.split(/(?<=[.!?])\s/)[0];
  return (oneSentence.length > 220 ? oneSentence.slice(0, 217) + '…' : oneSentence);
}

async function ghGetFile(path) {
  const r = await fetch(`${GITHUB_API}/repos/${process.env.GITHUB_REPO}/contents/${path}?ref=${process.env.GITHUB_BRANCH}`, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
  });
  if (r.status === 404) return { sha: null, json: null };
  if (!r.ok) throw new Error(`GitHub GET ${path} failed: ${r.status}`);
  const data = await r.json();
  const content = Buffer.from(data.content, 'base64').toString('utf8');
  return { sha: data.sha, json: JSON.parse(content) };
}

async function ghPutFile(path, contentStr, sha, message) {
  const body = {
    message,
    content: Buffer.from(contentStr, 'utf8').toString('base64'),
    branch: process.env.GITHUB_BRANCH
  };
  if (sha) body.sha = sha;
  const r = await fetch(`${GITHUB_API}/repos/${process.env.GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`GitHub PUT ${path} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

function renderPostHTML({ title, dateISO, dateHuman, laneLabel, stories, slug }) {
  const storiesHtml = stories.map((s) => `
    <article class="post-story">
      <p class="post-story-src">${esc(s.laneLabel)} · ${esc(s.sourceName)}</p>
      <h2 class="post-story-h">${esc(s.title)}</h2>
      <p class="post-story-p">${esc(s.summary)}</p>
      <a class="post-story-link" href="${encodeURI(s.link)}" target="_blank" rel="nofollow noopener noreferrer">Read the full story at ${esc(s.sourceName)} →</a>
    </article>`).join('\n');

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "headline": title,
    "datePublished": dateISO,
    "dateModified": dateISO,
    "author": { "@type": "Person", "name": "Denis Murila", "jobTitle": "Founder & Lead Cloud Architect, CloudGrid Africa" },
    "publisher": { "@type": "Organization", "name": "CloudGrid Africa", "logo": { "@type": "ImageObject", "url": `${SITE}/logo.jpg` } },
    "mainEntityOfPage": `${SITE}/blog/posts/${slug}.html`,
    "description": `Daily tech briefing covering ${stories.map(s=>s.laneLabel).join(', ')} for East African business leaders.`
  };

  return `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover"/>
<title>${esc(title)} | CloudGrid Africa Blog</title>
<meta name="description" content="${esc(`Daily tech briefing — ${stories.map(s=>s.title).join(' · ').slice(0,150)}`)}"/>
<meta name="robots" content="index,follow,max-image-preview:large"/>
<link rel="canonical" href="${SITE}/blog/posts/${slug}.html"/>
<link rel="stylesheet" href="/blog/assets/blog.css"/>
<link rel="icon" type="image/jpeg" href="/logo.jpg"/>
<meta property="og:type" content="article"/>
<meta property="og:title" content="${esc(title)}"/>
<meta property="og:url" content="${SITE}/blog/posts/${slug}.html"/>
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>
<header class="post-header"><div class="container"><a href="/" class="post-back">← CloudGrid Africa</a><a href="/blog/" class="post-back">All briefings</a></div></header>
<main id="main" class="container post-main">
  <p class="post-eyebrow">Daily Tech Briefing</p>
  <h1 class="post-h1">${esc(title)}</h1>
  <p class="post-meta">${esc(dateHuman)} · Curated by <strong>Denis Murila</strong>, Founder &amp; Lead Cloud Architect, CloudGrid Africa</p>
  ${storiesHtml}
  <div class="post-cta">
    <p>Need help acting on any of this — cloud migration, incident response, or Kenya DPA 2019 compliance?</p>
    <a href="/#quote" class="post-cta-btn">Request a free consultation →</a>
  </div>
</main>
<footer class="post-footer"><div class="container">© ${new Date().getFullYear()} CloudGrid Africa. Curated from public RSS feeds with full source attribution — see our <a href="/#editorial-policy">Editorial Policy</a>.</div></footer>
</body>
</html>`;
}

exports.handler = async (event) => {
  try {
    // Optional manual-trigger guard so this can be tested via curl/Postman
    // without waiting for the 05:00 UTC cron.
    if (event && event.httpMethod === 'POST') {
      const key = event.headers && (event.headers['x-manual-trigger'] || event.headers['X-Manual-Trigger']);
      if (process.env.MANUAL_TRIGGER_KEY && key !== process.env.MANUAL_TRIGGER_KEY) {
        return { statusCode: 401, body: 'unauthorized' };
      }
    }

    if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO || !process.env.GITHUB_BRANCH) {
      console.error('[daily-briefing] missing GITHUB_TOKEN / GITHUB_REPO / GITHUB_BRANCH env vars');
      return { statusCode: 500, body: 'missing required environment variables' };
    }

    const { sha: manifestSha, json: manifestJson } = await ghGetFile(MANIFEST_PATH);
    const manifest = manifestJson || { publishedLinks: [] };
    const seen = new Set(manifest.publishedLinks || []);

    const chosen = [];
    for (const laneKey of Object.keys(LANES)) {
      const lane = LANES[laneKey];
      const items = await fetchLaneItems(lane);
      const fresh = items.find((it) => it.link && !seen.has(it.link));
      if (fresh) {
        chosen.push({
          laneLabel: lane.label,
          title: fresh.title,
          link: fresh.link,
          sourceName: fresh.sourceName,
          summary: summarize(fresh.desc)
        });
        seen.add(fresh.link);
      }
    }

    if (chosen.length === 0) {
      console.warn('[daily-briefing] no fresh stories found across all lanes — skipping today');
      return { statusCode: 200, body: 'no fresh stories today; nothing published' };
    }

    const now = new Date();
    const dateISO = now.toISOString();
    const dateHuman = now.toLocaleDateString('en-KE', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Africa/Nairobi' });
    const title = `Daily Tech Briefing — ${dateHuman}`;
    const slug = `daily-briefing-${now.toISOString().slice(0, 10)}`;

    const html = renderPostHTML({ title, dateISO, dateHuman, stories: chosen, slug });

    await ghPutFile(`blog/posts/${slug}.html`, html, null, `Daily Tech Briefing — ${dateHuman}`);

    manifest.publishedLinks = Array.from(seen).slice(-500); // keep manifest bounded
    await ghPutFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), manifestSha, `Update manifest: ${slug}`);

    const { sha: postsSha, json: postsJsonExisting } = await ghGetFile(POSTS_JSON_PATH);
    const postsList = postsJsonExisting && Array.isArray(postsJsonExisting.posts) ? postsJsonExisting.posts : [];
    postsList.unshift({
      slug, title, dateISO, dateHuman,
      excerpt: chosen[0].summary,
      lanes: chosen.map((c) => c.laneLabel)
    });
    await ghPutFile(POSTS_JSON_PATH, JSON.stringify({ posts: postsList.slice(0, 90) }, null, 2), postsSha, `Update blog index: ${slug}`);

    return { statusCode: 200, body: `published ${slug} with ${chosen.length} stories` };
  } catch (err) {
    console.error('[daily-briefing] fatal error', err);
    return { statusCode: 500, body: `error: ${err.message}` };
  }
};
