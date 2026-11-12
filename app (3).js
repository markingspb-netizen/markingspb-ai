// Markingspb AI — browser app. Video never leaves the user's device:
// editing runs here with ffmpeg.wasm. Only the text request goes to the AI.

import { FFmpeg } from '/vendor/ffmpeg/index.js';
import { fetchFile } from '/vendor/util/index.js';
import { buildEdit, splitAtSubtitles, subtitleOps } from '/pipeline.js';

// ---------- texts (RU / EN) ----------
const T = {
  ru: {
    drop: 'Перетащите видео сюда или нажмите, чтобы выбрать',
    dropHint: 'Лучше всего — короткие ролики до 3 минут',
    newVideo: 'Видео', music: 'Музыка', undo: 'Отменить', download: 'Скачать',
    placeholder: 'Напишите, что сделать с видео…',
    hello: 'Привет! Я Markingspb AI. Загрузите видео и напишите, что изменить: обрезать, сделать вертикальным для Reels, добавить надпись, субтитры, музыку, фильтр…',
    loadingEngine: 'Загружаю видеоредактор (первый раз ~30 МБ)…',
    reading: 'Читаю видео…', thinking: 'Думаю…', editing: 'Монтирую видео…', listening: 'Распознаю речь для субтитров…',
    loaded: 'Видео загружено', musicOn: 'Музыка: ', done: 'Готово ✔', undone: 'Отменено',
    noVideo: 'Сначала загрузите видео 🙂',
    aiError: 'ИИ сейчас не отвечает. Попробуйте ещё раз через минуту.',
    limit: 'Слишком много запросов. Подождите немного.',
    editError: 'Не получилось смонтировать. Попробуйте сказать иначе.',
    noSpeech: 'В видео нет звука, субтитры сделать нельзя.',
    sttError: 'Не получилось распознать речь.',
    musicMissing: 'Прикрепите музыку кнопкой 🎵 Музыка.',
    big: 'Видео большое — монтаж в браузере может быть медленным.',
    chips: ['Сделай вертикально для Reels', 'Добавь субтитры', 'Обрежь первые 3 секунды', 'Чёрно-белое', 'Надпись сверху «Скидка 20%»', 'Ускорь в 2 раза'],
  },
  en: {
    drop: 'Drop a video here or click to choose',
    dropHint: 'Works best with short clips up to 3 minutes',
    newVideo: 'Video', music: 'Music', undo: 'Undo', download: 'Download',
    placeholder: 'Write what to do with the video…',
    hello: "Hi! I'm Markingspb AI. Upload a video and tell me what to change: trim, make it vertical for Reels, add a title, subtitles, music, a filter…",
    loadingEngine: 'Loading the video editor (first time ~30 MB)…',
    reading: 'Reading the video…', thinking: 'Thinking…', editing: 'Editing the video…', listening: 'Listening for subtitles…',
    loaded: 'Video loaded', musicOn: 'Music: ', done: 'Done ✔', undone: 'Undone',
    noVideo: 'Please upload a video first 🙂',
    aiError: 'The AI is not answering right now. Please try again in a minute.',
    limit: 'Too many requests. Please wait a little.',
    editError: "The edit didn't work. Try saying it differently.",
    noSpeech: 'This video has no sound, so subtitles are not possible.',
    sttError: 'Speech recognition failed.',
    musicMissing: 'Attach music with the 🎵 Music button.',
    big: 'This video is large — editing in the browser may be slow.',
    chips: ['Make it vertical for Reels', 'Add subtitles', 'Cut the first 3 seconds', 'Black and white', 'Add title "Sale 20%" at the top', 'Make it 2x faster'],
  },
};
let lang = 'ru';
try { lang = localStorage.getItem('lang') || ((navigator.language || 'ru').toLowerCase().startsWith('en') ? 'en' : 'ru'); } catch { /* ignore */ }
const t = (k) => T[lang][k];

// ---------- elements ----------
const $ = (id) => document.getElementById(id);
const player = $('player'), drop = $('drop'), busy = $('busy'), busyText = $('busyText'), bar = $('bar');
const messages = $('messages'), form = $('form'), text = $('text'), sendBtn = $('sendBtn');
const undoBtn = $('undoBtn'), downloadBtn = $('downloadBtn'), info = $('info'), musicLabel = $('musicLabel');

// ---------- state ----------
const ffmpeg = new FFmpeg();
let engineReady = null;
let logLines = [];
let versions = [];          // [{ blob, info }]
let musicName = null;
let history = [];           // chat history for the AI
let working = false;

