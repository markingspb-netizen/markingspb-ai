// Markingspb AI — turns the AI's list of operations into one FFmpeg command.
// Pure JavaScript: works in the browser (ffmpeg.wasm) and in Node (for tests).

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const evenDown = (n) => Math.max(2, Math.floor(n / 2) * 2);
const evenUp = (n) => Math.max(2, Math.ceil(n / 2) * 2);
const f3 = (n) => Number(n).toFixed(3);

const FILTERS = {
  bw: 'hue=s=0',
  sepia: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131',
  warm: 'colorbalance=rs=0.1:bs=-0.1',
  cool: 'colorbalance=rs=-0.1:bs=0.1',
  bright: 'eq=brightness=0.08',
  dark: 'eq=brightness=-0.08',
  contrast: 'eq=contrast=1.25',
  vivid: 'eq=saturation=1.5',
  vintage: 'curves=preset=vintage',
  blur: 'boxblur=4:1',
  sharpen: 'unsharp=5:5:1.0',
};

const SIZES = { small: 0.05, medium: 0.07, large: 0.1 };

function atempoChain(f) {
  const parts = [];
  while (f > 2) { parts.push('atempo=2'); f /= 2; }
  while (f < 0.5) { parts.push('atempo=0.5'); f /= 0.5; }
  parts.push('atempo=' + f3(f));
  return parts;
}

function color(c) {
  if (typeof c !== 'string') return 'white';
  if (/^#[0-9a-f]{6}$/i.test(c)) return '0x' + c.slice(1);
  if (/^[a-z]{3,20}$/i.test(c)) return c.toLowerCase();
  return 'white';
}

function wrap(text, maxChars) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if (!w) continue;
    if ((line + ' ' + w).trim().length > maxChars && line) { lines.push(line); line = w; }
    else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line);
  return lines.slice(0, 5);
}

/** Split operations at "subtitles": subtitles need speech recognition first. */
export function splitAtSubtitles(ops) {
  const segs = [];
  let cur = [];
  for (const op of ops || []) {
    if (op && op.op === 'subtitles') {
      if (cur.length) segs.push({ type: 'edit', ops: cur });
      cur = [];
      segs.push({ type: 'subtitles', language: op.language || null });
    } else if (op && typeof op.op === 'string') cur.push(op);
  }
  if (cur.length) segs.push({ type: 'edit', ops: cur });
  return segs;
}

/** Speech-recognition segments -> text operations (bottom subtitles). */
export function subtitleOps(segments) {
  return (segments || [])
    .filter((s) => s && String(s.text || '').trim())
    .map((s) => ({ op: 'text', text: String(s.text).trim(), position: 'bottom', size: 'small', start: s.start, end: s.end, box: true }));
}

/**
 * Build FFmpeg arguments.
 * info: { width, height, duration, hasAudio }
 * opts: { input, output, music (file name or null), font, dir (folder for text files) }
 * Returns { args, files: {path: text}, info: newInfo, warnings }
 */
