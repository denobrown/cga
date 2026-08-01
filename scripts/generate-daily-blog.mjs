#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// CloudGrid Africa — Daily Tech Briefing generator (GitHub Actions version)
// ═══════════════════════════════════════════════════════════════
//
// Runs inside .github/workflows/daily-blog.yml on a daily cron.
// Simpler than the Netlify-scheduled-function version: this script
// just writes files to the already-checked-out repo on disk; the
// workflow commits and pushes them with the automatic, no-setup-
// required GITHUB_TOKEN Actions provides. Netlify then deploys on
// push to main exactly as it already does for every other change —
// no Netlify-side env vars, no PAT, no scheduled-function auth quirks
// (Netlify scheduled functions reject direct/manual invocation, which
// is why the previous version couldn't be tested with curl).
//
// Local/manual test:
//   node scripts/generate-daily-blog.mjs
// then check `git status` — it should show new/changed files under
// blog/. Nothing is committed by this script; the workflow does that.
// ═══════════════════════════════════════════════════════════════

import fs from 'node:fs/promises';
import path from 'node:path';

const SITE = 'https://cloudgridafrica.com';
const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');

const LANES = {
  africa: { label: 'Africa & Kenya Tech', sources: [
    { url: 'https://techcabal.com/feed/', name: 'TechCabal' },
    { url: 'https://techpoint.africa/feed', name: 'Techpoint Africa' },
    { url: 'https://disrupt-africa.com/feed/', name: 'Disrupt Africa' }
  ]},
  security: { label: 'Security', sources: [
    { url: 'https://www.bleepingcomputer.com/feed/', name: 'Bleeping Computer' },
    { url: 'https://krebsonsecurity.com/feed/', name: 'Krebs on Security' },
    { url: 'https://www.darkreading.com/rss.xml', name: 'Dark Reading' }
  ]},
  global: { label: 'Global Tech & Cloud', sources: [
    { url: 'https://techcrunch.com/feed/', name: 'TechCrunch' },
    { url: 'https://feeds.arstechnica.com/arstechnica/index', name: 'Ars Technica' },
    { url: 'https://aws.amazon.com/blogs/aws/feed/', name: 'AWS Blog' }
  ]}
};

function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const block of blocks.slice(0, 8)) {
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      if (!m) return '';
      return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    };
    let link = get('link');
    if (!link) { const lm = block.match(/<link[^>]+href=["']([^"']+)["']/i); link = lm ? lm[1] : ''; }
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
      all.push(...parseFeed(xml).map((it) => ({ ...it, sourceName: src.name })));
    } catch (e) {
      console.warn(`[daily-briefing] source failed: ${src.name} — ${e.message}`);
    }
  }
  all.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  return all;
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function summarize(desc) {
  const clean = (desc || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Read the full story at the source below.';
  const one = clean.split(/(?<=[.!?])\s/)[0];
  return one.length > 220 ? one.slice(0, 217) + '…' : one;
}

function renderPostHTML({ title, dateISO, dateHuman, stories, slug }) {
  const storiesHtml = stories.map((s) => `
    <article class="post-story">
      <p class="post-story-src">${esc(s.laneLabel)} · ${esc(s.sourceName)}</p>
      <h2 class="post-story-h">${esc(s.title)}</h2>
      <p class="post-story-p">${esc(s.summary)}</p>
      <a class="post-story-link" href="${encodeURI(s.link)}" target="_blank" rel="nofollow noopener noreferrer">Read the full story at ${esc(s.sourceName)} →</a>
    </article>`).join('\n');
  const jsonLd = {
    "@context": "https://schema.org", "@type": "BlogPosting", "headline": title,
    "datePublished": dateISO, "dateModified": dateISO,
    "author": { "@type": "Person", "name": "Denis Murila", "jobTitle": "Founder & Lead Cloud Architect, CloudGrid Africa" },
    "publisher": { "@type": "Organization", "name": "CloudGrid Africa", "logo": { "@type": "ImageObject", "url": `${SITE}/logo.jpg` } },
    "mainEntityOfPage": `${SITE}/blog/posts/${slug}.html`,
    "description": `Daily tech briefing covering ${stories.map(s => s.laneLabel).join(', ')} for East African business leaders.`
  };
  return `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover"/>
<title>${esc(title)} | CloudGrid Africa Blog</title>
<meta name="description" content="${esc(`Daily tech briefing — ${stories.map(s => s.title).join(' · ').slice(0, 150)}`)}"/>
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

async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
}

async function main() {
  const manifestPath = path.join(ROOT, 'blog/manifest.json');
  const postsPath = path.join(ROOT, 'blog/posts.json');
  const manifest = await readJson(manifestPath, { publishedLinks: [] });
  const seen = new Set(manifest.publishedLinks || []);

  const chosen = [];
  for (const laneKey of Object.keys(LANES)) {
    const lane = LANES[laneKey];
    const items = await fetchLaneItems(lane);
    const fresh = items.find((it) => it.link && !seen.has(it.link));
    if (fresh) {
      chosen.push({ laneLabel: lane.label, title: fresh.title, link: fresh.link, sourceName: fresh.sourceName, summary: summarize(fresh.desc) });
      seen.add(fresh.link);
    }
  }

  if (chosen.length === 0) {
    console.warn('[daily-briefing] no fresh stories found — nothing to publish today');
    return;
  }

  const now = new Date();
  const dateISO = now.toISOString();
  const dateHuman = now.toLocaleDateString('en-KE', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Africa/Nairobi' });
  const title = `Daily Tech Briefing — ${dateHuman}`;
  const slug = `daily-briefing-${now.toISOString().slice(0, 10)}`;

  const html = renderPostHTML({ title, dateISO, dateHuman, stories: chosen, slug });
  await fs.mkdir(path.join(ROOT, 'blog/posts'), { recursive: true });
  await fs.writeFile(path.join(ROOT, `blog/posts/${slug}.html`), html, 'utf8');

  manifest.publishedLinks = Array.from(seen).slice(-500);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const postsJson = await readJson(postsPath, { posts: [] });
  postsJson.posts = postsJson.posts || [];
  postsJson.posts.unshift({ slug, title, dateISO, dateHuman, excerpt: chosen[0].summary, lanes: chosen.map((c) => c.laneLabel) });
  postsJson.posts = postsJson.posts.slice(0, 90);
  await fs.writeFile(postsPath, JSON.stringify(postsJson, null, 2) + '\n', 'utf8');

  console.log(`published ${slug} with ${chosen.length} stories`);
}

main().catch((err) => { console.error('[daily-briefing] fatal error', err); process.exit(1); });
