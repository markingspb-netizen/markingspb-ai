// Markingspb AI — server.
// 1) Serves the website.  2) Asks the AI (Groq, backup: OpenRouter) how to edit.
// 3) Turns speech into text for subtitles (Groq Whisper).
// No extra packages needed for the server itself.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEM_PROMPT } from './prompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
// Strong free models, tried in this order (OpenRouter switches to the next one if a model is busy).
// The free list changes often: update it here or with the OPENROUTER_MODELS setting on Render.
const OPENROUTER_MODELS = (process.env.OPENROUTER_MODELS ||
  'nvidia/nemotron-3.5-super-vl:free,nvidia/nemotron-3-ultra-550b-a55b:free,nvidia/nemotron-3.5-lightning:free')
  .split(',').map((m) => m.trim()).filter(Boolean);
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-large-v3-turbo';
const LIMIT_PER_HOUR = Number(process.env.LIMIT_PER_HOUR || 60);
const PEXELS_API_KEY = process.env.PEXELS_API_KEY || '';

// ---------- static files ----------
const STATIC = [
  ['/vendor/ffmpeg/', path.join(__dirname, 'node_modules/@ffmpeg/ffmpeg/dist/esm')],
  ['/vendor/util/', path.join(__dirname, 'node_modules/@ffmpeg/util/dist/esm')],
  ['/vendor/core/', path.join(__dirname, 'node_modules/@ffmpeg/core/dist/esm')],
  ['/', __dirname],
];
// Only these files from the main folder are shown to visitors.
const PUBLIC_FILES = new Set(['index.html', 'app.js', 'pipeline.js', 'cloud.js', 'style.css', 'logo.svg', 'DejaVuSans-Bold.ttf']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

async function serveStatic(req, res, urlPath) {
  for (const [prefix, root] of STATIC) {
    if (!urlPath.startsWith(prefix)) continue;
    let rel = decodeURIComponent(urlPath.slice(prefix.length)) || 'index.html';
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root)) break;
    if (prefix === '/' && !PUBLIC_FILES.has(rel)) break;
    try {
      const s = await stat(file);
      if (!s.isFile()) continue;
      const data = await readFile(file);
      const ext = path.extname(file);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': prefix.startsWith('/vendor') || ext === '.ttf' ? 'public, max-age=604800' : 'no-cache',
      });
      return res.end(data);
    } catch { /* try next */ }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

