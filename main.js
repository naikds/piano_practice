/* =================================================
   基本DOM
   ================================================= */

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const keyboard = document.getElementById("keyboard");
const overlay = document.getElementById("startOverlay");
const songMenu = document.getElementById("songMenu");

const endMenu = document.getElementById("endMenu");
const replayBtn = document.getElementById("replayBtn");
const selectBtn = document.getElementById("selectBtn");

let notes = [];
let startTime = null;
let lastNoteTime = 0;
let hasShownNote = false;

/* =================================================
   Canvas
   ================================================= */

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);
resize();

/* =================================================
   Audio (Web Audio API)
   ================================================= */

let audioCtx = null;

function initAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function playNote(midi) {
  if (!audioCtx) return;

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  const t = audioCtx.currentTime;

  osc.type = "triangle";
  osc.frequency.value = midiToFreq(midi);

  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.start(t);
  osc.stop(t + 0.3);
}

/* =================================================
   鍵盤生成（3オクターブ）
   ================================================= */

const START_NOTE = 48; // C3
const OCTAVES = 3;

const WHITE = [0, 2, 4, 5, 7, 9, 11];
const BLACK = { 0: 1, 1: 3, 3: 6, 4: 8, 5: 10 };

const keysByMidi = new Map();
const whiteKeys = [];

// 白鍵
for (let o = 0; o < OCTAVES; o++) {
  for (let i = 0; i < 7; i++) {
    const k = document.createElement("div");
    k.className = "key white";
    const midi = START_NOTE + o * 12 + WHITE[i];
    k.dataset.note = midi;
    keyboard.appendChild(k);
    whiteKeys.push(k);
    keysByMidi.set(midi, k);
  }
}

// 黒鍵
whiteKeys.forEach((w, i) => {
  const n = i % 7;
  const o = Math.floor(i / 7);
  if (BLACK[n] !== undefined) {
    const k = document.createElement("div");
    k.className = "key black";
    const midi = START_NOTE + o * 12 + BLACK[n];
    k.dataset.note = midi;
    const left = ((i + 1) / whiteKeys.length) * 100;
    k.style.left = `${left - 1.25}%`;
    keyboard.appendChild(k);
    keysByMidi.set(midi, k);
  }
});

/* =================================================
   鍵盤 → Canvas座標
   ================================================= */

function keyRect(midi) {
  const k = keysByMidi.get(midi);
  if (!k) return null;
  const kr = k.getBoundingClientRect();
  const cr = canvas.getBoundingClientRect();
  return { x: kr.left - cr.left, w: kr.width };
}

/* =================================================
   タッチ入力
   ================================================= */

keyboard.addEventListener("touchstart", e => {
  e.preventDefault();
  const t = e.target;
  if (!t.classList.contains("key")) return;
  playNote(Number(t.dataset.note));
}, { passive: false });

/* =================================================
   MIDI 最小パーサ
   ================================================= */

function readVar(view, pos) {
  let v = 0, i = 0;
  while (true) {
    const b = view.getUint8(pos + i);
    v = (v << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
    i++;
  }
  return { v, l: i + 1 };
}

function parseMIDI(buf) {
  const v = new DataView(buf);
  let p = 0;

  const str = n => {
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint8(p++));
    return s;
  };
  const u16 = () => (p += 2, v.getUint16(p - 2));
  const u32 = () => (p += 4, v.getUint32(p - 4));

  if (str(4) !== "MThd") return [];
  p += 4;
  u16(); const tracks = u16(); const div = u16();

  let tempo = 500000;
  const notes = [];

  for (let t = 0; t < tracks; t++) {
    str(4); const end = p + u32();
    let time = 0, run = 0;
    const on = new Map();

    while (p < end) {
      const dt = readVar(v, p); p += dt.l; time += dt.v;
      let s = v.getUint8(p);
      if (s < 0x80) s = run; else p++, run = s;

      if ((s & 0xf0) === 0x90) {
        const n = v.getUint8(p++), vel = v.getUint8(p++);
        if (vel) on.set(n, time);
        else if (on.has(n)) {
          notes.push({ n, s: on.get(n), e: time });
          on.delete(n);
        }
      } else if ((s & 0xf0) === 0x80) {
        const n = v.getUint8(p++); p++;
        if (on.has(n)) {
          notes.push({ n, s: on.get(n), e: time });
          on.delete(n);
        }
      } else if (s === 0xff) {
        const type = v.getUint8(p++);
        const l = readVar(v, p); p += l.l;
        if (type === 0x51)
          tempo = (v.getUint8(p) << 16) | (v.getUint8(p + 1) << 8) | v.getUint8(p + 2);
        p += l.v;
      } else {
        p += (s & 0xf0) === 0xc0 || (s & 0xf0) === 0xd0 ? 1 : 2;
      }
    }
  }

  const sec = tempo / 1e6 / div;
  return notes.map(n => ({
    midi: n.n,
    time: n.s * sec
  }));
}

/* =================================================
   ノーツ描画（timeベース）
   ================================================= */
const SPEED = 220;

function draw(ts) {
  if (!startTime) startTime = ts;
  const now = (ts - startTime) / 1000;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const judge = canvas.clientHeight - 12;
  ctx.strokeStyle = "#0f0";
  ctx.beginPath();
  ctx.moveTo(0, judge);
  ctx.lineTo(canvas.width, judge);
  ctx.stroke();

let alive = false;

  notes.forEach(n => {
    const y = judge - (n.time - now) * SPEED;
    if (y < -30 || y > canvas.clientHeight + 30) return;

   alive = true;
     hasShownNote = true;
    const r = keyRect(n.midi);
    if (!r) return;
    ctx.fillStyle = "#0af";
    ctx.fillRect(r.x, y, r.w, 18);
  });
   
   if (!freePlay && hasShownNote && !alive && now > lastNoteTime + 0.5) {
    endMenu.style.display = "flex";
    return;
  }

  requestAnimationFrame(draw);
}

/* =================================================
   曲読み込み
   ================================================= */

async function loadSong(url) {
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  notes = parseMIDI(buf).filter(n => keysByMidi.has(n.midi));
  lastNoteTime = Math.max(...notes.map(n => n.time));
  startTime = null;
   hasShownNote = false;
}

songMenu.addEventListener("touchstart", async e => {
  const s = e.target.closest(".song");
  if (!s) return;

  if (s.dataset.mode === "free") {
    freePlay = true;
    notes = [];
    startTime = null;
  } else {
    freePlay = false;
    await loadSong(s.dataset.url);
  }

  songMenu.style.display = "none";
  endMenu.style.display = "none";
}, { passive: false });

replayBtn.onclick = () => {
  startTime = null;
   hasShownNote = false
  endMenu.style.display = "none";
};

selectBtn.onclick = () => {
  endMenu.style.display = "none";
  songMenu.style.display = "flex";
};

/* =================================================
   起動
   ================================================= */

overlay.addEventListener("touchstart", () => {
  initAudio();
  overlay.style.display = "none";
  songMenu.style.display = "flex";
 requestAnimationFrame(draw);
});
