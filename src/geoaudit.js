import fs from 'fs';
import path from 'path';
import { URL, fileURLToPath } from 'url';
import { load } from 'cheerio';
import { ScrapingCrawl } from '@scrapeless-ai/sdk';

// -------------------- CONFIG --------------------
const TARGET_URL = process.argv[2] || '';
const SCRAPING_KEY = process.env.SCRAPING_KEY || process.env.SCRAPING_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.CHATGPT_KEY || '';
const GENERATE_PDF = process.env.GENERATE_PDF === '1' || process.env.GENERATE_PDF === 'true';

// Simple weights for static checks (tunable)
const WEIGHTS = {
  lang: 5, charset: 3, viewport: 4, title: 10, description: 10,
  h1: 6, canonical: 8, robots: 8, json_ld: 12, local_schema: 12,
  images_alt: 6, geo: 16
};

// -------------------- Utilities --------------------
function ensureReportsDir() {
  const reportsDir = path.resolve(process.cwd(), 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  return reportsDir;
}

function extractHtmlFromResponse(resp) {
  if (!resp) return null;
  if (typeof resp === 'string' && resp.trim().startsWith('<')) return resp;
  const tryPaths = [
    resp?.html,
    resp?.data?.html,
    resp?.data?.body,
    resp?.data,
    resp?.results?.[0]?.html,
    resp?.results?.[0]?.payload?.html,
    resp?.output?.html
  ];
  for (const c of tryPaths) {
    if (!c) continue;
    if (typeof c === 'string' && c.trim().startsWith('<')) return c;
    if (typeof c === 'object' && c.html && typeof c.html === 'string' && c.html.trim().startsWith('<')) return c.html;
  }
  try {
    const s = JSON.stringify(resp);
    const idx = s.indexOf('<!DOCTYPE') !== -1 ? s.indexOf('<!DOCTYPE') : s.indexOf('<html');
    if (idx !== -1) {
      return s.slice(idx).replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }
  } catch (e) {}
  return null;
}

// -------------------- Static Analyzer --------------------
function analyzeHtml(html) {
  const $ = load(html || '');
  const report = { checks: {}, total_awarded: 0, total_possible: 0, suggestions: [] };

  function addCheck(key, ok, pointsIfOk, detail = null, advice = null, priority = 'low') {
    const max = WEIGHTS[key] || 0;
    const awarded = ok ? pointsIfOk : 0;
    report.checks[key] = { ok: !!ok, points: awarded, max_points: max, detail, advice, priority };
    report.total_awarded += awarded;
    report.total_possible += max;
    if (!ok && advice) report.suggestions.push({ key, priority, advice, detail });
  }

  addCheck('lang', !!$('html').attr('lang'), WEIGHTS.lang, { lang: $('html').attr('lang') || null }, 'Add <html lang="..."> (BCP47)', 'low');
  addCheck('charset', !!$('meta[charset]').attr('charset'), WEIGHTS.charset, { charset: $('meta[charset]').attr('charset') || null }, 'Add <meta charset="utf-8">', 'low');
  addCheck('viewport', !!$('meta[name="viewport"]').attr('content'), WEIGHTS.viewport, null, 'Add viewport meta', 'low');

  const title = ($('title').text() || '').trim();
  addCheck('title', title.length >= 10, WEIGHTS.title, { title, length: title.length }, 'Keep title 30-60 chars', 'high');

  const desc = ($('meta[name="description"]').attr('content') || '').trim();
  addCheck('description', desc.length >= 20, (desc.length >= 50 && desc.length <= 160) ? WEIGHTS.description : Math.round(WEIGHTS.description / 2), { description: desc, length: desc.length }, 'Meta description 50-160 chars', 'high');

  const h1Count = $('h1').length;
  addCheck('h1', h1Count >= 1, h1Count === 1 ? WEIGHTS.h1 : Math.round(WEIGHTS.h1 * 0.5), { h1_count: h1Count }, 'Exactly one H1 preferred', 'medium');

  const canonical = $('link[rel="canonical"]').attr('href') || null;
  addCheck('canonical', !!canonical, WEIGHTS.canonical, { href: canonical }, 'Add canonical link', 'high');

  const robots = (($('meta[name="robots"]').attr('content') || '')).toLowerCase();
  addCheck('robots', !robots.includes('noindex'), WEIGHTS.robots, { robots }, 'Remove noindex if you want indexing', 'high');

  // JSON-LD
  const jsonLdNodes = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const raw = $(el).contents().text();
      if (raw && raw.trim()) jsonLdNodes.push(JSON.parse(raw));
    } catch (e) {
      jsonLdNodes.push('invalid-json');
    }
  });
  addCheck('json_ld', jsonLdNodes.length > 0, WEIGHTS.json_ld, { count: jsonLdNodes.length }, 'Add JSON-LD structured data', 'medium');

  // Local schema detection
  let hasLocal = false;
  for (const node of jsonLdNodes) {
    if (node && typeof node === 'object') {
      const arr = Array.isArray(node) ? node : [node];
      for (const n of arr) {
        const t = n['@type'] || n.type || '';
        if (typeof t === 'string' && /localbusiness|organization|place/i.test(t)) hasLocal = true;
        if (n.address || n.telephone) hasLocal = true;
      }
    }
  }
  addCheck('local_schema', hasLocal, WEIGHTS.local_schema, null, 'Add LocalBusiness schema with address/telephone', 'high');

  // Images alt ratio
  const imgs = $('img').toArray();
  if (imgs.length === 0) {
    addCheck('images_alt', true, WEIGHTS.images_alt, { total: 0, withAlt: 0, ratio: 1 }, null, 'low');
  } else {
    const withAlt = imgs.filter(i => ($(i).attr('alt') || '').trim().length > 0).length;
    const ratio = withAlt / imgs.length;
    addCheck('images_alt', ratio >= 0.8, Math.round(WEIGHTS.images_alt * (ratio >= 0.8 ? 1 : ratio)), { total: imgs.length, withAlt, ratio: Number(ratio.toFixed(2)) }, 'Add alt attributes for images (aim >=80%)', 'medium');
  }

  // Geo meta / phone / coords
  const geoMeta = {};
  $('meta').each((i, el) => {
    const name = (($(el).attr('name') || '') + '').toLowerCase();
    if (name.startsWith('geo') || name === 'og:locale' || name === 'og:site_name') geoMeta[name] = $(el).attr('content') || null;
  });
  const bodyText = $('body').text() || '';
  const phoneMatches = [...(bodyText.matchAll(/(\+?\d[\d\-\s]{6,}\d)/g) || [])].map(m => m[0]);
  const coordMatches = [...(bodyText.matchAll(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/g) || [])].map(m => `${m[1]},${m[2]}`);
  const hasGeo = Object.keys(geoMeta).length > 0 || phoneMatches.length > 0 || coordMatches.length > 0;
  addCheck('geo', hasGeo, WEIGHTS.geo, { geoMeta, phones: phoneMatches.slice(0, 3), coords: coordMatches.slice(0, 3) }, 'Add geo meta / phone / coords for local signals', 'medium');

  const totalPossible = report.total_possible || 1;
  report.summary = { score: Math.round((report.total_awarded / totalPossible) * 10000) / 100, total_awarded: report.total_awarded, total_possible: totalPossible };
  const prioMap = { high: 3, medium: 2, low: 1 };
  report.suggestions = report.suggestions.sort((a, b) => prioMap[b.priority] - prioMap[a.priority]);
  return report;
}