// ---------- Firebase settings ----------
// FIREBASE_CONFIG on Render: paste the whole "const firebaseConfig = { ... }" block from Firebase.
function readFirebaseConfig() {
  const raw = process.env.FIREBASE_CONFIG || '';
  const cfg = {};
  for (const m of raw.matchAll(/["']?(\w+)["']?\s*:\s*["']([^"']+)["']/g)) cfg[m[1]] = m[2];
  return cfg.apiKey && cfg.projectId ? cfg : null;
}
const FIREBASE = readFirebaseConfig();
if (FIREBASE) console.log('Firebase is on for project', FIREBASE.projectId); else console.log('Firebase is off (no FIREBASE_CONFIG)');

// ---------- published websites: /s/<id> ----------
const siteCache = new Map();
const BADGE = '<a href="/" target="_blank" rel="noopener" style="position:fixed;right:12px;bottom:12px;z-index:2147483647;font:600 12px system-ui,sans-serif;background:#111;color:#fff;padding:7px 12px;border-radius:999px;text-decoration:none;opacity:.85;box-shadow:0 4px 14px rgba(0,0,0,.25)">Made with Markingspb AI</a>';

async function serveSite(res, id) {
  const page = (code, html) => {
    res.writeHead(code, {
      'Content-Type': 'text/html; charset=utf-8',
      // The page runs in its own sandbox, so it can never touch Markingspb AI accounts or chats.
      'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-popups-to-escape-sandbox',
      'Cache-Control': 'public, max-age=60',
      'X-Robots-Tag': 'index, follow',
    });
    res.end(html);
  };
  if (!FIREBASE) return page(404, '<h1>Publishing is not set up</h1>');
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) return page(404, '<h1>Not found</h1>');
  const hit = siteCache.get(id);
  if (hit && Date.now() - hit.t < 60_000) return page(200, hit.html);
  try {
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(FIREBASE.projectId)}/databases/(default)/documents/sites/${id}?key=${encodeURIComponent(FIREBASE.apiKey)}`;
    const r = await fetch(url);
    if (r.status === 404) return page(404, '<h1>This website does not exist</h1>');
    if (!r.ok) throw new Error('firestore ' + r.status);
    const doc = await r.json();
    let html = doc.fields?.html?.stringValue || '';
    if (!html) return page(404, '<h1>This website is empty</h1>');
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, BADGE + '</body>') : html + BADGE;
    siteCache.set(id, { html, t: Date.now() });
    if (siteCache.size > 300) siteCache.delete(siteCache.keys().next().value);
    page(200, html);
  } catch (e) {
    console.error('Site error:', e.message);
    page(502, '<h1>Could not load this website. Please try again later.</h1>');
  }
}

// ---------- helpers ----------
function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('too_big')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Simple protection so strangers can't use up your free AI limits.
const hits = new Map();
function allowed(req, kind) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const key = kind + ':' + ip;
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < 3600_000);
  if (list.length >= LIMIT_PER_HOUR) { hits.set(key, list); return false; }
  list.push(now);
  hits.set(key, list);
  return true;
}

// Some models write the website with "\n" and "\"" as text instead of real line breaks and quotes. Repair it.
function fixHtml(h) {
  if (!h) return h;
  const lit = (h.match(/\\n/g) || []).length;
  const real = (h.match(/\n/g) || []).length;
  if (lit >= 3 && lit > real) {
    h = h.replace(/\\r\\n|\\n/g, '\n').replace(/\\r/g, '').replace(/\\t/g, '  ')
      .replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\//g, '/').replace(/\\\\/g, '\\');
  }
  return h.trim();
}

// ---------- real photos for websites ----------
// The AI writes photo:search words. We replace them with real photos from Pexels (free key),
// or, without a key, with random real photos from picsum.photos.
const photoCache = new Map();
async function findPhotos(query) {
  const key = query.toLowerCase();
  const hit = photoCache.get(key);
  if (hit && Date.now() - hit.t < 86400_000) return hit.list;
  let list = [];
  if (PEXELS_API_KEY) {
    try {
      const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=6&orientation=landscape`, {
        headers: { Authorization: PEXELS_API_KEY },
      });
      if (r.ok) list = ((await r.json()).photos || []).map((p) => p.src && (p.src.large2x || p.src.large)).filter(Boolean);
      else console.error('Pexels', r.status);
    } catch (e) { console.error('Pexels error:', e.message); }
  }
  photoCache.set(key, { list, t: Date.now() });
  if (photoCache.size > 500) photoCache.delete(photoCache.keys().next().value);
  return list;
}
async function addPhotos(html) {
  if (!html || !/photo:/i.test(html)) return html;
  const re = /photo:([^"')<>\n]{2,80})/gi;
  const queries = [...new Set([...html.matchAll(re)].map((m) => m[1].trim()))].slice(0, 12);
  const used = new Map();
  let fromPexels = false;
  const urls = new Map();
  await Promise.all(queries.map(async (q) => {
    const list = await findPhotos(q);
    urls.set(q, list);
  }));
  html = html.replace(re, (all, q) => {
    q = q.trim();
    const list = urls.get(q) || [];
    const n = used.get(q) || 0;
    used.set(q, n + 1);
    if (list.length) { fromPexels = true; return list[n % list.length]; }
    const seed = encodeURIComponent(q.replace(/\s+/g, '-').toLowerCase() + (n ? '-' + n : ''));
    return `https://picsum.photos/seed/${seed}/1600/1000`;
  });
  if (fromPexels && !/pexels\.com"[^>]*>Pexels/i.test(html)) {
    const credit = '<p style="text-align:center;font:12px/1.4 system-ui,sans-serif;opacity:.6;margin:18px 0">Photos: <a href="https://www.pexels.com" target="_blank" rel="noopener" style="color:inherit">Pexels</a></p>';
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, credit + '</body>') : html + credit;
  }
  return html;
}

// Take the website (```html ... ```) out of the answer, before reading the JSON.
function splitWebsite(text) {
  let raw = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  let website = null;
  const fence = raw.match(/```html\s*\n?([\s\S]*?)(?:```|$)/i);
  if (fence && /<html|<!doctype|<body/i.test(fence[1])) {
    website = fence[1].trim();
    raw = raw.replace(fence[0], '');
  } else {
    const bare = raw.match(/<!DOCTYPE html[\s\S]*?(?:<\/html>|$)/i);
    // Skip it when the website sits inside a JSON string ("website": "<!DOCTYPE ...): the JSON reader takes it.
    if (bare && raw[bare.index - 1] !== '"') { website = bare[0].trim(); raw = raw.replace(bare[0], ''); }
  }
  return { rest: raw.trim(), website };
}

