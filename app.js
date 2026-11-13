// Markingspb AI — browser app (chat style).
// The video never leaves the user's device: editing runs here with ffmpeg.wasm.
// Only the text request (and, for subtitles, the sound) goes to the server.

import { FFmpeg } from '/vendor/ffmpeg/index.js';
import { fetchFile } from '/vendor/util/index.js';
import { buildEdit, splitAtSubtitles, subtitleOps } from '/pipeline.js';

// ---------- texts (RU / EN) ----------
const T = {
  ru: {
    newChat: 'Новый чат',
    privacy: 'Видео не загружается на сервер — монтаж идёт прямо в вашем браузере.',
    welcomeTitle: 'Чем могу помочь?',
    welcomeSub: 'Спросите что угодно — или прикрепите видео 📎, и я его смонтирую.',
    recent: 'Чаты', copy: 'Копировать', copied: 'Скопировано ✓', deleteChat: 'Удалить чат',
    videoNotSaved: 'Видео из прошлых чатов не сохраняются. Прикрепите видео снова, если нужно.',
    addVideo: 'Видео', addMusic: 'Музыка',
    placeholder: 'Спросите что угодно…',
    disclaimer: 'Markingspb AI может ошибаться. Проверяйте результат перед публикацией.',
    dropHere: 'Отпустите видео здесь',
    download: 'Скачать', undo: 'Отменить', undone: 'Отменено ↩',
    loadingEngine: 'Загружаю видеоредактор (первый раз ~30 МБ)…',
    reading: 'Читаю видео…', thinking: 'Думаю…', editing: 'Монтирую видео…', listening: 'Распознаю речь…',
    videoReady: 'Видео загружено. Что с ним сделать?',
    musicAdded: 'Музыка прикреплена. Напишите, например: «добавь музыку тихо».',
    noVideo: 'Сначала прикрепите видео кнопкой 📎 Видео.',
    aiError: 'ИИ сейчас не отвечает. Попробуйте ещё раз через минуту.',
    limit: 'Слишком много запросов. Подождите немного.',
    editError: 'Не получилось смонтировать. Попробуйте сказать иначе.',
    readError: 'Не получилось открыть это видео. Попробуйте другой файл (лучше MP4).',
    noSpeech: 'В видео нет звука, поэтому субтитры сделать нельзя.',
    sttError: 'Не получилось распознать речь для субтитров.',
    musicMissing: 'Чтобы добавить музыку, прикрепите её кнопкой 🎵 Музыка.',
    big: 'Видео большое — монтаж в браузере может быть медленным.',
    busy: 'Подождите, я ещё работаю…',
    chips: ['Придумай 5 идей для постов в Instagram', 'Напиши рекламный текст для кофейни', 'Объясни простыми словами, что такое воронка продаж', 'Как смонтировать видео для Reels?'],
  },
  en: {
    newChat: 'New chat',
    privacy: 'Your video is not uploaded — editing happens right in your browser.',
    welcomeTitle: 'How can I help you today?',
    welcomeSub: 'Ask me anything — or attach a video 📎 and I will edit it.',
    recent: 'Chats', copy: 'Copy', copied: 'Copied ✓', deleteChat: 'Delete chat',
    videoNotSaved: 'Videos from past chats are not saved. Attach the video again if you need it.',
    addVideo: 'Video', addMusic: 'Music',
    placeholder: 'Ask anything…',
    disclaimer: 'Markingspb AI can make mistakes. Check the result before posting.',
    dropHere: 'Drop your video here',
    download: 'Download', undo: 'Undo', undone: 'Undone ↩',
    loadingEngine: 'Loading the video editor (first time ~30 MB)…',
    reading: 'Reading the video…', thinking: 'Thinking…', editing: 'Editing the video…', listening: 'Listening for subtitles…',
    videoReady: 'Video loaded. What should I do with it?',
    musicAdded: 'Music attached. Try: "add the music quietly".',
    noVideo: 'Please attach a video first with the 📎 Video button.',
    aiError: 'The AI is not answering right now. Please try again in a minute.',
    limit: 'Too many requests. Please wait a little.',
    editError: "The edit didn't work. Try saying it differently.",
    readError: "I couldn't open this video. Try another file (MP4 works best).",
    noSpeech: 'This video has no sound, so subtitles are not possible.',
    sttError: 'Speech recognition for subtitles failed.',
    musicMissing: 'To add music, attach it with the 🎵 Music button.',
    big: 'This video is large — editing in the browser may be slow.',
    busy: 'Please wait, I am still working…',
    chips: ['Give me 5 Instagram post ideas', 'Write an ad for a coffee shop', 'Explain a sales funnel in simple words', 'How do I edit a video for Reels?'],
  },
};
let lang = 'ru';
try { lang = localStorage.getItem('lang') || ((navigator.language || 'ru').toLowerCase().startsWith('en') ? 'en' : 'ru'); } catch { /* ignore */ }
const t = (k) => T[lang][k];