ffmpeg.on('log', ({ message }) => { logLines.push(message); if (logLines.length > 400) logLines.shift(); });
ffmpeg.on('progress', ({ progress }) => { bar.style.width = Math.round(Math.min(1, Math.max(0, progress || 0)) * 100) + '%'; });

// ---------- UI helpers ----------
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach((el) => {
    if (el.id === 'musicLabel' && musicName) return;
    el.textContent = t(el.dataset.t);
  });
  text.placeholder = t('placeholder');
  document.querySelectorAll('.lang button').forEach((b) => b.classList.toggle('on', b.dataset.lang === lang));
  const chips = $('chips');
  chips.innerHTML = '';
  for (const c of t('chips')) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.textContent = c;
    b.onclick = () => { text.value = c; form.requestSubmit(); };
    chips.appendChild(b);
  }
}

function say(content, who = 'ai') {
  const div = document.createElement('div');
  div.className = 'msg ' + who;
  div.textContent = content;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function setBusy(label) {
  if (label) { busyText.textContent = label; bar.style.width = '0%'; busy.hidden = false; }
  else busy.hidden = true;
}

function refresh() {
  const cur = versions.at(-1);
  undoBtn.disabled = versions.length < 2 || working;
  sendBtn.disabled = working;
  if (cur) {
    const url = URL.createObjectURL(cur.blob);
    if (player.src) URL.revokeObjectURL(player.src);
    player.src = url;
    player.hidden = false; drop.hidden = true;
    downloadBtn.href = url;
    downloadBtn.download = 'markingspb-ai-video.mp4';
    downloadBtn.setAttribute('aria-disabled', versions.length < 2 ? 'true' : 'false');
    const i = cur.info;
    info.textContent = `${i.width}×${i.height} · ${i.duration.toFixed(1)} s · ${(cur.blob.size / 1048576).toFixed(1)} MB`;
  }
}

// ---------- engine ----------
function loadEngine() {
  if (!engineReady) {
    engineReady = (async () => {
      await ffmpeg.load({ coreURL: '/vendor/core/ffmpeg-core.js', wasmURL: '/vendor/core/ffmpeg-core.wasm' });
      const font = await fetchFile('/DejaVuSans-Bold.ttf');
      await ffmpeg.writeFile('/font.ttf', font);
    })();
    engineReady.catch(() => { engineReady = null; });
  }
  return engineReady;
}

// Read size, length, sound and phone rotation from FFmpeg's own report.
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
  return {
    width, height,
    duration: +dur[1] * 3600 + +dur[2] * 60 + +dur[3],
    hasAudio: /Stream #.*Audio:/.test(log),
  };
}

// ---------- load files ----------
async function loadVideo(file) {
  if (!file || working) return;
  working = true; refresh();
  try {
    setBusy(t('loadingEngine'));
    await loadEngine();
    setBusy(t('reading'));
    if (file.size > 300 * 1048576) say(t('big'), 'sys');
    await ffmpeg.writeFile('cur.mp4', await fetchFile(file));
    const i = await probe('cur.mp4');
    versions = [{ blob: file, info: i }];
    history = [];
    say(`${t('loaded')}: ${file.name}`, 'sys');
  } catch (e) {
    console.error(e);
    say(t('editError'), 'err');
  } finally {
    working = false; setBusy(null); refresh();
  }
}

async function loadMusic(file) {
  if (!file || working) return;
  try {
    await loadEngine();
    const ext = (file.name.match(/\.[a-z0-9]{1,5}$/i) || ['.mp3'])[0].toLowerCase();
    if (musicName) await ffmpeg.deleteFile(musicName).catch(() => {});
    musicName = 'music' + ext;
    await ffmpeg.writeFile(musicName, await fetchFile(file));
    musicLabel.textContent = file.name.length > 18 ? file.name.slice(0, 16) + '…' : file.name;
    say(t('musicOn') + file.name, 'sys');
  } catch (e) { console.error(e); }
}

