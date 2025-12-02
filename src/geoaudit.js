// geoaudit.crawl-fullsite.js
// Single-report, full-site analysis: treat all crawl results as ONE combined source and produce a single aggregate report.
// Usage example:
//   SCRAPING_KEY=sk_xxx OPENAI_API_KEY=sk_xxx CRAWL_LIMIT=100 AI_SNIPPET_MAX=12000 node geoaudit.crawl-fullsite.js https://www.example.com

import fs from 'fs';
import path from 'path';
import { URL, fileURLToPath } from 'url';
import { load } from 'cheerio';
import { ScrapingCrawl } from '@scrapeless-ai/sdk';

// -------------------- CONFIG --------------------
const TARGET_URL = process.argv[2] || 'https://example.com';
const SCRAPING_KEY = process.env.SCRAPING_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const AI_SNIPPET_MAX = process.env.AI_SNIPPET_MAX ? parseInt(process.env.AI_SNIPPET_MAX, 10) : 12000; // characters
const CRAWL_LIMIT = process.env.CRAWL_LIMIT ? parseInt(process.env.CRAWL_LIMIT, 10) : undefined;

// basic weights (used in analyzeHtml)
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
    resp?.output?.html,
    resp?.payload?.html
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

function escapeHtml(s) {
  if (s === undefined || s === null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#39;');
}

// -------------------- Static analyzer (per earlier implementation) --------------------
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

  addCheck('lang', !!$('html').attr('lang'), WEIGHTS.lang, { lang: $('html').attr('lang') || null }, 'Add <html lang=\"...\"> (BCP47)', 'low');
  addCheck('charset', !!$('meta[charset]').attr('charset'), WEIGHTS.charset, { charset: $('meta[charset]').attr('charset') || null }, 'Add <meta charset=\"utf-8\">', 'low');
  addCheck('viewport', !!$('meta[name=\"viewport\"]').attr('content'), WEIGHTS.viewport, null, 'Add viewport meta', 'low');

  const title = ($('title').text() || '').trim();
  addCheck('title', title.length >= 10, WEIGHTS.title, { title, length: title.length }, 'Keep title 30-60 chars', 'high');

  const desc = ($('meta[name=\"description\"]').attr('content') || '').trim();
  addCheck('description', desc.length >= 20, (desc.length >= 50 && desc.length <= 160) ? WEIGHTS.description : Math.round(WEIGHTS.description / 2), { description: desc, length: desc.length }, 'Meta description 50-160 chars', 'high');

  const h1Count = $('h1').length;
  addCheck('h1', h1Count >= 1, h1Count === 1 ? WEIGHTS.h1 : Math.round(WEIGHTS.h1 * 0.5), { h1_count: h1Count }, 'Exactly one H1 preferred', 'medium');

  const canonical = $('link[rel=\"canonical\"]').attr('href') || null;
  addCheck('canonical', !!canonical, WEIGHTS.canonical, { href: canonical }, 'Add canonical link', 'high');

  const robots = (($('meta[name=\"robots\"]').attr('content') || '')).toLowerCase();
  addCheck('robots', !robots.includes('noindex'), WEIGHTS.robots, { robots }, 'Remove noindex if you want indexing', 'high');

  const jsonLdNodes = [];
  $('script[type=\"application/ld+json\"]').each((i, el) => {
    try {
      const raw = $(el).contents().text();
      if (raw && raw.trim()) jsonLdNodes.push(JSON.parse(raw));
    } catch (e) {
      jsonLdNodes.push('invalid-json');
    }
  });
  addCheck('json_ld', jsonLdNodes.length > 0, WEIGHTS.json_ld, { count: jsonLdNodes.length }, 'Add JSON-LD structured data', 'medium');

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

  const imgs = $('img').toArray();
  if (imgs.length === 0) {
    addCheck('images_alt', true, WEIGHTS.images_alt, { total: 0, withAlt: 0, ratio: 1 }, null, 'low');
  } else {
    const withAlt = imgs.filter(i => ($(i).attr('alt') || '').trim().length > 0).length;
    const ratio = withAlt / imgs.length;
    addCheck('images_alt', ratio >= 0.8, Math.round(WEIGHTS.images_alt * (ratio >= 0.8 ? 1 : ratio)), { total: imgs.length, withAlt, ratio: Number(ratio.toFixed(2)) }, 'Add alt attributes for images (aim >=80%)', 'medium');
  }

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

// -------------------- Advanced analysis (semantic, accessibility, crawlability, content, entities, sitemap, robots) --------------------
function advancedAnalysis(html, crawlResponse, prelim) {
  const $ = load(html || '');
  const res = {};

  // Semantic HTML: count landmark elements, missing main/header/footer
  const landmarks = ['header','nav','main','article','section','aside','footer'];
  const semanticCounts = {};
  landmarks.forEach(tag => semanticCounts[tag] = $(tag).length);
  const missingMain = semanticCounts['main'] === 0;
  const landmarkIssues = [];
  if (missingMain) landmarkIssues.push('Missing <main> landmark');
  if (semanticCounts['header'] === 0) landmarkIssues.push('Missing <header>');
  // detect skipped heading levels
  const headingIssues = [];
  const headings = [];
  $('h1,h2,h3,h4,h5,h6').each((i,el)=> {
    const tagName = el.tagName || (el.name || '');
    const n = parseInt(String(tagName).replace('h','')) || null;
    if (n) headings.push(n);
  });
  for (let i=1;i<headings.length;i++){ if (headings[i]-headings[i-1]>1) headingIssues.push(`Skipped heading level (H${headings[i-1]} → H${headings[i]})`); }

  res.semantic = { semanticCounts, missingMain, landmarkIssues, headingIssues };

  // Accessibility: ARIA attributes, skip links, focusable elements, form labels, tabindex, contrast (inline best-effort)
  const ariaCount = ($('*[role],[aria-label],[aria-labelledby],[aria-describedby]').length);
  const skipLinks = $('a[href^="#"]:contains("skip")').length || $('a.skip-link').length;
  const formLabels = $('label[for]').length;
  const inputs = $('input,textarea,select,button').length;
  const focusable = $('a,button,input,textarea,select,[tabindex]').filter((i,el)=> {
    try { const t = $(el).attr('tabindex'); return (t===undefined || t!=='-1'); } catch(e) { return true; }
  }).length;

  // contrast: probe inline styles for hex colors (very best-effort)
  function parseColor(val){ if(!val) return null; const m = String(val).match(/#([0-9a-f]{3,8})/i); if(m) return m[0]; return null; }
  function hexToRgb(hex){ if(!hex) return null; hex = hex.replace('#',''); if(hex.length===3) hex = hex.split('').map(c=>c+c).join(''); const r=parseInt(hex.slice(0,2),16); const g=parseInt(hex.slice(2,4),16); const b=parseInt(hex.slice(4,6),16); return {r,g,b}; }
  function luminance(c){ const srgb = [c.r/255,c.g/255,c.b/255].map(v=> v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4)); return 0.2126*srgb[0]+0.7152*srgb[1]+0.0722*srgb[2]; }
  function contrastRatio(c1,c2){ if(!c1 || !c2) return null; const L1=luminance(c1), L2=luminance(c2); const bright=Math.max(L1,L2), dark=Math.min(L1,L2); return Math.round(((bright+0.05)/(dark+0.05))*100)/100; }
  const contrastProblems = [];
  $('[style]').each((i,el)=>{
    const s = $(el).attr('style') || '';
    let fg = null, bg = null;
    try {
      const mF = s.match(/color\s*:\s*([^;]+)/i);
      const mB = s.match(/background(?:-color)?\s*:\s*([^;]+)/i);
      fg = parseColor(mF ? mF[1] : null);
      bg = parseColor(mB ? mB[1] : null);
    } catch(e) {}
    if (fg && bg) {
      const cr = contrastRatio(hexToRgb(fg), hexToRgb(bg));
      if (cr && cr < 3) contrastProblems.push({ selector: el.tagName, contrast: cr });
    }
  });

  res.accessibility = { ariaCount, skipLinks: Boolean(skipLinks), formLabels, inputs, focusable, contrastProblems };

  // Crawlability score: robots meta, canonical, sitemap presence, internal link density
  const robotsMeta = ($('meta[name=\"robots\"]').attr('content')||'');
  const canonical = $('link[rel=\"canonical\"]').attr('href') || null;
  const sitemapInHtml = /sitemap\.xml/i.test(html || '');
  const internalLinks = $('a[href^="/"]').length + $('a[href*="' + (new URL(TARGET_URL)).hostname + '"]').length;
  const totalLinks = $('a').length || 1;
  const internalDensity = Math.round((internalLinks/totalLinks)*100);
  const crawlScore = Math.min(100, Math.round(( (canonical?20:0) + (robotsMeta.includes('noindex')?0:15) + (sitemapInHtml?20:0) + Math.min(30, internalDensity) + (res.semantic.semanticCounts.main?15:0) )));
  res.crawlability = { robotsMeta, canonical, sitemapInHtml, internalLinks, totalLinks, internalDensity, crawlScore };

  // Content Quality for AI: words, paragraphs, avg words per paragraph, Flesch read
  const bodyText = ($('body').text() || '').replace(/\s+/g,' ').trim();
  const words = bodyText.split(/\s+/).filter(Boolean).length;
  const paras = $('p').toArray().map(p => ($(p).text() || '').trim()).filter(Boolean);
  const paraCount = paras.length;
  const avgWordsPerPara = paraCount ? Math.round(paras.reduce((s,p)=>s + p.split(/\s+/).filter(Boolean).length, 0) / paraCount) : 0;
  function countSyllables(word){ word = word.toLowerCase().replace(/[^a-z]/g,''); if(!word) return 0; const vowels='aeiouy'; let syll=0; let prev=false; for(let ch of word){ const isV=vowels.includes(ch); if(isV && !prev) syll++; prev=isV; } if(word.endsWith('e')) syll = Math.max(1, syll-1); if(syll===0) syll=1; return syll; }
  const wordsArr = bodyText.split(/\s+/).filter(Boolean);
  const syllables = wordsArr.reduce((s,w)=>s+countSyllables(w),0) || 1;
  const sentences = bodyText.split(/[.!?]+/).filter(Boolean).length || 1;
  const flesch = Math.round(206.835 - 1.015 * (words / sentences) - 84.6 * (syllables / words));
  res.contentQualityForAI = { words, paraCount, avgWordsPerPara, flesch };

  // Content & Context completeness heuristics
  const hasContact = /contact|about|pricing|price|product|services|terms|privacy/i.test(html||'');
  const contentCompleteness = { hasContact, hasPricing: /price|pricing/i.test(html||''), hasProducts: /product|service/i.test(html||''), sections: Object.keys(res.semantic.semanticCounts).filter(k => res.semantic.semanticCounts[k] > 0) };
  const contextCompleteness = { localSchema: Boolean(prelim?.checks?.local_schema?.ok), socialLinks: $('a[href*=\"twitter.com\"], a[href*=\"facebook.com\"], a[href*=\"linkedin.com\"]').length > 0 };
  res.contentCompleteness = contentCompleteness;
  res.contextCompleteness = contextCompleteness;

  // AI training value heuristic
  const aiTrainingValue = (words > 1000 && (prelim?.checks?.json_ld?.detail?.count || 0) > 0 && res.semantic.semanticCounts.main) ? 'High' : (words > 400 ? 'Moderate' : 'Low');
  res.aiTrainingValue = aiTrainingValue;

  // Entity recognition (jsonld + naive caps)
  const entities = [];
  try {
    $('script[type=\"application/ld+json\"]').each((i,el) => {
      try { const j = JSON.parse($(el).contents().text()); if (j) entities.push(...(Array.isArray(j) ? j : [j])); } catch (e) {}
    });
  } catch(e) {}
  const capMatches = [...(bodyText.matchAll(/\b([A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})*)\b/g) || [])].slice(0,50).map(m => m[0]);
  const topEntities = Array.from(new Set(capMatches)).slice(0,10);
  res.entityRecognition = { jsonLdEntitiesCount: entities.length, topEntities };

  // Knowledge Graph readiness (JSON-LD graph analysis)
  const kg = { jsonLdCount: prelim?.checks?.json_ld?.detail?.count || 0, hasSameAs: false, nodes: [] };
  try {
    const rawNodes = [];
    $('script[type=\"application/ld+json\"]').each((i,el) => { try { const j = JSON.parse($(el).contents().text()); rawNodes.push(j); } catch(e) {} });
    rawNodes.forEach(n => {
      if (typeof n === 'object') {
        const arr = Array.isArray(n) ? n : [n];
        arr.forEach(item => {
          const id = item['@id'] || null;
          const type = item['@type'] || item.type || null;
          if (item.sameAs) kg.hasSameAs = true;
          kg.nodes.push({ id, type, raw: item });
        });
      }
    });
  } catch(e) {}
  res.knowledgeGraphReadiness = kg;

  // Structured relations (small extraction)
  const relations = [];
  kg.nodes.forEach(n => {
    if (n.raw && n.raw.publisher) relations.push({ from: n.id || n.type, to: n.raw.publisher['@id'] || n.raw.publisher.name || JSON.stringify(n.raw.publisher) });
  });
  res.structuredRelations = relations;

  // Sitemap & robots (best-effort, some info may be in crawlResponse)
  const robotsRaw = (crawlResponse && (crawlResponse.robots || crawlResponse.robots_txt || crawlResponse.data?.robots || crawlResponse.results?.find(r => r.robots)?.robots)) || null;
  res.robotsRaw = robotsRaw;

  return res;
}

// -------------------- computeHintsFromHtml (lightweight hints) --------------------
function computeHintsFromHtml(html, prelim) {
  const $ = load(html || '');
  const htmlLower = (html || '').toLowerCase();
  const foundFiles = {
    llmsTxt: /llms?\.txt/.test(htmlLower),
    robotsTxt: /robots\.txt/.test(htmlLower),
    hreflang: /rel\s*=\s*["']alternate["']\s+hreflang/.test(htmlLower)
  };

  const headings = [];
  $('h1,h2,h3,h4,h5,h6').each((i, el) => {
    const tag = el.tagName || el.name || '';
    const n = parseInt(String(tag).replace('h','')) || null;
    if (n) headings.push(n);
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
  const desc = ($('meta[name=\"description\"]').attr('content') || '').trim();
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

  // Count hreflang occurrences roughly
  const hreflangCount = (htmlLower.match(/hreflang/g) || []).length;

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
    hreflangCount
  };
}

// -------------------- GEO SCORE --------------------
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

// -------------------- AI call (function-calling style, single call for combined source) --------------------
async function callOpenAIWithSchema(systemPrompt, userPrompt, rawHtmlSnippet, fullContext) {
  if (!OPENAI_API_KEY) {
    console.warn('OPENAI_API_KEY not set — skipping AI step.');
    return null;
  }

  const functionDef = {
    name: 'ai_audit_result',
    description: 'Return strict JSON for site-wide SEO/ACCESSIBILITY/KG readiness',
    parameters: {
      type: 'object',
      properties: {
        seo_score: { type: 'number' },
        geo_score: { type: 'number' },
        accessibility_score: { type: 'number' },
        crawlability_score: { type: 'number' },
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
      { role: 'user', content: `Prelim JSON summary:\n${JSON.stringify(fullContext.prelim || {}, null, 2)}\n\nAdvanced metrics:\n${JSON.stringify(fullContext.advanced || {}, null, 2)}\n\nHTML snippet (truncated):\n${rawHtmlSnippet}` }
    ],
    functions: [functionDef],
    function_call: { name: 'ai_audit_result' },
    temperature: 0.0,
    max_tokens: 1600
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

// -------------------- Aggregate HTML generator (visual, Semrush-style) --------------------
async function generateAggregateHtmlReport(reportObj, outHtmlPath) {
  const escapeHtmlLocal = (s) => {
    if (s === undefined || s === null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#39;');
  };

  const dataJson = JSON.stringify(reportObj || {});
  const prelim = reportObj.prelim || {};
  const advanced = reportObj.advanced || {};
  const hints = reportObj.hints || {};
  const geo = reportObj.geo || {};
  const topIssues = reportObj.topIssues || [];
  const sitemaps = reportObj.sitemaps || [];
  const robotsRaw = reportObj.robotsRaw || {};
  const pagesFound = reportObj.pagesFound || 0;

  const seoScore = (reportObj.ai && reportObj.ai.seo_score) ? reportObj.ai.seo_score : (prelim.summary ? prelim.summary.score : 0);
  const crawlScore = (reportObj.ai && reportObj.ai.crawlability_score) ? reportObj.ai.crawlability_score : (advanced.crawlability ? advanced.crawlability.crawlScore : 0);
  const accessibilityScore = (reportObj.ai && reportObj.ai.accessibility_score) ? reportObj.ai.accessibility_score : (advanced.accessibility ? (advanced.accessibility.ariaCount ? 75 : 50) : 0);
  const geoScore = geo.GEO_SCORE || null;

  const entities = (advanced.entityRecognition && Array.isArray(advanced.entityRecognition.topEntities)) ? advanced.entityRecognition.topEntities : [];
  const topIssuesNormalized = Array.isArray(topIssues) ? topIssues.slice(0, 200) : [];

  const hasLLMTxt = hints && hints.foundFiles && hints.foundFiles.llmsTxt;
  const sitemapCount = Array.isArray(sitemaps) ? sitemaps.length : 0;
  const hasRobots = Boolean(Object.keys(robotsRaw || {}).length);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Aggregate Audit — ${escapeHtmlLocal(reportObj.url)}</title>

<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>

<style>
  :root{
    --bg:#0f1724; --card:#0b1220; --muted:#9aa7bf; --accent:#12A; --good:#16a34a; --warn:#f59e0b; --bad:#ef4444;
    --glass: rgba(255,255,255,0.03);
  }
  html,body{height:100%;margin:0;background:linear-gradient(180deg,#071025 0%, #081226 100%);font-family:Inter,system-ui,Segoe UI,Arial,sans-serif;color:#e6eef8}
  .page{max-width:1200px;margin:18px auto;padding:20px}
  header{display:flex;gap:16px;align-items:center;justify-content:space-between;margin-bottom:18px}
  .brand{display:flex;gap:12px;align-items:center}
  .brand .logo{width:44px;height:44px;border-radius:8px;background:linear-gradient(135deg,#0ea5a9,#0b6a3a);display:flex;align-items:center;justify-content:center;font-weight:800;color:white}
  h1{font-size:18px;margin:0}
  .meta{color:var(--muted);font-size:13px}
  .kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}
  .kpi{background:var(--card);padding:14px;border-radius:10px;box-shadow:0 6px 18px rgba(2,6,23,0.6);display:flex;flex-direction:column;gap:8px}
  .kpi .label{font-size:12px;color:var(--muted)}
  .kpi .value{font-weight:800;font-size:20px}
  .kpi .sub{font-size:12px;color:var(--muted)}
  .layout{display:grid;grid-template-columns:1fr 360px;gap:18px}
  .card{background:var(--card);padding:14px;border-radius:10px;box-shadow:0 8px 24px rgba(2,6,23,0.6);color:#dbe9ff}
  .section-title{font-weight:700;margin-bottom:8px}
  .muted{color:var(--muted);font-size:13px}
  .chart-wrap{height:220px}
  .issues-table{width:100%;border-collapse:collapse;margin-top:8px}
  .issues-table th,.issues-table td{padding:8px;border-bottom:1px solid rgba(255,255,255,0.04);text-align:left;font-size:13px}
  .badge{display:inline-block;padding:6px 8px;border-radius:8px;font-weight:700;font-size:12px}
  .badge.good{background:rgba(22,163,74,0.12);color:var(--good)}
  .badge.warn{background:rgba(245,158,11,0.08);color:var(--warn)}
  .badge.bad{background:rgba(239,68,68,0.1);color:var(--bad)}
  .flex{display:flex;gap:8px;align-items:center}
  .small{font-size:12px;color:var(--muted)}
  details{margin-top:8px}
  pre{background:rgba(255,255,255,0.02);padding:10px;border-radius:6px;overflow:auto;font-size:13px}
  .issues-list { max-height:280px; overflow:auto; }
  .entity-bar { height:28px; margin-bottom:8px; border-radius:6px; display:flex; align-items:center; justify-content:space-between; padding:6px 8px; background:rgba(255,255,255,0.02); font-size:13px; }
  .signal { display:flex; gap:10px; align-items:center; margin-top:8px; }
  .signal .dot { width:10px; height:10px; border-radius:50%; }
  .signal.ok .dot { background:var(--good) }
  .signal.miss .dot { background:var(--bad) }
  .actions { margin-top:10px; display:flex; gap:8px; }
  button.copyBtn { background:#0b6a3a; color:white; border:none; padding:8px 10px; border-radius:8px; cursor:pointer; font-weight:700 }
  @media (max-width:1000px) {
    .layout { grid-template-columns: 1fr; }
    .kpi-grid { grid-template-columns: repeat(2,1fr); }
  }
</style>
</head>
<body>
  <div class="page" id="root">
    <header>
      <div class="brand">
        <div class="logo">AI</div>
        <div>
          <h1>Site Audit — ${escapeHtmlLocal(reportObj.url)}</h1>
          <div class="meta">Scanned: ${escapeHtmlLocal(reportObj.scrapedAt || new Date().toISOString())} · Pages: ${pagesFound}</div>
        </div>
      </div>
      <div class="flex">
        <div class="small">Export:</div>
        <button class="copyBtn" id="export-json">Download JSON</button>
        <button class="copyBtn" id="open-raw">Open Raw</button>
      </div>
    </header>

    <div class="kpi-grid">
      <div class="kpi">
        <div class="label">SEO Score</div>
        <div class="value" id="kpi-seo">${seoScore}%</div>
        <div class="sub">Static checks + AI (if enabled)</div>
      </div>
      <div class="kpi">
        <div class="label">Crawlability</div>
        <div class="value" id="kpi-crawl">${crawlScore}%</div>
        <div class="sub">Sitemap, robots, internal link density</div>
      </div>
      <div class="kpi">
        <div class="label">Accessibility</div>
        <div class="value" id="kpi-access">${accessibilityScore}%</div>
        <div class="sub">ARIA, labels, keyboard</div>
      </div>
      <div class="kpi">
        <div class="label">GEO / Local</div>
        <div class="value" id="kpi-geo">${geoScore !== null ? geoScore + '%' : 'N/A'}</div>
        <div class="sub">Local signals readiness</div>
      </div>
    </div>

    <div class="layout">
      <main>
        <div class="card">
          <div class="section-title">Overview & Quick Signals</div>
          <div class="muted">Quick summary of key signals and top issues</div>

          <div style="display:flex;gap:12px;margin-top:12px;align-items:center">
            <div style="flex:1">
              <div class="signal ${hasLLMTxt ? 'ok' : 'miss'}"><div class="dot"></div><div class="small">llm.txt / llms.txt: ${hasLLMTxt ? '<strong>Found</strong>' : '<strong>Missing</strong>'}</div></div>
              <div class="signal ${sitemapCount > 0 ? 'ok' : 'miss'}"><div class="dot"></div><div class="small">Sitemap: ${sitemapCount > 0 ? `<strong>${sitemapCount} found</strong>` : '<strong>Missing</strong>'}</div></div>
              <div class="signal ${hasRobots ? 'ok' : 'miss'}"><div class="dot"></div><div class="small">robots.txt: ${hasRobots ? '<strong>Collected</strong>' : '<strong>Missing</strong>'}</div></div>
            </div>
            <div style="width:220px;text-align:right">
              <div class="small">Recommendations:</div>
              <div class="muted" style="margin-top:8px">If missing, add llm.txt or expose training signals; ensure sitemap is accessible and robots is configured correctly for crawl efficiency.</div>
            </div>
          </div>

          <hr style="border:none;height:1px;background:rgba(255,255,255,0.03);margin:12px 0">

          <div style="display:flex;gap:12px;align-items:flex-start">
            <div style="flex:1">
              <div class="section-title">Top Issues</div>
              <div class="issues-list">
                <table class="issues-table" aria-live="polite" role="table">
                  <thead><tr><th>Issue</th><th style="width:110px">Count</th></tr></thead>
                  <tbody id="issues-body">
                    ${topIssuesNormalized.slice(0,50).map(it => {
                      const issueText = escapeHtmlLocal(it.issue || (it[0] || JSON.stringify(it)));
                      const countText = escapeHtmlLocal(String(it.count || it[1] || '1'));
                      return `<tr><td>${issueText}</td><td>${countText}</td></tr>`;
                    }).join('')}
                  </tbody>
                </table>
              </div>
            </div>

            <div style="width:300px">
              <div class="section-title">Entities (Top)</div>
              <div class="muted">Entities extracted across the site</div>
              <div style="margin-top:8px">
                ${entities.length ? entities.map((e, idx) => `<div class="entity-bar"><div style="font-weight:700">${escapeHtmlLocal(e)}</div><div class="small">#${idx+1}</div></div>`).join('') : '<div class="small">No significant entities</div>'}
              </div>
            </div>
          </div>
        </div>

        <div class="card" style="margin-top:12px">
          <div class="section-title">Visual Diagnostics</div>
          <div class="muted">Charts show issue frequency and score distribution</div>
          <div style="display:flex;gap:12px;margin-top:12px">
            <div style="flex:1">
              <canvas id="chart-issues" class="chart-wrap"></canvas>
            </div>
            <div style="width:360px">
              <canvas id="chart-scores" class="chart-wrap"></canvas>
            </div>
          </div>
        </div>

        <div class="card" style="margin-top:12px">
          <div class="section-title">Detailed Signals & Raw Data</div>
          <details><summary>Robots (raw)</summary><pre>${escapeHtmlLocal(JSON.stringify(robotsRaw || {}, null, 2))}</pre></details>
          <details style="margin-top:8px"><summary>Sitemaps</summary><pre>${escapeHtmlLocal(JSON.stringify(sitemaps || [], null, 2))}</pre></details>
          <details style="margin-top:8px"><summary>Prelim Summary</summary><pre>${escapeHtmlLocal(JSON.stringify(prelim || {}, null, 2))}</pre></details>
        </div>
      </main>

      <aside>
        <div class="card">
          <div class="section-title">Actionable Fixes</div>
          <div class="muted">AI suggestions (if enabled) and static suggestions</div>
          ${reportObj.ai && reportObj.ai.ai_suggestions ? `<div style="margin-top:8px"><pre>${escapeHtmlLocal(JSON.stringify(reportObj.ai.ai_suggestions.slice(0,30), null, 2))}</pre></div>` : `<div class="muted" style="margin-top:8px">AI not enabled or no suggestions returned</div>`}
          <div class="actions">
            <button class="copyBtn" id="copy-fixes">Copy Fixes</button>
            <button class="copyBtn" id="download-csv">Download CSV</button>
          </div>
        </div>

        <div class="card" style="margin-top:12px">
          <div class="section-title">Checklist</div>
          <div class="muted">Quick view of missing or present items</div>
          <ul style="margin-top:8px">
            <li>${hasLLMTxt ? '<span class="badge good">llm.txt OK</span>' : '<span class="badge bad">llm.txt Missing</span>'}</li>
            <li>${sitemapCount>0 ? `<span class="badge good">sitemap (${sitemapCount})</span>` : '<span class="badge warn">sitemap Missing</span>'}</li>
            <li>${hasRobots ? '<span class="badge good">robots.txt OK</span>' : '<span class="badge warn">robots Missing</span>'}</li>
          </ul>
        </div>

        <div class="card" style="margin-top:12px">
          <div class="section-title">Quick Notes</div>
          <div class="muted">Summary</div>
          <ul style="margin-top:8px">
            <li>Missing sitemap or misconfigured robots.txt can hurt crawling and indexing.</li>
            <li>llm.txt helps indicate available training data and should be exposed if used.</li>
            <li>Prioritize HIGH severity issues and re-run the audit after fixes.</li>
          </ul>
        </div>
      </aside>
    </div>
  </div>

<script>
  const REPORT = ${dataJson};

  const topIssues = ${JSON.stringify(topIssuesNormalized.slice(0,20))};
  const issueLabels = topIssues.map(i => (i.issue || (i[0]||'')).slice(0,40));
  const issueCounts = topIssues.map(i => (i.count || i[1] || 0));

  const scores = {
    seo: ${Number(seoScore) || 0},
    crawl: ${Number(crawlScore) || 0},
    access: ${Number(accessibilityScore) || 0},
    geo: ${Number(geoScore) || 0}
  };

  const ctxIssues = document.getElementById('chart-issues').getContext('2d');
  new Chart(ctxIssues, {
    type: 'bar',
    data: {
      labels: issueLabels,
      datasets: [{
        label: 'Issue frequency',
        data: issueCounts,
        backgroundColor: issueCounts.map(c => c>10 ? 'rgba(239,68,68,0.9)' : (c>3 ? 'rgba(245,158,11,0.85)' : 'rgba(16,185,129,0.85)')),
        borderRadius: 6
      }]
    },
    options: {
      plugins: { legend: { display: false } },
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: '#bcd4f7' }, grid: { display: false } },
        y: { ticks: { color: '#bcd4f7' }, grid: { color: 'rgba(255,255,255,0.03)' }, beginAtZero: true }
      }
    }
  });

  const ctxScores = document.getElementById('chart-scores').getContext('2d');
  new Chart(ctxScores, {
    type: 'bar',
    data: {
      labels: ['SEO','Crawl','Accessibility','GEO'],
      datasets: [{
        label: 'Score',
        data: [scores.seo, scores.crawl, scores.access, scores.geo || 0],
        backgroundColor: ['rgba(59,130,246,0.9)','rgba(16,185,129,0.9)','rgba(245,158,11,0.9)','rgba(99,102,241,0.9)'],
        borderRadius: 6
      }]
    },
    options: {
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      maintainAspectRatio: false,
      scales: {
        x: { max: 100, ticks: { color: '#bcd4f7' }, grid: { color: 'rgba(255,255,255,0.03)' } },
        y: { ticks: { color: '#bcd4f7' }, grid: { display: false } }
      }
    }
  });

  // Export JSON
  document.getElementById('export-json').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(REPORT, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (REPORT.url || 'report') + '-aggregate.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  // Open raw JSON in new tab
  document.getElementById('open-raw').addEventListener('click', () => {
    const w = window.open();
    w.document.write('<pre>' + JSON.stringify(REPORT, null, 2).replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</pre>');
    w.document.title = 'Raw Audit JSON';
  });

  // Copy fixes
  document.getElementById('copy-fixes').addEventListener('click', async () => {
    const fixes = (REPORT.ai && REPORT.ai.ai_suggestions) ? REPORT.ai.ai_suggestions : (REPORT.prelim && REPORT.prelim.suggestions ? REPORT.prelim.suggestions : []);
    const text = JSON.stringify(fixes, null, 2);
    try { await navigator.clipboard.writeText(text); alert('Fixes copied to clipboard'); } catch (e) { alert('Copy failed'); }
  });

  // Download CSV (top issues)
  document.getElementById('download-csv').addEventListener('click', () => {
    const rows = [['issue','count']].concat(topIssues.map(it => [it.issue || it[0] || '', String(it.count || it[1] || 0)]));
    const csv = rows.map(r => r.map(c => '\"' + String(c).replace(/\"/g,'\"\"') + '\"').join(',')).join('\\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (REPORT.url || 'report') + '-top-issues.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
</script>

</body>
</html>`;

  fs.writeFileSync(outHtmlPath, html, 'utf8');
}

// -------------------- MAIN --------------------
async function main() {
  if (!TARGET_URL) {
    console.error('No TARGET URL provided. Usage: node geoaudit.crawl-fullsite.js <url>');
    process.exit(1);
  }
  if (!SCRAPING_KEY) console.warn('Warning: SCRAPING_KEY not set; crawl may fail depending on SDK configuration.');

  const client = new ScrapingCrawl({ apiKey: SCRAPING_KEY });

  console.log('Starting crawl for', TARGET_URL);
  let crawlResponse;
  try {
    const crawlOptions = {
      allowBackwardLinks: true,
      scrapeOptions: {
        formats: ['html'],
        onlyMainContent: false,
        timeout: 30000
      },
      browserOptions: {
        proxyCountry: 'ANY',
        sessionName: 'FullsiteCrawl',
        sessionRecording: true,
        sessionTTL: 3000
      }
    };
    if (CRAWL_LIMIT) crawlOptions.limit = CRAWL_LIMIT;
    crawlResponse = await client.crawlUrl(TARGET_URL, crawlOptions);
  } catch (err) {
    console.error('Crawl failed:', err);
    process.exit(2);
  }

  // Collect HTML pieces from all results, and collect sitemap/robots info
  const results = Array.isArray(crawlResponse?.results) && crawlResponse.results.length > 0 ? crawlResponse.results : [crawlResponse];
  const htmlPieces = []; // { url, html }
  const sitemapUrls = new Set();
  let robotsRaw = crawlResponse?.robots || crawlResponse?.robots_txt || crawlResponse?.data?.robots || null;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    // attempt to capture sitemaps/robots if present in result metadata
    if (r?.sitemap) {
      if (Array.isArray(r.sitemap)) r.sitemap.forEach(u => sitemapUrls.add(u));
      else sitemapUrls.add(r.sitemap);
    }
    if (r?.payload?.sitemaps) {
      (r.payload.sitemaps || []).forEach(u => sitemapUrls.add(u));
    }
    if (!robotsRaw && (r?.robots || r?.robots_txt)) robotsRaw = r.robots || r.robots_txt;

    const htmlCandidate = extractHtmlFromResponse(r) || extractHtmlFromResponse(r?.payload) || extractHtmlFromResponse(r?.html);
    if (!htmlCandidate) continue;
    const pageUrl = r?.url || (r?.payload && r.payload.url) || `${TARGET_URL}#result-${i}`;
    htmlPieces.push({ url: pageUrl, html: htmlCandidate });
  }

  if (htmlPieces.length === 0) {
    console.error('No HTML pages found in crawl results. Raw crawl response saved for debugging.');
    const debugPath = path.join(ensureReportsDir(), 'crawl-raw-debug.json');
    fs.writeFileSync(debugPath, JSON.stringify(crawlResponse, null, 2), 'utf8');
    console.error('Wrote debug crawl response to', debugPath);
    process.exit(3);
  }

  // Combine all HTML pieces into one analysis source (with separator)
  const combinedHtml = htmlPieces.map(p => `\n\n<!-- --- PAGE: ${p.url} --- -->\n\n${p.html}`).join('\n');

  // Run static + advanced analysis on combined content
  const prelim = analyzeHtml(combinedHtml);
  const advanced = advancedAnalysis(combinedHtml, crawlResponse, prelim);
  const hints = computeHintsFromHtml(combinedHtml, prelim);
  const geo = calculateGeoScore(prelim, hints);

  // Build final report object
  const outObj = {
    url: TARGET_URL,
    scrapedAt: new Date().toISOString(),
    pagesFound: htmlPieces.length,
    sitemaps: Array.from(sitemapUrls),
    robotsRaw: robotsRaw || null,
    prelim,
    advanced,
    hints,
    geo,
    rawCrawl: crawlResponse
  };

  // optionally call AI once for overall recommendations (use truncated HTML snippet)
  let aiJson = null;
  try {
    if (OPENAI_API_KEY) {
      const htmlSnippet = combinedHtml.length > AI_SNIPPET_MAX ? combinedHtml.slice(0, AI_SNIPPET_MAX) + '\n\n...[TRUNCATED]' : combinedHtml;
      const systemPrompt = `You are an expert site-level SEO, accessibility, and knowledge-graph auditor. Use the provided PRELIM and ADVANCED metrics. Provide a single, prioritized set of recommendations for the entire site. Include: Semantic HTML issues, Accessibility issues (ARIA, contrast, keyboard), Crawlability / Sitemap / Robots recommendations, Content Quality & Completeness, AI Training readiness, Entity & KG readiness, and suggested fixes. Return strict JSON with scores and top recommendations.`;
      const userPrompt = `Site: ${TARGET_URL}\nPages scanned: ${htmlPieces.length}\nProvide: 1) site-level scores (SEO, CRAWLABILITY, ACCESSIBILITY, KG_READINESS); 2) top 15 prioritized recommendations (HIGH/MEDIUM/LOW) with short code snippets where applicable; 3) list missing signals for training data. Use the PRELIM and ADVANCED JSON below as ground truth.`;
      aiJson = await callOpenAIWithSchema(systemPrompt, userPrompt, htmlSnippet, { prelim, advanced });
      outObj.ai = aiJson;
    }
  } catch (e) {
    console.error('AI call failed (site-level):', e);
    outObj.ai = { error: String(e) };
  }

  // compute summary items for topIssues (collect from prelim.suggestions and ai suggestions)
  const topIssuesCounter = {};
  function bump(map, key, n = 1) { map[key] = (map[key] || 0) + n; }
  (prelim.suggestions || []).forEach(s => bump(topIssuesCounter, s.key || s.advice || 'issue'));
  if (outObj.ai && Array.isArray(outObj.ai.ai_suggestions)) {
    outObj.ai.ai_suggestions.forEach(s => bump(topIssuesCounter, s.key || s.title || JSON.stringify(s).slice(0,40)));
  }

  outObj.topIssues = Object.entries(topIssuesCounter).sort((a,b)=>b[1]-a[1]).map(([k,v]) => ({ issue: k, count: v }));

  // save final JSON + HTML
  const reportsDir = ensureReportsDir();
  const hostname = (() => { try { return new URL(TARGET_URL).hostname.replace(/[:\/\\]/g, '-'); } catch (e) { return 'unknown-host'; } })();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(reportsDir, `${hostname}-${ts}-aggregate.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(outObj, null, 2), 'utf8');
  console.log('Saved aggregate JSON report to', jsonPath);

  const htmlPath = path.join(reportsDir, `${hostname}-${ts}-aggregate.html`);
  try {
    await generateAggregateHtmlReport(outObj, htmlPath);
    console.log('Saved aggregate HTML report to', htmlPath);
  } catch (e) {
    console.error('Failed to generate HTML report:', e);
  }

  // final console summary
  console.log('\n---- Aggregate Summary ----');
  console.log('URL:', TARGET_URL);
  console.log('Pages found:', htmlPieces.length);
  console.log('Avg (prelim) SEO Score:', prelim?.summary?.score ? `${prelim.summary.score}%` : 'N/A');
  console.log('GEO SCORE:', geo?.GEO_SCORE ?? 'N/A');
  console.log('Crawlability (calc):', advanced?.crawlability?.crawlScore ?? 'N/A');
  console.log('Accessibility (ARIA count):', advanced?.accessibility?.ariaCount ?? 'N/A');
  console.log('Sitemaps found:', Array.from(sitemapUrls).length);
  if (outObj.topIssues && outObj.topIssues.length) {
    console.log('Top issues (top 10):', outObj.topIssues.slice(0,10));
  }
  console.log('Reports directory:', reportsDir);
  console.log('---- End ----\n');
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch(err => { console.error('Fatal error:', err); process.exit(99); });
}
