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
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-large-v3-turbo';
const LIMIT_PER_HOUR = Number(process.env.LIMIT_PER_HOUR || 60);

// ---------- static files ----------
const STATIC = [
  ['/vendor/ffmpeg/', path.join(__dirname, 'node_modules/@ffmpeg/ffmpeg/dist/esm')],
  ['/vendor/util/', path.join(__dirname, 'node_modules/@ffmpeg/util/dist/esm')],
  ['/vendor/core/', path.join(__dirname, 'node_modules/@ffmpeg/core/dist/esm')],
  ['/', __dirname],
];
// Only these files from the main folder are shown to visitors.
const PUBLIC_FILES = new Set(['index.html', 'app.js', 'pipeline.js', 'style.css', 'logo.svg', 'DejaVuSans-Bold.ttf']);
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
  const raw = String(text || '').trim();
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
  const body = { model, messages, temperature: 0.4, max_tokens: 4000 };
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

async function askAI(messages) {
  const errors = [];
  if (GROQ_API_KEY) {
    try {
      const out = extractJSON(await chat('https://api.groq.com/openai/v1/chat/completions', GROQ_API_KEY, GROQ_MODEL, messages, true));
      if (out) return out;
      errors.push('groq: bad json');
    } catch (e) { errors.push(e.message); }
  }
  if (OPENROUTER_API_KEY) {
    try {
      const out = extractJSON(await chat('https://openrouter.ai/api/v1/chat/completions', OPENROUTER_API_KEY, OPENROUTER_MODEL, messages, true));
      if (out) return out;
      errors.push('openrouter: bad json');
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
  const context = v
    ? `Current video: duration ${Number(v.duration).toFixed(2)} s, size ${v.width}x${v.height}, has sound: ${v.hasAudio ? 'yes' : 'no'}. Music file attached: ${input.hasMusic ? 'yes' : 'no'}.`
    : 'No video is loaded yet.';

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 4000) })),
    { role: 'user', content: `${context}\nRequest: ${message}` },
  ];

  try {
    const out = await askAI(messages);
    const operations = Array.isArray(out.operations) ? out.operations.filter((o) => o && typeof o.op === 'string').slice(0, 30) : [];
    sendJSON(res, 200, { reply: String(out.reply || ''), operations });
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
    if (url.pathname === '/api/health') return sendJSON(res, 200, { ok: true, groq: !!GROQ_API_KEY, openrouter: !!OPENROUTER_API_KEY });
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, url.pathname);
    sendJSON(res, 405, { error: 'method' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJSON(res, 500, { error: 'server' });
  }
});

server.listen(PORT, () => console.log(`Markingspb AI is running on port ${PORT}`));