export function buildEdit(ops, info, opts = {}) {
  const input = opts.input || 'cur.mp4';
  const output = opts.output || 'out.mp4';
  const font = opts.font || '/font.ttf';
  const dir = opts.dir || '/';
  const music = opts.music || null;

  // Start: constant 30 fps, even size, max 1280 px on the long side (fast in the browser).
  const scale = Math.min(1, 1280 / Math.max(info.width, info.height));
  let w = evenDown(info.width * scale);
  let h = evenDown(info.height * scale);
  let d = Math.max(0.1, num(info.duration, 1));
  const hasAudio = !!info.hasAudio;

  const v = ['fps=30', `scale=${w}:${h}`, 'setsar=1'];
  const a = [];
  const files = {};
  const warnings = [];
  let t = 0;
  let mute = false;
  let musicOp = null;

  for (const op of ops || []) {
    switch (op.op) {
      case 'trim': {
        const s = clamp(num(op.start, 0), 0, d);
        const e = clamp(num(op.end, d), 0, d);
        if (e - s < 0.1) { warnings.push('trim'); break; }
        v.push(`trim=start=${f3(s)}:end=${f3(e)}`, 'setpts=PTS-STARTPTS');
        a.push(`atrim=start=${f3(s)}:end=${f3(e)}`, 'asetpts=PTS-STARTPTS');
        d = e - s;
        break;
      }
      case 'cut': {
        const s = clamp(num(op.start, 0), 0, d);
        const e = clamp(num(op.end, d), 0, d);
        if (e - s < 0.05 || d - (e - s) < 0.1) { warnings.push('cut'); break; }
        v.push(`select='not(between(t,${f3(s)},${f3(e)}))'`, 'setpts=N/FRAME_RATE/TB');
        a.push(`aselect='not(between(t,${f3(s)},${f3(e)}))'`, 'asetpts=N/SR/TB');
        d -= e - s;
        break;
      }
      case 'speed': {
        const f = clamp(num(op.factor, 1), 0.25, 4);
        if (Math.abs(f - 1) < 0.01) break;
        v.push(`setpts=PTS/${f3(f)}`, 'fps=30');
        a.push(...atempoChain(f));
        d /= f;
        break;
      }
      case 'aspect': {
        const m = String(op.ratio || '').match(/^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/);
        if (!m) { warnings.push('aspect'); break; }
        const r = Number(m[1]) / Number(m[2]);
        if (op.mode === 'fit') {
          let W = w, H = h;
          if (w / h > r) H = evenUp(w / r); else W = evenUp(h * r);
          v.push(`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`);
          w = W; h = H;
        } else {
          let cw = w, ch = h;
          if (w / h > r) cw = Math.min(w, evenDown(h * r)); else ch = Math.min(h, evenDown(w / r));
          v.push(`crop=${cw}:${ch}`);
          w = cw; h = ch;
        }
        break;
      }
      case 'rotate': {
        const deg = ((Math.round(num(op.degrees, 90) / 90) * 90) % 360 + 360) % 360;
        if (deg === 90) { v.push('transpose=1'); [w, h] = [h, w]; }
        else if (deg === 270) { v.push('transpose=2'); [w, h] = [h, w]; }
        else if (deg === 180) v.push('hflip', 'vflip');
        break;
      }
      case 'flip':
        v.push(op.direction === 'vertical' ? 'vflip' : 'hflip');
        break;
      case 'filter': {
        const fl = FILTERS[op.name];
        if (fl) v.push(fl); else warnings.push('filter:' + op.name);
        break;
      }
      case 'text': {
        const fs = Math.round(Math.min(w, h) * (SIZES[op.size] || SIZES.medium));
        const maxChars = Math.max(8, Math.floor((w * 0.88) / (fs * 0.68)));
        const lines = wrap(op.text || '', maxChars);
        if (!lines.length) break;
        const lineH = Math.round(fs * 1.3);
        const blockH = lines.length * lineH;
        const pos = op.position || 'bottom';
        let y0 = pos === 'top' ? Math.round(h * 0.08) : pos === 'center' ? Math.round((h - blockH) / 2) : Math.round(h - blockH - h * 0.08);
        const s = op.start != null ? Math.max(0, num(op.start, 0)) : null;
        const e = op.end != null ? num(op.end, d) : null;
        const enable = s != null || e != null ? `:enable='between(t,${f3(s ?? 0)},${f3(e ?? d + 1)})'` : '';
        const box = op.box ? ':box=1:boxcolor=black@0.55:boxborderw=12' : '';
        const border = Math.max(2, Math.round(fs / 16));
        lines.forEach((line, i) => {
          const path = `${dir}t${t++}.txt`;
          files[path] = line;
          v.push(`drawtext=fontfile=${font}:textfile=${path}:expansion=none:fontsize=${fs}:fontcolor=${color(op.color)}:borderw=${border}:bordercolor=black:x=(w-text_w)/2:y=${y0 + i * lineH}${enable}${box}`);
        });
        break;
      }
      case 'volume':
        a.push(`volume=${f3(clamp(num(op.level, 1), 0, 4))}`);
        break;
      case 'mute':
        mute = true;
        break;
      case 'fade': {
        const fin = clamp(num(op.in, 0), 0, d / 2);
        const fout = clamp(num(op.out, 0), 0, d / 2);
        if (fin > 0) { v.push(`fade=t=in:st=0:d=${f3(fin)}`); a.push(`afade=t=in:st=0:d=${f3(fin)}`); }
        if (fout > 0) { v.push(`fade=t=out:st=${f3(d - fout)}:d=${f3(fout)}`); a.push(`afade=t=out:st=${f3(d - fout)}:d=${f3(fout)}`); }
        break;
      }
      case 'music':
        if (music) musicOp = op; else warnings.push('music_missing');
        break;
      default:
        warnings.push('unknown:' + op.op);
    }
  }
  if (Math.max(w, h) > 1280) {
    const k = 1280 / Math.max(w, h);
    w = evenDown(w * k); h = evenDown(h * k);
    v.push(`scale=${w}:${h}`, 'setsar=1');
  }
  v.push('format=yuv420p');

  const graph = [`[0:v]${v.join(',')}[vout]`];
  let amap = null;
  if (hasAudio && !mute) {
    graph.push(`[0:a]${a.length ? a.join(',') : 'anull'}[a0]`);
    amap = '[a0]';
  }
  if (musicOp) {
    const mv = clamp(num(musicOp.volume, 0.6), 0, 2);
    const fo = Math.min(2, d / 4);
    graph.push(`[1:a]atrim=0:${f3(d)},asetpts=PTS-STARTPTS,volume=${f3(mv)},afade=t=out:st=${f3(Math.max(0, d - fo))}:d=${f3(fo)}[m]`);
    if (amap && musicOp.keepOriginal !== false) {
      graph.push(`${amap}[m]amix=inputs=2:duration=first:dropout_transition=0,volume=2[amix]`);
      amap = '[amix]';
    } else amap = '[m]';
  }

  const args = ['-i', input];
  if (musicOp) args.push('-i', music);
  args.push('-filter_complex', graph.join(';'), '-map', '[vout]');
  if (amap) args.push('-map', amap, '-c:a', 'aac', '-b:a', '128k'); else args.push('-an');
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-movflags', '+faststart', '-y', output);

  return { args, files, info: { width: w, height: h, duration: d, hasAudio: !!amap }, warnings };
}