// ---------- elements ----------
const $ = (id) => document.getElementById(id);
const scroll = $('scroll'), thread = $('messages'), form = $('form'), text = $('text'), sendBtn = $('sendBtn');
const attachments = $('attachments'), dropzone = $('dropzone');

// ---------- state ----------
const ffmpeg = new FFmpeg();
let engineReady = null;
let logLines = [];
let versions = [];          // [{ blob, info, card }]
let musicName = null;
let chats = loadChats();     // saved chats (text only)
let chat = null;             // the open chat: { id, title, messages: [{ role, content }], updated, hadVideo }
let working = false;
let progressBar = null;

ffmpeg.on('log', ({ message }) => { logLines.push(message); if (logLines.length > 400) logLines.shift(); });
ffmpeg.on('progress', ({ progress }) => {
  if (progressBar) progressBar.style.width = Math.round(Math.min(1, Math.max(0, progress || 0)) * 100) + '%';
});

// ---------- UI helpers ----------
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
  text.placeholder = t('placeholder');
  document.querySelectorAll('.lang button').forEach((b) => b.classList.toggle('on', b.dataset.lang === lang));
  const chips = $('chips');
  chips.innerHTML = '';
  for (const c of t('chips')) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.textContent = c;
    b.onclick = () => { text.value = c; send(); };
    chips.appendChild(b);
  }
  if (typeof renderChatList === 'function' && document.getElementById('chatList')) renderChatList();
}

function toBottom() { requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; }); }

function started() { document.body.classList.remove('empty'); }

function userMsg(content) {
  started();
  const row = document.createElement('div');
  row.className = 'row user';
  const b = document.createElement('div');
  b.className = 'bubble';
  if (typeof content === 'string') b.textContent = content; else b.appendChild(content);
  row.appendChild(b);
  thread.appendChild(row);
  toBottom();
  return row;
}

function aiMsg(content, kind = '') {
  started();
  const row = document.createElement('div');
  row.className = 'row ai ' + kind;
  const img = document.createElement('img');
  img.className = 'avatar'; img.src = '/logo.svg'; img.alt = '';
  const c = document.createElement('div');
  c.className = 'content';
  if (typeof content === 'string') c.textContent = content; else if (content) c.appendChild(content);
  row.append(img, c);
  thread.appendChild(row);
  toBottom();
  return c;
}

// A "working…" message with a progress bar. Returns { set(label), done() }.
function status(label) {
  const box = document.createElement('div');
  box.className = 'status';
  const dot = document.createElement('span'); dot.className = 'pulse';
  const lab = document.createElement('span'); lab.textContent = label;
  const bar = document.createElement('div'); bar.className = 'pbar';
  const fill = document.createElement('i'); bar.appendChild(fill);
  box.append(dot, lab, bar);
  const c = aiMsg(box);
  return {
    set(l, withBar = false) { lab.textContent = l; bar.hidden = !withBar; fill.style.width = '0%'; progressBar = withBar ? fill : null; },
    done() { progressBar = null; c.parentElement.remove(); },
  };
}