// -------------------- AI function-calling --------------------
async function callOpenAIWithSchema(systemPrompt, userPrompt, rawHtmlSnippet, prelim) {
  if (!OPENAI_API_KEY) {
    console.warn('OPENAI_API_KEY not set — skipping AI step.');
    return null;
  }

  const functionDef = {
    name: 'ai_audit_result',
    description: 'Return strict JSON for AI audit results for single-page SEO+GEO audit',
    parameters: {
      type: 'object',
      properties: {
        seo_score: { type: 'number' },
        geo_score: { type: 'number' },
        ai_score_breakdown: { type: 'object', additionalProperties: { type: 'number' } },
        ai_missing: { type: 'array', items: { type: 'string' } },
        ai_suggestions: { type: 'array', items: { type: 'object' } },
        ai_fix_snippets: { type: 'object', additionalProperties: { type: 'string' } },
        notes: { type: 'string' }
      }
    }
  };

  const body = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
      { role: 'user', content: `Prelim JSON summary:\n${JSON.stringify(prelim, null, 2)}\n\nHTML snippet (truncated):\n${rawHtmlSnippet}` }
    ],
    functions: [functionDef],
    function_call: { name: 'ai_audit_result' },
    temperature: 0.0,
    max_tokens: 1200
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const message = data.choices?.[0]?.message;
  if (message?.function_call?.arguments) {
    try { return JSON.parse(message.function_call.arguments); } catch (e) { return { raw: message.function_call.arguments, parseError: e.toString() }; }
  }
  if (message?.content) {
    try {
      const t = message.content;
      const jstart = t.indexOf('{'), jend = t.lastIndexOf('}');
      if (jstart !== -1 && jend !== -1) return JSON.parse(t.slice(jstart, jend + 1));
    } catch (e) {
      return { raw: message.content, parseError: e.toString() };
    }
  }
  return { raw: data };
}