// Models sometimes put real line breaks inside JSON strings. Fix that.
function repairJSON(str) {
  let out = '', inStr = false, esc = false;
  for (const ch of str) {
    if (inStr) {
      if (esc) { esc = false; out += ch; continue; }
      if (ch === '\\') { esc = true; out += ch; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') continue;
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

function extractJSON(text) {
  const raw = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const tries = [raw];
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) tries.push(m[0]);
  for (const s of tries) {
    for (const candidate of [s, repairJSON(s)]) {
      try {
        const j = JSON.parse(candidate);
        if (j && typeof j === 'object' && ('reply' in j || 'operations' in j)) return j;
      } catch { /* next */ }
    }
  }
  // Not JSON at all: treat the whole text as a normal answer.
  if (raw && !raw.startsWith('{')) return { reply: raw, operations: [] };
  const r = raw.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (r) { try { return { reply: JSON.parse('"' + r[1] + '"'), operations: [] }; } catch { /* ignore */ } }
  return null;
}

async function chat(url, key, model, messages, jsonMode) {
  const body = { messages, temperature: 0.4, max_tokens: 12000 };
  if (Array.isArray(model)) body.models = model.slice(0, 3); else body.model = model;
  if (jsonMode) body.response_format = { type: 'json_object' };
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Markingspb AI' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content || '';
}

function parseAnswer(text) {
  const { rest, website } = splitWebsite(text);
  let out = rest ? extractJSON(rest) : null;
  if (!out && website) out = { reply: '', operations: [] };
  if (!out) return null;
  // The website may also come inside the JSON, or inside "reply".
  let site = website || (typeof out.website === 'string' && out.website) || (typeof out.html === 'string' && out.html) || null;
  if (!site && typeof out.reply === 'string') {
    const m = out.reply.match(/```html\s*([\s\S]*?)(?:```|$)/i) || out.reply.match(/<!DOCTYPE html[\s\S]*?(?:<\/html>|$)/i);
    if (m) { site = m[1] || m[0]; out.reply = out.reply.replace(m[0], '').trim(); }
  }
  out.website = site && /<html|<!doctype|<body/i.test(site) ? fixHtml(site) : null;
  return out;
}

async function askAI(messages) {
  const errors = [];
  if (GROQ_API_KEY) {
    try {
      const out = parseAnswer(await chat('https://api.groq.com/openai/v1/chat/completions', GROQ_API_KEY, GROQ_MODEL, messages, true));
      if (out) return out;
      errors.push('groq: bad json');
    } catch (e) { errors.push(e.message); }
  }
  if (OPENROUTER_API_KEY) {
    try {
      const out = parseAnswer(await chat('https://openrouter.ai/api/v1/chat/completions', OPENROUTER_API_KEY, OPENROUTER_MODELS, messages, false));
      if (out) return out;
      errors.push('openrouter: bad json');
    } catch (e) { errors.push(e.message); }
    // Last resort: any free model.
    try {
      const out = parseAnswer(await chat('https://openrouter.ai/api/v1/chat/completions', OPENROUTER_API_KEY, 'openrouter/free', messages, false));
      if (out) return out;
    } catch (e) { errors.push(e.message); }
  }
  if (!GROQ_API_KEY && !OPENROUTER_API_KEY) errors.push('No API key. Add GROQ_API_KEY in Render → Environment.');
  throw new Error(errors.join(' | '));
}

// ---------- API ----------
async function handlePlan(req, res) {
  if (!allowed(req, 'plan')) return sendJSON(res, 429, { error: 'limit' });
  let input;
  try { input = JSON.parse((await readBody(req, 400_000)).toString('utf8')); }
  catch { return sendJSON(res, 400, { error: 'bad_request' }); }

  const message = String(input.message || '').slice(0, 8000);
  const v = input.video || null;
  const history = Array.isArray(input.history) ? input.history.slice(-12) : [];
  const site = typeof input.site === 'string' && input.site.trim() ? input.site.slice(0, 60000) : '';
  const context = (v
    ? `Current video: duration ${Number(v.duration).toFixed(2)} s, size ${v.width}x${v.height}, has sound: ${v.hasAudio ? 'yes' : 'no'}. Music file attached: ${input.hasMusic ? 'yes' : 'no'}.`
    : 'No video is loaded yet.') + (site ? `\nCurrent website (change THIS one if the user asks to edit the website):\n\`\`\`html\n${site}\n\`\`\`` : '');

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 4000) })),
    { role: 'user', content: `${context}\nRequest: ${message}` },
  ];

  try {
    const out = await askAI(messages);
    if (out.website) out.website = await addPhotos(out.website);
    const operations = Array.isArray(out.operations) ? out.operations.filter((o) => o && typeof o.op === 'string').slice(0, 30) : [];
    sendJSON(res, 200, { reply: String(out.reply || ''), operations, website: out.website || null });
  } catch (e) {
    console.error('AI error:', e.message);
    sendJSON(res, 502, { error: 'ai_unavailable' });
  }
}