// ---------- Markdown (safe: all text is escaped first) ----------
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function inline(raw) {
  return raw.split(/(`[^`\n]+`)/).map((part, i) => {
    if (i % 2) return '<code>' + esc(part.slice(1, -1)) + '</code>';
    return esc(part)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }).join('');
}
const isUl = (l) => /^\s*[-*•]\s+/.test(l);
const isOl = (l) => /^\s*\d+[.)]\s+/.test(l);
const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const isBlock = (l) => /^```/.test(l) || /^#{1,6}\s/.test(l) || isUl(l) || isOl(l) || /^\s*>/.test(l) || /^\s*(-{3,}|\*{3,})\s*$/.test(l) || isTableRow(l);
const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => inline(c.trim()));
function markdown(src) {
  const lines = String(src).replace(/\r/g, '').split('\n');
  let html = '', i = 0;
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if (/^```/.test(l)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      html += '<pre><button class="copy-code" type="button">⧉</button><code>' + esc(buf.join('\n')) + '</code></pre>';
    } else if ((m = l.match(/^(#{1,6})\s+(.*)/))) {
      const n = Math.min(4, m[1].length + 1);
      html += `<h${n}>${inline(m[2])}</h${n}>`; i++;
    } else if (isUl(l)) {
      html += '<ul>';
      while (i < lines.length && isUl(lines[i])) html += '<li>' + inline(lines[i++].replace(/^\s*[-*•]\s+/, '')) + '</li>';
      html += '</ul>';
    } else if (isOl(l)) {
      const first = parseInt(l, 10) || 1;
      html += first > 1 ? `<ol start="${first}">` : '<ol>';
      while (i < lines.length && (isOl(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && !isBlock(lines[i])))) {
        if (isOl(lines[i])) html += '<li>' + inline(lines[i++].replace(/^\s*\d+[.)]\s+/, '')) + '</li>';
        else html = html.replace(/<\/li>$/, '<br>' + inline(lines[i++].trim()) + '</li>');
      }
      html += '</ol>';
    } else if (isTableRow(l) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      html += '<div class="table-wrap"><table><thead><tr>' + cells(l).map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) html += '<tr>' + cells(lines[i++]).map((c) => `<td>${c}</td>`).join('') + '</tr>';
      html += '</tbody></table></div>';
    } else if (/^\s*>/.test(l)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(inline(lines[i++].replace(/^\s*>\s?/, '')));
      html += '<blockquote>' + buf.join('<br>') + '</blockquote>';
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) {
      html += '<hr>'; i++;
    } else if (!l.trim()) {
      i++;
    } else {
      const buf = [l]; i++;
      while (i < lines.length && lines[i].trim() && !isBlock(lines[i])) buf.push(lines[i++]);
      html += '<p>' + buf.map(inline).join('<br>') + '</p>';
    }
  }
  return html;
}

// Show an AI answer with Markdown, a ChatGPT-like typing effect and a Copy button.
function aiAnswer(reply, { typing = true, kind = '' } = {}) {
  const c = aiMsg(null, kind);
  const body = document.createElement('div');
  body.className = 'md';
  c.appendChild(body);
  const finish = () => {
    body.innerHTML = markdown(reply);
    body.querySelectorAll('.copy-code').forEach((b) => {
      b.onclick = () => copyText(b.nextElementSibling.textContent, b, '⧉');
    });
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const cp = document.createElement('button');
    cp.type = 'button'; cp.className = 'mini'; cp.textContent = '⧉ ' + t('copy');
    cp.onclick = () => copyText(reply, cp, '⧉ ' + t('copy'));
    actions.appendChild(cp);
    c.appendChild(actions);
    toBottom();
  };
  if (!typing || reply.length < 4) { finish(); return Promise.resolve(c); }
  return new Promise((resolve) => {
    const step = Math.max(2, Math.ceil(reply.length / 90));
    let n = 0;
    const tick = () => {
      n += step;
      if (n >= reply.length) { finish(); resolve(c); return; }
      body.innerHTML = markdown(reply.slice(0, n)) ;
      if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 160) scroll.scrollTop = scroll.scrollHeight;
      setTimeout(tick, 16);
    };
    tick();
  });
}

async function copyText(str, btn, label) {
  try { await navigator.clipboard.writeText(str); }
  catch {
    const ta = document.createElement('textarea'); ta.value = str; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ } ta.remove();
  }
  btn.textContent = btn.classList.contains('copy-code') ? '✓' : t('copied');
  setTimeout(() => { btn.textContent = label; }, 1500);
}

// ---------- saved chats (only text is saved, in this browser) ----------
function loadChats() {
  try { const a = JSON.parse(localStorage.getItem('mspb_chats') || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
function saveChats() {
  chats.sort((a, b) => b.updated - a.updated);
  chats = chats.slice(0, 40);
  try { localStorage.setItem('mspb_chats', JSON.stringify(chats)); } catch { /* storage full or blocked */ }
  renderChatList();
}
function remember(role, content) {
  if (!chat) {
    chat = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: '', messages: [], updated: Date.now(), hadVideo: false };
    chats.unshift(chat);
  }
  if (!chat.title && (role === 'user' || role === 'note')) chat.title = content.replace(/\s+/g, ' ').slice(0, 48);
  chat.messages.push({ role, content: String(content).slice(0, 12000) });
  if (chat.messages.length > 80) chat.messages = chat.messages.slice(-80);
  chat.updated = Date.now();
  saveChats();
}
function aiHistory() {
  return (chat ? chat.messages : []).filter((m) => m.role === 'user' || m.role === 'assistant').slice(-12);
}
function renderChatList() {
  const list = $('chatList');
  list.innerHTML = '';
  if (!chats.length) return;
  const h = document.createElement('div'); h.className = 'side-label'; h.textContent = t('recent');
  list.appendChild(h);
  for (const c of chats) {
    const item = document.createElement('div');
    item.className = 'chat-item' + (chat && c.id === chat.id ? ' on' : '');
    const title = document.createElement('button');
    title.type = 'button'; title.className = 'chat-title'; title.textContent = c.title || '…';
    title.onclick = () => openChat(c.id);
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'chat-del'; del.textContent = '×'; del.title = t('deleteChat');
    del.onclick = (e) => { e.stopPropagation(); deleteChat(c.id); };
    item.append(title, del);
    list.appendChild(item);
  }
}
async function resetVideo() {
  versions = [];
  for (const f of ['cur.mp4', 'out.mp4', musicName]) if (f) await ffmpeg.deleteFile(f).catch(() => {});
  musicName = null; showMusicChip(null);
}
async function openChat(id) {
  if (working) return;
  const c = chats.find((x) => x.id === id);
  if (!c) return;
  await resetVideo();
  chat = c;
  thread.innerHTML = '';
  document.body.classList.remove('empty', 'menu');
  for (const m of c.messages) {
    if (m.role === 'user') userMsg(m.content);
    else if (m.role === 'assistant') aiAnswer(m.content, { typing: false });
    else if (m.role === 'note') { const n = document.createElement('div'); n.className = 'row note'; n.textContent = m.content; thread.appendChild(n); }
  }
  if (c.hadVideo) { const n = document.createElement('div'); n.className = 'row note'; n.textContent = t('videoNotSaved'); thread.appendChild(n); }
  renderChatList();
  toBottom();
}
function deleteChat(id) {
  chats = chats.filter((x) => x.id !== id);
  if (chat && chat.id === id) newChat();
  saveChats();
}

function videoCard(version) {
  const card = document.createElement('div');
  card.className = 'vcard';
  const v = document.createElement('video');
  v.controls = true; v.playsInline = true; v.preload = 'metadata';
  const url = URL.createObjectURL(version.blob);
  v.src = url;
  const bar = document.createElement('div');
  bar.className = 'vactions';
  const dl = document.createElement('a');
  dl.className = 'vbtn primary'; dl.href = url; dl.download = 'markingspb-ai-video.mp4';
  dl.textContent = '⬇ ' + t('download');
  const undo = document.createElement('button');
  undo.type = 'button'; undo.className = 'vbtn undo'; undo.textContent = '↩ ' + t('undo');
  undo.onclick = doUndo;
  const meta = document.createElement('span');
  meta.className = 'vmeta';
  const i = version.info;
  meta.textContent = `${i.width}×${i.height} · ${i.duration.toFixed(1)} s · ${(version.blob.size / 1048576).toFixed(1)} MB`;
  bar.append(dl, undo, meta);
  card.append(v, bar);
  return card;
}

function markLatest() {
  versions.forEach((ver, idx) => { if (ver.card) ver.card.classList.toggle('old', idx !== versions.length - 1); });
}

function setWorking(on) { working = on; sendBtn.disabled = on; }

function autosize() { text.style.height = 'auto'; text.style.height = Math.min(text.scrollHeight, 200) + 'px'; }

function showMusicChip(name) {
  attachments.innerHTML = '';
  if (!name) return;
  const chip = document.createElement('span');
  chip.className = 'att';
  chip.textContent = '🎵 ' + (name.length > 28 ? name.slice(0, 26) + '…' : name);
  const x = document.createElement('button');
  x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Remove');
  x.onclick = async () => { if (musicName) await ffmpeg.deleteFile(musicName).catch(() => {}); musicName = null; showMusicChip(null); };
  chip.appendChild(x);
  attachments.appendChild(chip);
}

// ---------- engine ----------
function loadEngine() {
  if (!engineReady) {
    engineReady = (async () => {
      await ffmpeg.load({ coreURL: '/vendor/core/ffmpeg-core.js', wasmURL: '/vendor/core/ffmpeg-core.wasm' });
      await ffmpeg.writeFile('/font.ttf', await fetchFile('/DejaVuSans-Bold.ttf'));
    })();
    engineReady.catch(() => { engineReady = null; });
  }
  return engineReady;
}

// Size, length, sound and phone rotation, from FFmpeg's own report.
async function probe(file) {
  logLines = [];
  await ffmpeg.exec(['-hide_banner', '-i', file]);
  const log = logLines.join('\n');
  const dur = log.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const size = log.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
  if (!dur || !size) throw new Error('probe');
  let width = +size[1], height = +size[2];
  const rot = log.match(/rotation of (-?[\d.]+)/) || log.match(/rotate\s*:\s*(-?\d+)/);
  if (rot && Math.abs(Math.round(+rot[1])) % 180 === 90) [width, height] = [height, width];
  return { width, height, duration: +dur[1] * 3600 + +dur[2] * 60 + +dur[3], hasAudio: /Stream #.*Audio:/.test(log) };
}

// ---------- files ----------
async function loadVideo(file) {
  if (!file) return;
  if (working) { aiMsg(t('busy')); return; }
  const chip = document.createElement('div');
  chip.className = 'file-chip';
  const pv = document.createElement('video');
  pv.src = URL.createObjectURL(file); pv.muted = true; pv.playsInline = true; pv.preload = 'metadata';
  const name = document.createElement('div');
  name.textContent = '🎬 ' + file.name;
  const small = document.createElement('small');
  small.textContent = (file.size / 1048576).toFixed(1) + ' MB';
  name.appendChild(small);
  chip.append(pv, name);
  userMsg(chip);
  remember('note', '🎬 ' + file.name);
  if (chat) { chat.hadVideo = true; saveChats(); }

  setWorking(true);
  const st = status(t('loadingEngine'));
  try {
    await loadEngine();
    st.set(t('reading'));
    await ffmpeg.writeFile('cur.mp4', await fetchFile(file));
    const info = await probe('cur.mp4');
    versions.forEach((v) => v.card && v.card.classList.add('old'));
    versions = [{ blob: file, info, card: null }];
    st.done();
    if (file.size > 300 * 1048576) aiMsg(t('big'));
    aiMsg(t('videoReady'));
  } catch (e) {
    console.error(e);
    st.done();
    aiMsg(t('readError'), 'error');
  } finally { setWorking(false); }
}

async function loadMusic(file) {
  if (!file) return;
  try {
    await loadEngine();
    const ext = (file.name.match(/\.[a-z0-9]{1,5}$/i) || ['.mp3'])[0].toLowerCase();
    if (musicName) await ffmpeg.deleteFile(musicName).catch(() => {});
    musicName = 'music' + ext;
    await ffmpeg.writeFile(musicName, await fetchFile(file));
    showMusicChip(file.name);
    if (versions.length) aiMsg(t('musicAdded'));
  } catch (e) { console.error(e); }
}

// ---------- editing ----------
async function runEdit(ops, curInfo, st) {
  const { args, files, info: newInfo, warnings } = buildEdit(ops, curInfo, {
    input: 'cur.mp4', output: 'out.mp4', music: musicName, font: '/font.ttf', dir: '/',
  });
  if (warnings.includes('music_missing')) aiMsg(t('musicMissing'));
  const enc = new TextEncoder();
  for (const [p, c] of Object.entries(files)) await ffmpeg.writeFile(p, enc.encode(c));
  logLines = [];
  st.set(t('editing'), true);
  const code = await ffmpeg.exec(args);
  for (const p of Object.keys(files)) await ffmpeg.deleteFile(p).catch(() => {});
  if (code !== 0) { console.error(logLines.slice(-25).join('\n')); throw new Error('ffmpeg ' + code); }
  const data = await ffmpeg.readFile('out.mp4');
  const blob = new Blob([data.slice()], { type: 'video/mp4' }); // before writeFile: it hands the memory to the worker
  await ffmpeg.deleteFile('cur.mp4').catch(() => {});
  await ffmpeg.writeFile('cur.mp4', data);
  await ffmpeg.deleteFile('out.mp4').catch(() => {});
  newInfo.duration = (await probe('cur.mp4')).duration;
  return { blob, info: newInfo, card: null };
}

async function transcribe(curInfo, language, st) {
  if (!curInfo.hasAudio) throw new Error('nosound');
  st.set(t('listening'));
  const code = await ffmpeg.exec(['-i', 'cur.mp4', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '48k', '-y', 'stt.m4a']);
  if (code !== 0) throw new Error('stt');
  const audio = await ffmpeg.readFile('stt.m4a');
  await ffmpeg.deleteFile('stt.m4a').catch(() => {});
  const q = language ? '?language=' + encodeURIComponent(language) : '';
  const r = await fetch('/api/transcribe' + q, { method: 'POST', headers: { 'Content-Type': 'audio/mp4' }, body: audio });
  if (!r.ok) throw new Error('stt');
  return (await r.json()).segments || [];
}

async function apply(operations, st) {
  const start = versions.at(-1);
  let cur = start;
  let pending = [];
  for (const seg of splitAtSubtitles(operations)) {
    if (seg.type === 'edit') { pending.push(...seg.ops); continue; }
    if (pending.length) { cur = await runEdit(pending, cur.info, st); pending = []; }
    pending.push(...subtitleOps(await transcribe(cur.info, seg.language, st)));
  }
  if (pending.length) cur = await runEdit(pending, cur.info, st);
  return cur === start ? null : cur;
}

async function doUndo() {
  if (versions.length < 2 || working) return;
  setWorking(true);
  try {
    const last = versions.pop();
    last.card.classList.add('undone');
    const label = last.card.querySelector('.vmeta');
    if (label) label.textContent = t('undone');
    await ffmpeg.writeFile('cur.mp4', await fetchFile(versions.at(-1).blob));
    markLatest();
  } finally { setWorking(false); }
}

// ---------- chat ----------
async function send() {
  const message = text.value.trim();
  if (!message) return;
  if (working) { aiMsg(t('busy')); return; }
  text.value = ''; autosize();
  const history = aiHistory();
  userMsg(message);
  remember('user', message);
  const cur = versions.at(-1);
  setWorking(true);
  const st = status(t('thinking'));
  try {
    const r = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history, video: cur ? cur.info : null, hasMusic: !!musicName }),
    });
    if (r.status === 429) { st.done(); aiMsg(t('limit'), 'error'); return; }
    if (!r.ok) { st.done(); aiMsg(t('aiError'), 'error'); return; }
    const { reply, operations } = await r.json();
    remember('assistant', reply || '…');

    if (!operations.length) { st.done(); await aiAnswer(reply || '…'); return; }
    if (!cur) { st.done(); aiMsg(t('noVideo')); return; }

    try {
      const result = await apply(operations, st);
      st.done();
      const c = await aiAnswer(reply || '✔');
      if (result) {
        result.card = videoCard(result);
        c.appendChild(result.card);
        versions.push(result);
        markLatest();
        toBottom();
      }
    } catch (e) {
      console.error(e);
      st.done();
      aiMsg(e.message === 'nosound' ? t('noSpeech') : e.message === 'stt' ? t('sttError') : t('editError'), 'error');
    }
  } catch (e) {
    console.error(e);
    st.done();
    aiMsg(t('aiError'), 'error');
  } finally { setWorking(false); }
}

async function newChat() {
  if (working) return;
  thread.innerHTML = '';
  chat = null;
  await resetVideo();
  renderChatList();
  document.body.classList.add('empty');
  document.body.classList.remove('menu');
  text.focus();
}

// ---------- events ----------
form.addEventListener('submit', (e) => { e.preventDefault(); send(); });
text.addEventListener('input', autosize);
text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
$('videoInput').addEventListener('change', (e) => { loadVideo(e.target.files[0]); e.target.value = ''; });
$('musicInput').addEventListener('change', (e) => { loadMusic(e.target.files[0]); e.target.value = ''; });
$('newChat').addEventListener('click', newChat);
$('newChat2').addEventListener('click', newChat);
$('menuBtn').addEventListener('click', () => document.body.classList.add('menu'));
$('backdrop').addEventListener('click', () => document.body.classList.remove('menu'));

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; dropzone.hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropzone.hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; dropzone.hidden = true;
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (f.type.startsWith('audio/')) loadMusic(f); else loadVideo(f);
});

document.querySelectorAll('.lang button').forEach((b) => b.addEventListener('click', () => {
  lang = b.dataset.lang;
  try { localStorage.setItem('lang', lang); } catch { /* ignore */ }
  applyLang();
}));

applyLang();
renderChatList();
loadEngine().catch(() => {}); // start downloading the editor in the background