// -------------------- Lightweight hints extraction --------------------
function computeHintsFromHtml(html, prelim) {
  const $ = load(html || '');
  const htmlLower = (html || '').toLowerCase();
  const foundFiles = {
    llmsTxt: /llms?\.txt/.test(htmlLower),
    robotsTxt: /robots\.txt/.test(htmlLower),
    hreflang: /rel\s*=\s*"alternate"\s+hreflang/.test(htmlLower)
  };

  const headings = [];
  $('h1,h2,h3,h4,h5,h6').each((i, el) => {
    const tag = el.tagName.toLowerCase();
    headings.push(parseInt(tag.replace('h',''), 10));
  });
  const headingIssues = [];
  if (headings.length > 1) {
    let last = headings[0];
    for (let i = 1; i < headings.length; i++) {
      const cur = headings[i];
      if (cur - last > 1) headingIssues.push(`Skipped heading level (H${last} → H${cur})`);
      last = cur;
    }
  }

  const bodyText = ($('body').text() || '').replace(/\s+/g, ' ').trim();
  const sentences = bodyText.split(/[.!?]+/).filter(s => s.trim().length > 0).length || 1;
  const wordsArr = bodyText.split(/\s+/).filter(w => w.trim().length > 0);
  const words = wordsArr.length || 1;
  function countSyllables(word) { word = word.toLowerCase().replace(/[^a-z]/g, ''); if (!word) return 0; const vowels='aeiouy'; let syll=0; let prev=false; for(let ch of word){ const isV=vowels.includes(ch); if(isV && !prev) syll++; prev=isV; } if(word.endsWith('e')) syll=Math.max(1,syll-1); if(syll===0) syll=1; return syll; }
  const syllables = wordsArr.reduce((sum,w)=> sum + countSyllables(w), 0) || 1;
  const flesch = Math.round(206.835 - (1.015 * (words / sentences)) - (84.6 * (syllables / words)));
  const readabilityLabel = flesch >= 60 ? 'Easy' : (flesch >= 50 ? 'Fairly easy' : (flesch >= 30 ? 'Difficult' : 'Very difficult'));

  const title = ($('title').text() || '').trim();
  const desc = ($('meta[name="description"]').attr('content') || '').trim();
  const metadataQuality = `${title ? 'Title ✓' : 'Title ✗'}${desc ? ', Description ✓' : ', Description ✗'}`;

  const semanticCount = $('header,nav,main,footer,article,section').length;
  const imgs = $('img').toArray();
  const withAlt = imgs.filter(i => ($(i).attr('alt') || '').trim().length > 0).length;
  const imagesAltRatio = imgs.length ? (withAlt / imgs.length) : 1;
  const ariaPresent = ($('[aria-label],[role],[aria-labelledby],[aria-describedby]').length > 0) || /aria-/.test(htmlLower);

  const paras = $('p').toArray().map(p => ($(p).text()||'').trim()).filter(t => t.length > 0);
  const paraCount = paras.length;
  const avgWordsPerPara = paraCount ? Math.round(paras.reduce((s,p)=>s + p.split(/\s+/).filter(Boolean).length,0)/paraCount) : 0;
  const contentQuality = paraCount >= 3 && avgWordsPerPara >= 40 ? 'Well-structured' : (paraCount === 0 ? 'No paragraph content' : 'Could be improved');

  const jsonLdCount = (prelim?.checks?.json_ld?.detail?.count) || 0;
  const capMatches = [...(bodyText.matchAll(/\b([A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})*)\b/g) || [])].slice(0, 15).map(m => m[0]);
  const topEntities = Array.from(new Set(capMatches)).slice(0,5);
  const crawlScore = prelim?.summary?.score ?? null;
  const aiTrainingValue = (paraCount >= 5 && jsonLdCount > 0 && words > 500) ? 'High' : (words > 200 ? 'Moderate' : 'Low');
  const kgReady = jsonLdCount > 0 ? 'Entities are identifiable; JSON-LD present' : 'Limited - JSON-LD absent';
  const contentCompleteness = paraCount >= 3 && $('h2').length > 0 ? 'Main topics covered' : 'Some sections lack depth';
  const contextCompleteness = (prelim?.checks?.local_schema?.ok || false) ? 'Good contextual signals' : 'Could include more contextual metadata';
  const hreflangCount = $('link[rel="alternate"][hreflang]').length;

  return {
    foundFiles,
    headingIssues,
    readability: { flesch, label: readabilityLabel },
    metadataQuality,
    semanticCount,
    accessibility: { imagesAltRatio: Number(imagesAltRatio.toFixed(2)), ariaPresent },
    contentQuality: { paraCount, avgWordsPerPara, contentQuality },
    jsonLdCount,
    topEntities,
    crawlScore,
    aiTrainingValue,
    kgReady,
    contentCompleteness,
    contextCompleteness,
    hreflangCount
  };
}

