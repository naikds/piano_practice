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
let freePlay = false;

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
function readVar(view, pos, limit) {
  let v = 0;
  let i = 0;

  while (true) {
    if (pos + i >= limit) {
      throw new Error("readVar overflow");
    }
    const b = view.getUint8(pos + i);
    v = (v << 7) | (b & 0x7f);
    i++;
    if (!(b & 0x80)) break;
  }
  return { v, l: i };
}

function parseMIDI(buffer) {
  const view = new DataView(buffer);
  let p = 0;

  const str = n => {
    let s = "";
    for (let i = 0; i < n; i++) {
      s += String.fromCharCode(view.getUint8(p++));
    }
    return s;
  };
  const u16 = () => (p += 2, view.getUint16(p - 2));
  const u32 = () => (p += 4, view.getUint32(p - 4));

  /* ---------- MThd ---------- */
  if (str(4) !== "MThd") return [];

  const headerLen = u32();      // ← 重要
  const format = u16();
  const trackCount = u16();
  const division = u16();

  // headerLen が 6 以外でも壊れない
  if (headerLen > 6) {
    p += headerLen - 6;
  }

  // SMPTE division は今回は未対応
  if (division & 0x8000) {
    console.warn("SMPTE division not supported");
    return [];
  }

  let tempo = 500000; // μsec / quarter note
  const allNotes = [];

  /* ---------- MTrk ---------- */
  for (let t = 0; t < trackCount; t++) {
    if (str(4) !== "MTrk") break;

    const trackLen = u32();
    const trackEnd = p + trackLen;

    let time = 0;
    let runningStatus = 0;
    const noteOnMap = new Map();

    while (p < trackEnd) {
      // Δtime
      const dt = readVar(view, p, trackEnd);
      p += dt.l;
      time += dt.v;

      let status = view.getUint8(p);

      // running status
      if (status < 0x80) {
        if (!runningStatus) throw new Error("Invalid running status");
        status = runningStatus;
      } else {
        p++;
        runningStatus = status;
      }

      /* ---- Note On ---- */
      if ((status & 0xf0) === 0x90) {
        const note = view.getUint8(p++);
        const vel = view.getUint8(p++);
        if (vel > 0) {
          noteOnMap.set(note, time);
        } else if (noteOnMap.has(note)) {
          allNotes.push({
            midi: note,
            start: noteOnMap.get(note),
            end: time
          });
          noteOnMap.delete(note);
        }

      /* ---- Note Off ---- */
      } else if ((status & 0xf0) === 0x80) {
        const note = view.getUint8(p++);
        p++; // velocity
        if (noteOnMap.has(note)) {
          allNotes.push({
            midi: note,
            start: noteOnMap.get(note),
            end: time
          });
          noteOnMap.delete(note);
        }

      /* ---- Meta Event ---- */
      } else if (status === 0xff) {
        const type = view.getUint8(p++);
        const len = readVar(view, p, trackEnd);
        p += len.l;

        // Tempo
        if (type === 0x51 && len.v === 3) {
          tempo =
            (view.getUint8(p) << 16) |
            (view.getUint8(p + 1) << 8) |
             view.getUint8(p + 2);
        }

        // End of Track
        if (type === 0x2f) {
          break;
        }

        p += len.v;

      /* ---- Other MIDI Events ---- */
      } else {
        // Program Change / Channel Aftertouch = 1 byte
        p += ((status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0) ? 1 : 2;
      }
    }

    p = trackEnd;
  }

  // tick → sec
  const secPerTick = (tempo / 1e6) / division;

  return allNotes.map(n => ({
    midi: n.midi,
    time: n.start * secPerTick,
    duration: (n.end - n.start) * secPerTick
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
