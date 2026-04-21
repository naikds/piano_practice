/* =========================
   画面切り替え
========================= */
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s =>
    s.classList.remove("active")
  );
  document.getElementById(id).classList.add("active");
}

/* =========================
   Canvas / Audio
========================= */
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener("resize", resize);

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

/* =========================
   音
========================= */
const NOTE_INDEX = {
  "C":0,"C#":1,"D":2,"D#":3,"E":4,
  "F":5,"F#":6,"G":7,"G#":8,"A":9,"A#":10,"B":11
};

function noteToFreq(note) {
  const m = note.match(/^([A-G]#?)(\d)$/);
  const midi = (parseInt(m[2],10)+1)*12 + NOTE_INDEX[m[1]];
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function playNote(freq) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.2);
}

/* =========================
   鍵盤
========================= */
let keys = [];

function buildKeys(startKey, octaves) {
  keys = [];
  const order = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  let x = 0;
  for (let o=0;o<octaves;o++) {
    const baseOct = parseInt(startKey.slice(-1))+o;
    for (const n of order) {
      const black = n.includes("#");
      keys.push({ note:n+baseOct, isBlack:black, x, w:black?0.6:1 });
      if (!black) x+=1;
    }
  }
}

function drawKeys() {
  const whites = keys.filter(k=>!k.isBlack);
  const scale = canvas.width / whites.length;
  const h = canvas.height * 0.25;

  whites.forEach(k=>{
    ctx.fillStyle="#fff";
    ctx.fillRect(k.x*scale, canvas.height-h, scale, h);
    ctx.strokeRect(k.x*scale, canvas.height-h, scale, h);
  });

  keys.filter(k=>k.isBlack).forEach(k=>{
    ctx.fillStyle="#000";
    ctx.fillRect((k.x-0.3)*scale, canvas.height-h, scale*0.6, h*0.6);
  });
}

/* =========================
   ノーツ描画
========================= */
const HIT_LINE_RATIO = 0.75;
const NOTE_TRAVEL_TIME = 2.0;

function drawNotes(elapsed, score) {
  const hitY = canvas.height * HIT_LINE_RATIO;
  const speed = hitY / NOTE_TRAVEL_TIME;
  const whites = keys.filter(k=>!k.isBlack);
  const scale = canvas.width / whites.length;

  for (const n of score.notes) {
    const k = keys.find(x=>x.note===n.key);
    if (!k) continue;

    const t = n.time - elapsed;
    if (t < -0.2 || t > NOTE_TRAVEL_TIME) continue;

    const y = hitY - t*speed;
    ctx.fillStyle="rgba(0,200,255,0.8)";
    ctx.fillRect(k.x*scale, y, scale*k.w, 10);
  }
}

/* =========================
   ゲーム制御
========================= */
let currentScore = null;
let startTime = 0;
let playing = false;

function startGame(score) {
  currentScore = score;
  resize();
  buildKeys(score.meta.keyRange.start, score.meta.keyRange.octaves);
  startTime = performance.now() + NOTE_TRAVEL_TIME*1000;
  playing = true;
  showScreen("screen-play");
  requestAnimationFrame(loop);
}

function loop(now) {
  if (!playing) return;
  const elapsed = (now - startTime)/1000;

  ctx.clearRect(0,0,canvas.width,canvas.height);
  drawNotes(elapsed, currentScore);
  drawKeys();

  const end = Math.max(...currentScore.notes.map(n=>n.time));
  if (elapsed > end + 1) {
    playing = false;
    showScreen("screen-result");
    return;
  }
  requestAnimationFrame(loop);
}

/* =========================
   入力
========================= */
canvas.addEventListener("pointerdown", e=>{
  if (audioCtx.state==="suspended") audioCtx.resume();
  const whites = keys.filter(k=>!k.isBlack);
  const scale = canvas.width / whites.length;
  const x = e.clientX / scale;
  const k = keys.find(k=>x>=k.x && x<=k.x+k.w);
  if (k) playNote(noteToFreq(k.note));
});

/* =========================
   サーバロード：一覧 → 譜面
========================= */
const songList = document.getElementById("song-list");

async function loadScoreList() {
  const res = await fetch("scores/score-list.json");
  if (!res.ok) throw new Error("score-list load failed");
  return await res.json();
}

async function loadScoreFile(file) {
  const res = await fetch(`scores/${file}`);
  if (!res.ok) throw new Error("score load failed");
  return await res.json();
}

async function init() {
  showScreen("screen-select");
  songList.innerHTML = "";

  const list = await loadScoreList();
  for (const s of list.scores) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.textContent = s.title;
    btn.onclick = async () => {
      const score = await loadScoreFile(s.file);
      startGame(score);
    };
    li.appendChild(btn);
    songList.appendChild(li);
  }
}

/* =========================
   結果画面
========================= */
document.getElementById("retry").onclick = () => startGame(currentScore);
document.getElementById("back").onclick = () => init();

/* =========================
   起動
========================= */
init();