// -------------------- GEO scoring (stricter) --------------------
function calculateGeoScore(prelim, hints) {
  const weights = { schema: 30, address: 15, phone: 15, coords: 10, geoMeta: 5, hreflang: 10, localDensity: 10, localSignals: 5 };

  let schemaScore = 0;
  const jsonLdCount = prelim?.checks?.json_ld?.detail?.count || 0;
  const localOk = prelim?.checks?.local_schema?.ok;
  if (localOk) schemaScore = 30; else if (jsonLdCount > 0) schemaScore = 15; else schemaScore = 0;

  let addressScore = 0;
  const addressInJson = localOk;
  if (addressInJson) addressScore = 15; else {
    const bodyHasCity = (hints.topEntities || []).some(t => /city|town|district|avenue|street|road|county|area/i.test(t)) || false;
    addressScore = bodyHasCity ? 6 : 0;
  }

  let phoneScore = 0;
  const phones = prelim?.checks?.geo?.detail?.phones || [];
  if (phones && phones.length > 0) phoneScore = 15;

  let coordsScore = 0;
  const coords = prelim?.checks?.geo?.detail?.coords || [];
  if (coords && coords.length > 0) coordsScore = 10;

  let geoMetaScore = 0;
  const geoMeta = prelim?.checks?.geo?.detail?.geoMeta || {};
  if (geoMeta && Object.keys(geoMeta).length > 0) geoMetaScore = 5;

  let hreflangScore = 0;
  if (hints.hreflangCount && hints.hreflangCount > 0) hreflangScore = 10;

  let localDensityScore = 0;
  const localMentions = (hints.topEntities || []).filter(e => /[A-Z][a-z]{2,}/.test(e)).length;
  if (localMentions >= 3) localDensityScore = 10; else if (localMentions >= 1) localDensityScore = 4;

  let localSignalsScore = 0;
  const signals = ((hints.foundFiles || {}).llmsTxt ? 1 : 0) + (hints.hreflangCount ? 1 : 0) + ((prelim?.checks?.json_ld?.detail?.count > 0) ? 1 : 0);
  if (signals >= 2) localSignalsScore = 5; else if (signals === 1) localSignalsScore = 2;

  const total = schemaScore + addressScore + phoneScore + coordsScore + geoMetaScore + hreflangScore + localDensityScore + localSignalsScore;
  const GEO_SCORE = Math.max(0, Math.min(100, Math.round(total)));
  return { GEO_SCORE, breakdown: { schemaScore, addressScore, phoneScore, coordsScore, geoMetaScore, hreflangScore, localDensityScore, localSignalsScore } };
}