async function handleTranscribe(req, res, url) {
  if (!allowed(req, 'stt')) return sendJSON(res, 429, { error: 'limit' });
  if (!GROQ_API_KEY) return sendJSON(res, 500, { error: 'no_key' });
  let audio;
  try { audio = await readBody(req, 24 * 1024 * 1024); }
  catch { return sendJSON(res, 413, { error: 'too_big' }); }

  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/mp4' }), 'audio.m4a');
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'verbose_json');
  const lang = url.searchParams.get('language');
  if (lang && /^[a-z]{2}$/.test(lang)) form.append('language', lang);

  try {
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${GROQ_API_KEY}` }, body: form,
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 300)}`);
    const data = await r.json();
    const segments = (data.segments || []).map((s) => ({ start: s.start, end: s.end, text: s.text }));
    sendJSON(res, 200, { segments, language: data.language || null });
  } catch (e) {
    console.error('Transcribe error:', e.message);
    sendJSON(res, 502, { error: 'stt_unavailable' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'POST' && url.pathname === '/api/plan') return await handlePlan(req, res);
    if (req.method === 'POST' && url.pathname === '/api/transcribe') return await handleTranscribe(req, res, url);
    if (url.pathname === '/api/health') return sendJSON(res, 200, { ok: true, groq: !!GROQ_API_KEY, openrouter: !!OPENROUTER_API_KEY, firebase: !!FIREBASE, photos: PEXELS_API_KEY ? 'pexels' : 'picsum' });
    if (url.pathname === '/api/config') return sendJSON(res, 200, { firebase: FIREBASE });
    const siteMatch = url.pathname.match(/^\/s\/([^/]+)\/?$/);
    if (siteMatch && (req.method === 'GET' || req.method === 'HEAD')) return await serveSite(res, siteMatch[1]);
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, url.pathname);
    sendJSON(res, 405, { error: 'method' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJSON(res, 500, { error: 'server' });
  }
});

server.listen(PORT, () => console.log(`Markingspb AI is running on port ${PORT}`));