// ---------- editing ----------
async function runEdit(ops, curInfo) {
  const { args, files, info: newInfo, warnings } = buildEdit(ops, curInfo, {
    input: 'cur.mp4', output: 'out.mp4', music: musicName, font: '/font.ttf', dir: '/',
  });
  if (warnings.includes('music_missing')) say(t('musicMissing'), 'sys');
  const enc = new TextEncoder();
  for (const [p, c] of Object.entries(files)) await ffmpeg.writeFile(p, enc.encode(c));
  logLines = [];
  setBusy(t('editing'));
  const code = await ffmpeg.exec(args);
  for (const p of Object.keys(files)) await ffmpeg.deleteFile(p).catch(() => {});
  if (code !== 0) { console.error(logLines.slice(-25).join('\n')); throw new Error('ffmpeg ' + code); }
  const data = await ffmpeg.readFile('out.mp4');
  // Make the Blob first: writeFile() hands the memory over to the worker.
  const blob = new Blob([data.slice()], { type: 'video/mp4' });
  await ffmpeg.deleteFile('cur.mp4').catch(() => {});
  await ffmpeg.writeFile('cur.mp4', data);
  await ffmpeg.deleteFile('out.mp4').catch(() => {});
  newInfo.duration = (await probe('cur.mp4')).duration;
  return { blob, info: newInfo };
}

async function transcribe(curInfo, language) {
  if (!curInfo.hasAudio) throw new Error('nosound');
  setBusy(t('listening'));
  const code = await ffmpeg.exec(['-i', 'cur.mp4', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '48k', '-y', 'stt.m4a']);
  if (code !== 0) throw new Error('stt');
  const audio = await ffmpeg.readFile('stt.m4a');
  await ffmpeg.deleteFile('stt.m4a').catch(() => {});
  const q = language ? '?language=' + encodeURIComponent(language) : '';
  const r = await fetch('/api/transcribe' + q, { method: 'POST', headers: { 'Content-Type': 'audio/mp4' }, body: audio });
  if (!r.ok) throw new Error('stt');
  return (await r.json()).segments || [];
}

async function apply(operations) {
  let cur = versions.at(-1);
  let pending = [];
  for (const seg of splitAtSubtitles(operations)) {
    if (seg.type === 'edit') { pending.push(...seg.ops); continue; }
    if (pending.length) { cur = await runEdit(pending, cur.info); pending = []; }
    const segments = await transcribe(cur.info, seg.language);
    pending.push(...subtitleOps(segments));
  }
  if (pending.length) cur = await runEdit(pending, cur.info);
  if (cur !== versions.at(-1)) versions.push(cur);
}

// ---------- chat ----------
async function send(message) {
  if (!message.trim() || working) return;
  say(message, 'me');
  const cur = versions.at(-1);
  working = true; refresh();
  setBusy(t('thinking'));
  try {
    const r = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history, video: cur ? cur.info : null, hasMusic: !!musicName }),
    });
    if (r.status === 429) { say(t('limit'), 'err'); return; }
    if (!r.ok) { say(t('aiError'), 'err'); return; }
    const { reply, operations } = await r.json();
    history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    history = history.slice(-10);
    if (operations.length && !cur) { say(t('noVideo')); return; }
    if (operations.length) {
      try {
        await apply(operations);
        say(reply || t('done'));
      } catch (e) {
        console.error(e);
        say(e.message === 'nosound' ? t('noSpeech') : e.message === 'stt' ? t('sttError') : t('editError'), 'err');
      }
    } else say(reply || '…');
  } catch (e) {
    console.error(e);
    say(t('aiError'), 'err');
  } finally {
    working = false; setBusy(null); refresh();
  }
}

// ---------- events ----------
form.addEventListener('submit', (e) => { e.preventDefault(); const m = text.value; text.value = ''; send(m); });
text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
$('videoInput').addEventListener('change', (e) => loadVideo(e.target.files[0]));
$('videoInput2').addEventListener('change', (e) => loadVideo(e.target.files[0]));
$('musicInput').addEventListener('change', (e) => loadMusic(e.target.files[0]));
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); loadVideo(e.dataTransfer.files[0]); });
undoBtn.addEventListener('click', async () => {
  if (versions.length < 2 || working) return;
  working = true; refresh();
  try {
    versions.pop();
    await ffmpeg.writeFile('cur.mp4', await fetchFile(versions.at(-1).blob));
    say(t('undone'), 'sys');
  } finally { working = false; refresh(); }
});
document.querySelectorAll('.lang button').forEach((b) => b.addEventListener('click', () => {
  lang = b.dataset.lang; try { localStorage.setItem('lang', lang); } catch { /* ignore */ } applyLang();
}));

applyLang();
say(t('hello'));
loadEngine().catch(() => {}); // start downloading the editor in the background