// -------------------- Interactive HTML generator --------------------
async function generateHtmlReport(reportObj, outHtmlPath) {
  const prelim = reportObj.prelim || {};
  const hints = reportObj.hints || {};
  const suggestions = reportObj.ai?.ai_suggestions || (prelim?.suggestions || []);
  const fixSnippets = reportObj.ai?.ai_fix_snippets || {};
  const seoScore = reportObj.ai?.seo_score ?? (prelim?.summary?.score ?? null);
  const geoCalc = calculateGeoScore(prelim, hints);
  const geoScore = reportObj.ai?.geo_score ?? geoCalc.GEO_SCORE;
  const overallScore = (seoScore !== null) ? `${seoScore}%` : (prelim?.summary?.score !== undefined ? `${prelim.summary.score}%` : 'N/A');
  const aiLabel = reportObj.ai ? 'AI Enhanced' : 'Static';

  const html = `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8"/>
      <meta name="viewport" content="width=device-width,initial-scale=1"/>
      <title>GEOReady - Interactive Audit Report</title>
      <style>
        body{font-family:Inter,system-ui,Arial,Helvetica,sans-serif;margin:0;padding:20px;color:#111}
        .container{max-width:1100px;margin:0 auto}
        .header{display:flex;justify-content:space-between;align-items:center}
        .brand{font-weight:800;font-size:20px}
        .meta{color:#666}
        .grid{display:grid;grid-template-columns:1fr 360px;gap:20px;margin-top:18px}
        .card{background:#fff;border:1px solid #eee;padding:14px;border-radius:10px}
        .section-title{font-weight:700;margin-bottom:8px}
        .muted{color:#666;font-size:13px}
        details{margin-bottom:8px}
        pre{background:#f7f7f7;padding:10px;border-radius:6px;overflow:auto}
        .score{display:flex;gap:12px;align-items:center}
        .gauge{width:96px;height:96px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800}
        .high{background:linear-gradient(135deg,#e6f4ea,#c3eec7);color:#0b6a3a}
        .mid{background:linear-gradient(135deg,#fff7e6,#ffefd5);color:#b36b00}
        .low{background:linear-gradient(135deg,#fdecea,#ffd6d6);color:#a10b1b}
        table{width:100%;border-collapse:collapse}
        th,td{padding:8px;border-bottom:1px solid #f0f0f0;text-align:left}
        .priority-HIGH{color:#b00020;font-weight:700}
        .priority-MEDIUM{color:#ff8c00;font-weight:700}
        .priority-LOW{color:#2e7d32;font-weight:700}
        .copyBtn{background:#0b6a3a;color:white;border:none;padding:6px 8px;border-radius:6px;cursor:pointer}
        .small{font-size:12px;color:#555}
        .kpi{display:flex;gap:6px;align-items:center}
        .badge{background:#f3f4f6;padding:6px 8px;border-radius:6px;font-weight:700}
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div>
            <div class="brand">GEOReady Interactive Audit</div>
            <div class="meta">URL: ${escapeHtml(reportObj.url)} · Scanned: ${escapeHtml(reportObj.scrapedAt)}</div>
          </div>
          <div class="score">
            <div style="text-align:center">
              <div class="small muted">SEO Score</div>
              <div class="gauge ${seoScore>=75 ? 'high' : (seoScore>=45?'mid':'low')}">${seoScore!==null?seoScore+'%':'N/A'}</div>
            </div>
            <div style="text-align:center">
              <div class="small muted">GEO Score</div>
              <div class="gauge ${geoScore>=75 ? 'high' : (geoScore>=45?'mid':'low')}">${geoScore!==null?geoScore+'%':'N/A'}</div>
            </div>
          </div>
        </div>

        <div class="grid">
          <div>
            <div class="card">
              <div class="section-title">Executive summary</div>
              <div class="muted">Overall: <strong>${overallScore}</strong> · Type: <strong>${aiLabel}</strong></div>
            </div>

            <div class="card">
              <div class="section-title">Top issues & actions</div>
              ${suggestions && suggestions.length ? `<table><thead><tr><th>Issue</th><th>Priority</th><th>Impact</th></tr></thead><tbody>${suggestions.slice(0,10).map(s => `<tr><td>${escapeHtml(s.key||'Issue')}</td><td class="priority-${(s.priority||'LOW').toUpperCase()}">${(s.priority||'LOW').toUpperCase()}</td><td>${escapeHtml(s.impact||'Medium')}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">No AI suggestions available.</div>'}
            </div>

            <div class="card">
              <div class="section-title">Technical & Accessibility</div>
              <div class="kpi"><div class="badge">Images ALT ${Math.round((hints.accessibility.imagesAltRatio||0)*100)}%</div><div class="badge">ARIA ${hints.accessibility.ariaPresent? 'Yes':'No'}</div><div class="badge">Semantic ${hints.semanticCount}</div></div>

              <details>
                <summary><strong>Headings</strong> — ${hints.headingIssues.length ? 'Issues found' : 'No issues'}</summary>
                <div class="small" style="margin-top:6px">${hints.headingIssues.length ? escapeHtml(hints.headingIssues.join('; ')) : 'All heading levels look fine.'}</div>
              </details>

              <details>
                <summary><strong>Metadata</strong> — ${escapeHtml(hints.metadataQuality)}</summary>
                <div class="small" style="margin-top:6px">Title: ${escapeHtml((prelim?.checks?.title?.detail?.title) || '') || '—'}<br/>Description length: ${prelim?.checks?.description?.detail?.length || 0}</div>
              </details>

              <details>
                <summary><strong>Robots / Crawl</strong></summary>
                <div class="small" style="margin-top:6px">Robots meta: ${escapeHtml(prelim?.checks?.robots?.detail?.robots || 'Not found')}<br/>Robots.txt referenced in page HTML: ${hints.foundFiles.robotsTxt? 'Yes' : 'No'}</div>
              </details>

            </div>

            <div class="card">
              <div class="section-title">Data Structure & Schema</div>
              <div class="muted">JSON-LD blocks detected: ${hints.jsonLdCount}</div>
              <details>
                <summary>JSON-LD preview</summary>
                <div style="margin-top:8px">
                  ${prelim?.checks?.json_ld?.detail?.count ? `<pre>${escapeHtml(JSON.stringify(prelim?.checks?.json_ld?.detail, null, 2))}</pre>` : '<div class="small muted">No JSON-LD parsed from the page.</div>'}
                </div>
              </details>
            </div>

            <div class="card">
              <div class="section-title">Content Readability & Quality</div>
              <div class="small">Reading ease: ${hints.readability.label} (Flesch ${hints.readability.flesch})</div>
              <details>
                <summary>Content quality details</summary>
                <div class="small" style="margin-top:8px">Paragraphs: ${hints.contentQuality.paraCount} · Avg words/para: ${hints.contentQuality.avgWordsPerPara} · ${escapeHtml(hints.contentQuality.contentQuality)}</div>
              </details>
            </div>

          </div>

          <div>
            <div class="card">
              <div class="section-title">Quick checklist (expand to see details)</div>
              <details open><summary><strong>Metadata Quality</strong></summary>
                <div class="small" style="margin-top:6px">${hints.metadataQuality}</div>
              </details>

              <details><summary><strong>Data Structure & Schema</strong></summary>
                <div class="small" style="margin-top:6px">${hints.jsonLdCount > 0 ? 'JSON-LD detected' : 'No JSON-LD detected'}</div>
              </details>

              <details><summary><strong>Robots.txt</strong></summary>
                <div class="small" style="margin-top:6px">Found in HTML: ${hints.foundFiles.robotsTxt ? 'Yes' : 'No'}</div>
              </details>

              <details><summary><strong>Canonical</strong></summary>
                <div class="small" style="margin-top:6px">Canonical: ${escapeHtml(prelim?.checks?.canonical?.detail?.href || 'Not found')}</div>
              </details>

              <details><summary><strong>Hreflang</strong></summary>
                <div class="small" style="margin-top:6px">Count: ${hints.hreflangCount}</div>
              </details>

              <details><summary><strong>Local Schema</strong></summary>
                <div class="small" style="margin-top:6px">Local schema detected: ${prelim?.checks?.local_schema?.ok ? 'Yes' : 'No'}</div>
              </details>

              <details><summary><strong>Images Alt</strong></summary>
                <div class="small" style="margin-top:6px">Alt ratio: ${Math.round((hints.accessibility.imagesAltRatio||0)*100)}%</div>
              </details>

              <details><summary><strong>Content Readability</strong></summary>
                <div class="small" style="margin-top:6px">${hints.readability.label} (Flesch ${hints.readability.flesch})</div>
              </details>
            </div>

            <div class="card">
              <div class="section-title">Action plan (copy & paste fixes)</div>
              ${suggestions && suggestions.length ? `<table><thead><tr><th style="width:60%">Fix</th><th>Priority</th><th>Effort</th></tr></thead><tbody>${suggestions.map(s => `<tr><td><strong>${escapeHtml(s.key)}</strong><div class="small" style="margin-top:6px">${escapeHtml(s.advice || '')}</div>${s.example_fix? `<pre id="fix-${escapeHtml(s.key).replace(/[^a-z0-9]/gi,'')}">${escapeHtml(s.example_fix)}</pre><button class="copyBtn" data-target="fix-${escapeHtml(s.key).replace(/[^a-z0-9]/gi,'')}">复制代码</button>` : ''}</td><td class="priority-${(s.priority||'LOW').toUpperCase()}">${(s.priority||'LOW').toUpperCase()}</td><td>${escapeHtml(s.estimated_effort||'30m')}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">No action items available from AI.</div>'}
            </div>

            <div class="card">
              <div class="section-title">GEO Breakdown</div>
              <div class="small">GEO Score: <strong>${geoScore}%</strong></div>
              <details>
                <summary>Breakdown</summary>
                <div class="small" style="margin-top:8px"><pre>${escapeHtml(JSON.stringify(geoCalc.breakdown, null, 2))}</pre></div>
              </details>
            </div>

            <div class="card">
              <div class="section-title">Raw JSON report</div>
              <details>
                <summary>Download / copy</summary>
                <div style="margin-top:8px"><pre id="rawjson">${escapeHtml(JSON.stringify(reportObj, null, 2))}</pre><button class="copyBtn" data-target="rawjson">复制 JSON</button></div>
              </details>
            </div>

          </div>
        </div>
      </div>

      <script>
        document.addEventListener('click', (e) => {
          if (e.target && e.target.matches('.copyBtn')) {
            const id = e.target.getAttribute('data-target');
            const el = document.getElementById(id);
            if (!el) return;
            const text = el.innerText;
            navigator.clipboard.writeText(text).then(()=>{ e.target.innerText='已复制'; setTimeout(()=>e.target.innerText='复制代码',1200); }, ()=>{ alert('复制失败，请手动复制'); });
          }
        });
      </script>
    </body>
  </html>`;

  fs.writeFileSync(outHtmlPath, html, 'utf8');
}

// -------------------- Optional PDF generation (kept for compatibility) --------------------
async function generatePdfFromReportIfRequested(reportObj, outPdfPath) {
  if (!GENERATE_PDF) return false;
  let puppeteer;
  try { puppeteer = await import('puppeteer'); } catch (e) { console.warn('puppeteer not installed or failed to import — skipping PDF generation'); return false; }
  const tmpHtml = path.join(ensureReportsDir(), `tmp-${Date.now()}.html`);
  await generateHtmlReport(reportObj, tmpHtml);

  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 1300 });
    await page.goto(`file://${tmpHtml}`, { waitUntil: 'networkidle0' });
    await page.pdf({ path: outPdfPath, format: 'A4', printBackground: true });
  } finally {
    await browser.close();
    try { fs.unlinkSync(tmpHtml); } catch (e) {}
  }
  return true;
}

// -------------------- Helper: escape HTML --------------------
function escapeHtml(s) {
  if (s === undefined || s === null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// -------------------- Main Flow --------------------
async function main() {
  if (!TARGET_URL) {
    console.error('No TARGET URL provided. Usage: node geoaudit.optimized.v2.js <url>');
    process.exit(1);
  }
  if (!SCRAPING_KEY) console.warn('Warning: SCRAPING_KEY not set; scrape may fail depending on SDK configuration.');

  const client = new ScrapingCrawl({ apiKey: SCRAPING_KEY });

  console.log('Starting scrape for', TARGET_URL);
  let scrapeResponse;
  try {
    scrapeResponse = await client.scrapeUrl(TARGET_URL, {
      formats: ['html'],
      timeout: 45000,
      browserOptions: {
        proxyCountry: 'US',
        sessionName: 'GeoAudit',
        sessionRecording: true,
        sessionTTL: 3000,
        waitForSelector: 'body',
        headless: true
      }
    });
  } catch (err) {
    console.error('Scrape failed:', err);
    process.exit(2);
  }

  const html = extractHtmlFromResponse(scrapeResponse) || extractHtmlFromResponse(scrapeResponse?.data);
  if (!html) {
    console.error('No HTML extracted. Response (trimmed):', JSON.stringify(scrapeResponse, (k,v) => (typeof v==='string'&&v.length>1000)? v.slice(0,1000)+'...[truncated]': (/(key|token|auth|api)/i.test(k)?'[REDACTED]':v), 2));
    process.exit(3);
  }

  const prelim = analyzeHtml(html);
  const hints = computeHintsFromHtml(html, prelim);

  const htmlSnippet = html.length > 6000 ? html.slice(0, 6000) + '\n\n...[TRUNCATED]' : html;
  const systemPrompt = `You are an expert SEO & local GEO auditor. Produce a concise, prioritized set of recommendations for a single web page. For each recommendation include priority (HIGH/MEDIUM/LOW), estimated effort (eg: 5m/30m/2h), impact (Low/Medium/High) and an optional copy-paste code snippet. Return strict JSON matching the function schema.`;
  const userPrompt = `Static analysis: ${JSON.stringify(prelim, null, 2)}\n\nPlease prioritize and explain the top 8 actionable fixes for SEO and GEO readiness. Be concise and provide copy-paste examples where applicable.`;

  let aiJson = null;
  try {
    if (OPENAI_API_KEY) aiJson = await callOpenAIWithSchema(systemPrompt, userPrompt, htmlSnippet, prelim);
  } catch (e) {
    console.error('AI call failed:', e);
  }

  const outObj = { url: TARGET_URL, scrapedAt: new Date().toISOString(), prelim, ai: aiJson || null, hints };
  const reportsDir = ensureReportsDir();
  const hostname = (() => { try { return new URL(TARGET_URL).hostname.replace(/[:\/\\]/g, '-'); } catch (e) { return 'unknown-host'; } })();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(reportsDir, `${hostname}-${ts}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(outObj, null, 2), 'utf8');
  console.log('Saved JSON report to', jsonPath);

  const htmlPath = path.join(reportsDir, `${hostname}-${ts}.html`);
  try {
    await generateHtmlReport(outObj, htmlPath);
    console.log('Saved interactive HTML report to', htmlPath);
  } catch (e) {
    console.error('HTML generation failed:', e);
  }

  const pdfPath = path.join(reportsDir, `${hostname}-${ts}.pdf`);
  try {
    const ok = await generatePdfFromReportIfRequested(outObj, pdfPath);
    if (ok) console.log('Saved PDF report to', pdfPath);
  } catch (e) {
    console.error('PDF generation failed:', e);
  }

  // Rich console summary
  try {
    const geoCalc = calculateGeoScore(prelim, hints);
    console.log('\n---- GEO Audit Summary ----');
    console.log('URL:', TARGET_URL);
    console.log('Scanned at:', outObj.scrapedAt);
    console.log('SEO Score (static):', (prelim?.summary?.score ?? 'N/A') + '%');
    console.log('GEO Score (calc):', geoCalc.GEO_SCORE + '%');
    console.log('\nTop checklist:');
    console.log('- Metadata:', hints.metadataQuality);
    console.log('- Data Structure & Schema: JSON-LD count =', hints.jsonLdCount);
    console.log('- Robots.txt referenced in page HTML:', hints.foundFiles.robotsTxt ? 'Yes' : 'No');
    console.log('- Canonical:', prelim?.checks?.canonical?.detail?.href || 'Not found');
    console.log('- Hreflang count:', hints.hreflangCount);
    console.log('- Local schema (detected):', prelim?.checks?.local_schema?.ok ? 'Yes' : 'No');
    console.log('- Images ALT ratio:', Math.round((hints.accessibility.imagesAltRatio||0)*100) + '%');
    console.log('- Reading ease (Flesch):', hints.readability.flesch, '(', hints.readability.label, ')');

    if (aiJson) {
      console.log('\nAI Suggestions:');
      (aiJson.ai_suggestions || []).slice(0,10).forEach((s, i) => {
        console.log(`${i+1}. ${s.key} — ${s.priority} — ${s.impact || ''} — Effort: ${s.estimated_effort || ''}`);
      });
    }

    console.log('\nDetailed JSON and interactive HTML saved to reports/. Open the HTML file in your browser to inspect and copy fixes.');
    console.log('---- End ----\n');
  } catch (e) {
    console.warn('Failed to print concise output:', e);
  }
}

// -------------------- ESM entrypoint detection --------------------
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch(err => { console.error('Fatal error:', err); process.exit(99); });
}
