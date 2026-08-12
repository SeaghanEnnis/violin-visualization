/**
 * Violin Visualizer — visualizer.js
 *
 * Fetches score data from /api/score, then drives the canvas animation.
 * All rendering is pure 2D canvas — no external dependencies needed.
 * Thanks mr claude
 */

// Loaded as an ES module (see index.html) so pdf.js — which only ships
// .mjs builds — can be imported directly; modules are strict mode already.
import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs";

// State
let STRINGS       = [];
let SCORE         = [];
let SONG_DURATION = 32;
let playing       = false;
let animFrame     = null;
let time          = 0;
let songPos       = 0;
let lastTs        = null;
let mode          = "play-along";
let liveNote      = null;           // current detected note from mic
let liveFreq      = 0;              // raw detected frequency in Hz
let holdStart     = null;           // timestamp when correct note hold began
let advanceTarget = null;           // songPos being glided toward (Wait for Me only)
let SLUR_GROUPS   = [];             // [{str, tStart, tEnd}] precomputed from score
const HOLD_FRACTION = 0.5;          // required hold = this fraction of the note's real-time length
const MIN_HOLD_MS   = 150;          // floor, so fast/short notes stay achievable
const MAX_HOLD_MS   = 1200;         // ceiling, so slow/long notes don't stall practice

//Hold time (ms) required to advance past `ev` at the current tempo — scales
//with the note's own beat length so whole notes need a longer hold than
//sixteenths, instead of every note sharing one flat threshold.
function holdRequiredMs(ev, bpm) {
  const noteDurMs = ev.dur * (60000 / bpm);
  return Math.min(MAX_HOLD_MS, Math.max(MIN_HOLD_MS, noteDurMs * HOLD_FRACTION));
}

// ── DOM refs ─────────────────────────────────────────────────────────────────
const modeBadge        = document.getElementById("modeBadge");

const canvas           = document.getElementById("vizCanvas");
const ctx              = canvas.getContext("2d");
const playBtn          = document.getElementById("playBtn");
const tempoSlider      = document.getElementById("tempoSlider");
const tempoVal         = document.getElementById("tempoVal");
const intensitySlider  = document.getElementById("intensitySlider");
const intensityVal     = document.getElementById("intensityVal");
const timelineFill     = document.getElementById("timeline-fill");
const movementDisplay  = document.getElementById("movementDisplay");
const beatDisplay      = document.getElementById("beatDisplay");
const pieceTitle       = document.getElementById("pieceTitle");
const pieceSub         = document.getElementById("pieceSub");
const pieceSelect      = document.getElementById("pieceSelect");
const liveNoteDisplay  = document.getElementById("liveNoteDisplay");
const sheetArea        = document.getElementById("sheet-area");
const sheetScroll      = document.getElementById("sheetScroll");
const sheetPages       = document.getElementById("sheetPages");

// ── Sheet-music PDF sync ─────────────────────────────────────────────────────
// Scroll position tracks songPos against PIXEL_ANCHORS — {t, y} points built
// from %%sync page/row tags in the ABC source (see sheet_music_reader.py),
// linearly interpolated between them. With fewer than two anchors we fall
// back to a uniform songPos/SONG_DURATION mapping onto the PDF's total
// scroll height, which drifts on pieces with uneven engraving but at least
// keeps moving in lockstep with tempo.
let pdfDoc          = null;
let currentPdfUrl   = null;
let sheetMaxScroll  = 0;
let SYNC_ANCHORS    = [];      // raw {t, page, row} from the API
let SYNC_PAGE_ROWS  = {};      // declared {page: totalRows} from %%syncpage, keyed by string
let PAGE_META       = [];      // [{top, height}] per PDF page, 0-indexed
let PIXEL_ANCHORS   = [];      // [{t, y}] resolved from SYNC_ANCHORS + PAGE_META, sorted by t
let userScrolling   = false;   // true while the user is actively/recently interacting
let snapping        = false;   // true while catching back up to the time-derived position
let userScrollTimer = null;
const SNAP_INACTIVITY_MS = 900;   // how long to leave the user alone after they scroll
const SNAP_CATCHUP       = 0.22;  // fraction of the gap closed per animation frame
const SNAP_DONE_PX       = 1.5;

//Builds {t, y} pixel anchors from the raw page/row sync tags. Rows-per-page
//comes from a %%syncpage declaration when the ABC source has one; otherwise
//it's inferred as the highest row number tagged so far on that page, which
//only comes out right once every system on the page has been tagged.
function buildPixelAnchors() {
  PIXEL_ANCHORS = [];
  if (!SYNC_ANCHORS.length || !PAGE_META.length) return;

  const rowsPerPage = {};
  SYNC_ANCHORS.forEach(a => {
    rowsPerPage[a.page] = Math.max(rowsPerPage[a.page] || 0, a.row);
  });
  Object.entries(SYNC_PAGE_ROWS).forEach(([page, rows]) => {
    rowsPerPage[page] = rows;
  });

  PIXEL_ANCHORS = SYNC_ANCHORS
    .map(a => {
      const meta = PAGE_META[a.page - 1];
      if (!meta) return null;
      const rowH = meta.height / rowsPerPage[a.page];
      return { t: a.t, y: meta.top + (a.row - 1) * rowH };
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
}

function sheetTargetScrollTop() {
  if (PIXEL_ANCHORS.length >= 2) return interpolateSheetAnchors(songPos);
  const ratio = SONG_DURATION > 0 ? Math.max(0, Math.min(1, songPos / SONG_DURATION)) : 0;
  return ratio * sheetMaxScroll;
}

function interpolateSheetAnchors(t) {
  const anchors = PIXEL_ANCHORS;
  if (t <= anchors[0].t) return anchors[0].y;

  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i], b = anchors[i + 1];
    if (t <= b.t) {
      const frac = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
      return a.y + (b.y - a.y) * frac;
    }
  }

  //Past the last tagged row: keep advancing toward the bottom of the sheet
  //at the same time/space rate as the piece's overall remaining runway,
  //rather than freezing at the last known anchor.
  const last = anchors[anchors.length - 1];
  const remainingT = SONG_DURATION - last.t;
  if (remainingT <= 0) return last.y;
  const frac = Math.max(0, Math.min(1, (t - last.t) / remainingT));
  return last.y + (sheetMaxScroll - last.y) * frac;
}

function beginUserScroll() {
  userScrolling = true;
  snapping = false;
  clearTimeout(userScrollTimer);
  userScrollTimer = setTimeout(() => {
    userScrolling = false;
    snapping = true;
  }, SNAP_INACTIVITY_MS);
}
sheetScroll.addEventListener("wheel", beginUserScroll, { passive: true });
sheetScroll.addEventListener("touchstart", beginUserScroll, { passive: true });
sheetScroll.addEventListener("pointerdown", beginUserScroll);

//Runs every frame regardless of play/pause so the sheet snaps into place
//immediately on load/scrub and still catches up while paused.
function sheetScrollLoop() {
  if (pdfDoc && sheetMaxScroll > 0 && !userScrolling) {
    const target = sheetTargetScrollTop();
    if (snapping) {
      const next = sheetScroll.scrollTop + (target - sheetScroll.scrollTop) * SNAP_CATCHUP;
      if (Math.abs(target - next) < SNAP_DONE_PX) {
        sheetScroll.scrollTop = target;
        snapping = false;
      } else {
        sheetScroll.scrollTop = next;
      }
    } else {
      sheetScroll.scrollTop = target;
    }
  }
  requestAnimationFrame(sheetScrollLoop);
}
requestAnimationFrame(sheetScrollLoop);

async function renderSheetPages() {
  if (!pdfDoc) return;
  sheetPages.innerHTML = "";
  const targetWidth = sheetScroll.clientWidth * 0.92;
  const dpr = window.devicePixelRatio || 1;
  PAGE_META = [];

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = targetWidth / baseViewport.width;
    const viewport = page.getViewport({ scale: scale * dpr });

    const canvas = document.createElement("canvas");
    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = targetWidth + "px";
    sheetPages.appendChild(canvas);

    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

    //Content-relative Y (independent of current scroll position), since
    //canvas.offsetTop is relative to whichever ancestor happens to be the
    //nearest positioned element, not necessarily #sheetPages.
    const canvasRect = canvas.getBoundingClientRect();
    const scrollRect  = sheetScroll.getBoundingClientRect();
    PAGE_META.push({
      top:    canvasRect.top - scrollRect.top + sheetScroll.scrollTop,
      height: canvasRect.height,
    });
  }

  sheetMaxScroll = Math.max(0, sheetPages.scrollHeight - sheetScroll.clientHeight);
  buildPixelAnchors();
}

async function loadSheetPdf(url, syncAnchors, syncPageRows) {
  SYNC_ANCHORS   = syncAnchors || [];
  SYNC_PAGE_ROWS = syncPageRows || {};

  if (!url) {
    sheetArea.hidden = true;
    pdfDoc = null;
    currentPdfUrl = null;
    PIXEL_ANCHORS = [];
    return;
  }

  sheetArea.hidden = false;
  userScrolling = false;
  snapping = false;
  clearTimeout(userScrollTimer);

  if (url === currentPdfUrl && pdfDoc) {
    buildPixelAnchors();   // page layout is already known; anchors may have changed pieces
    sheetScroll.scrollTop = sheetTargetScrollTop();
    return;
  }

  currentPdfUrl = url;
  try {
    pdfDoc = await pdfjsLib.getDocument(url).promise;
    await renderSheetPages();
    sheetScroll.scrollTop = sheetTargetScrollTop();
  } catch (err) {
    console.error("Failed to load sheet PDF:", err);
    sheetArea.hidden = true;
    pdfDoc = null;
  }
}

//oad piece list and populate selector
async function loadPieceList() {
  try {
    const res  = await fetch("/api/pieces");
    const list = await res.json();

    //Populate header dropdown
    pieceSelect.innerHTML = "";
    list.forEach(p => {
      const opt = document.createElement("option");
      opt.value       = p.id;
      opt.textContent = `${p.composer} — ${p.title.split("—")[0].trim()}`;
      pieceSelect.appendChild(opt);
    });
    const rieding = list.find(p => p.id.startsWith("rieding"));
    if (rieding) pieceSelect.value = rieding.id;

    //populate start screen piece cards
    const container = document.getElementById("ss-pieces");
    list.forEach(p => {
      const card = document.createElement("button");
      card.className    = "piece-card";
      card.dataset.pieceId = p.id;
      card.innerHTML =
        `<span class="piece-card-title">${p.title}</span>` +
        `<span class="piece-card-composer">${p.composer}</span>`;
      card.addEventListener("click", () => {
        container.querySelectorAll(".piece-card").forEach(c => c.classList.remove("selected"));
        card.classList.add("selected");
      });
      container.appendChild(card);
    });

    //Select the default piece
    const defaultCard = container.querySelector(`[data-piece-id="${pieceSelect.value}"]`);
    if (defaultCard) defaultCard.classList.add("selected");

    await loadScore(pieceSelect.value);
  } catch (err) {
    pieceTitle.textContent = "Could not load pieces";
    console.error(err);
  }
}

async function loadScore(pieceId) {
  const url = pieceId ? `/api/score?piece=${encodeURIComponent(pieceId)}` : "/api/score";
  try {
    const res  = await fetch(url);
    const data = await res.json();
    STRINGS       = data.strings;
    SCORE         = data.score;
    computeSlurGroups();
    SONG_DURATION = data.piece.duration;
    songPos       = 0;
    time          = 0;
    holdStart     = null;
    advanceTarget = null;
    pieceTitle.textContent = data.piece.title;
    pieceSub.textContent   = `${data.piece.composer} · ${data.piece.instrument}`;
    if (data.piece.tempo) {
      tempoSlider.value    = Math.max(40, Math.min(200, Math.round(data.piece.tempo)));
      tempoVal.textContent = tempoSlider.value + " BPM";
    }
    drawFrame();
    loadSheetPdf(data.piece.pdf, data.syncAnchors, data.syncPageRows);
  } catch (err) {
    pieceTitle.textContent = "Could not load score";
    console.error("Failed to fetch score:", err);
  }
}

//Canvas resize
function resize() {
  const area = document.getElementById("viz-area");
  canvas.width  = area.clientWidth  * window.devicePixelRatio;
  canvas.height = area.clientHeight * window.devicePixelRatio;
}
resize();
let sheetResizeTimer = null;
window.addEventListener("resize", () => {
  resize();
  drawFrame();
  if (pdfDoc) {
    clearTimeout(sheetResizeTimer);
    sheetResizeTimer = setTimeout(async () => {
      await renderSheetPages();
      sheetScroll.scrollTop = sheetTargetScrollTop();
    }, 200);
  }
});

//Utils
function computeSlurGroups() {
  SLUR_GROUPS = [];
  let group  = null;
  let lastId = null;

  SCORE.forEach(ev => {
    const slurId = ev.slur ?? null;
    const str    = ev.notes?.[0];
    if (!str) return;

    if (slurId !== null) {
      if (slurId !== lastId) {
        //new ( opened — push the completed group and start a fresh one
        if (group) SLUR_GROUPS.push(group);
        group  = { startStr: str, startT: ev.t, startDur: ev.dur, endStr: str, endT: ev.t, endDur: ev.dur };
        lastId = slurId;
      } else {
        group.endStr = str;
        group.endT   = ev.t;
        group.endDur = ev.dur;
      }
    } else {
      if (group) { SLUR_GROUPS.push(group); group = null; }
      lastId = null;
    }
  });
  if (group) SLUR_GROUPS.push(group);
}

function getCurrentEvent(pos) {
  for (let i = SCORE.length - 1; i >= 0; i--) {
    if (pos >= SCORE[i].t) return SCORE[i];
  }
  return SCORE[0] || { notes: [], dynamic: 0.5, bow: "down", name: "" };
}

function isNoteCorrect(note) {
  const ev = getCurrentEvent(songPos);
  if (ev.rest) return !note;   // rest: correct only while silent
  if (!note) return false;
  const liveMidi = noteToMidi(note);
  if (liveMidi === null || !ev.pitches) return false;
  return (ev.notes || [])
    .map(n => ev.pitches?.[n])
    .filter(Boolean)
    .map(noteToMidi)
    .some(m => m === liveMidi);
}

function hexAlpha(hex, alpha) {
  return hex + Math.round(Math.clamp01(alpha) * 255)
    .toString(16).padStart(2, "0");
}

// Clamp helper — attach to Math so it's globally available
Math.clamp01 = v => Math.max(0, Math.min(1, v));

//Draw one frame
function drawFrame() {
  if (!STRINGS.length) return;

  const W            = canvas.width;
  const H            = canvas.height;
  const dpr          = window.devicePixelRatio;
  const bpm          = parseInt(tempoSlider.value, 10);
  const intensity    = parseInt(intensitySlider.value, 10) / 10;
  const beatsPerSec  = bpm / 60;

  //Scrolling window: 2 beats behind, 8 beats ahead (≈ 2 measures)
  //TODO make this dynamic on the input
  const PAST_BEATS   = 2;
  const FUTURE_BEATS = 8;
  const WINDOW_BEATS = PAST_BEATS + FUTURE_BEATS;
  const PLAYHEAD_X   = (PAST_BEATS / WINDOW_BEATS) * W;   //fixed at 20

  const timeToX = t => PLAYHEAD_X + ((t - songPos) / WINDOW_BEATS) * W;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0a0a0f";
  ctx.fillRect(0, 0, W, H);

  const ev         = getCurrentEvent(songPos);
  const dynamicAmp = ev.dynamic * intensity;
  const nLanes     = STRINGS.length;
  const laneH      = H / nLanes;

  //grid lines
  const windowStart = songPos - PAST_BEATS;
  const windowEnd   = songPos + FUTURE_BEATS;
  const firstBar    = Math.ceil(windowStart / 4) * 4;
  for (let bar = firstBar; bar <= windowEnd; bar += 4) {
    const bx = timeToX(bar);
    if (bx < 0 || bx > W) continue;
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth   = 1;
    ctx.setLineDash([3 * dpr, 6 * dpr]);
    ctx.beginPath(); ctx.moveTo(bx, 0); ctx.lineTo(bx, H); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font      = `400 ${Math.round(9 * dpr)}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.1)";
    ctx.textAlign = "left";
    ctx.fillText(`M${Math.round(bar / 4) + 1}`, bx + 4 * dpr, 11 * dpr);
  }

  STRINGS.forEach((str, si) => {
    const laneY          = si * laneH;
    const midY           = laneY + laneH / 2;
    const isCurrentActive = ev.notes.includes(str.name);
    const modFreq        = str.freq * (1 + (bpm - 72) / 600);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, laneY, W, laneH);
    ctx.clip();

    //Lane background tint
    ctx.fillStyle = str.color + (isCurrentActive ? "0c" : "05");
    ctx.fillRect(0, laneY, W, laneH);

    //Event blocks for every score event in the visible window
    SCORE.forEach(scoreEv => {
      if (!scoreEv.notes.includes(str.name)) return;

      const bLeft  = timeToX(scoreEv.t);
      const bRight = timeToX(scoreEv.t + scoreEv.dur);
      if (bRight <= 0 || bLeft >= W) return;

      const cLeft  = Math.max(0, bLeft);
      const cRight = Math.min(W, bRight);
      const bW     = cRight - cLeft;
      if (bW <= 0) return;

      const isCurrent  = scoreEv === ev;
      const isPast     = bRight < PLAYHEAD_X;
      const futureFrac = Math.max(0, (bLeft - PLAYHEAD_X) / (W - PLAYHEAD_X));

      // Fill
      const fillA = isPast     ? 0.10
                  : isCurrent ? 0.38
                  : Math.max(0.10, 0.30 * (1 - futureFrac * 0.65));
      ctx.fillStyle = str.color + Math.round(fillA * 255).toString(16).padStart(2, "0");
      ctx.fillRect(cLeft, laneY + 4, bW, laneH - 8);

      //Border — suppressed for slurred notes (group border drawn separately)
      if (!isPast && !scoreEv.slur) {
        const borderA = isCurrent ? 0.75 : Math.max(0.15, 0.45 * (1 - futureFrac));
        ctx.strokeStyle = str.color + Math.round(borderA * 255).toString(16).padStart(2, "0");
        ctx.lineWidth   = (isCurrent ? 1.5 : 0.75) * dpr;
        ctx.strokeRect(cLeft + 0.5, laneY + 4.5, bW - 1, laneH - 9);
      }

      //Pitch label inside the block
      const pitch = scoreEv.pitches?.[str.name];
      if (!isPast && pitch) {
        const letter   = pitch.replace(/\d$/, "");
        const octave   = pitch.match(/\d$/)?.[0] ?? "";
        const labelX   = Math.max(cLeft + 7 * dpr, bLeft + 7 * dpr);
        const roomW    = Math.min(W, bRight) - labelX - 4 * dpr;
        if (roomW > 8 * dpr) {
          const fSize  = isCurrent ? 15 : 12;
          const labelA = isCurrent ? 1.0 : Math.max(0.3, 0.85 * (1 - futureFrac * 0.6));
          ctx.font      = `500 ${Math.round(fSize * dpr)}px Inter, system-ui, sans-serif`;
          ctx.fillStyle = str.color + Math.round(labelA * 255).toString(16).padStart(2, "0");
          ctx.textAlign = "left";
          ctx.fillText(letter, labelX, midY + 5 * dpr);
          const lw = ctx.measureText(letter).width;
          ctx.font      = `400 ${Math.round((fSize - 4) * dpr)}px Inter, system-ui, sans-serif`;
          ctx.fillStyle = str.color + Math.round(labelA * 0.6 * 255).toString(16).padStart(2, "0");
          ctx.fillText(octave, labelX + lw + 1 * dpr, midY + 5 * dpr);
        }
      }
    });

    //Waveform animation clipped to the current block
    if (isCurrentActive) {
      const amp       = dynamicAmp * laneH * 0.32;
      const bowDir    = ev.bow === "down" ? 1 : -1;
      const bowOffset = Math.sin(time * beatsPerSec * Math.PI) * amp * 0.15 * bowDir;
      const wLeft     = Math.max(0, timeToX(ev.t));
      const wRight    = Math.min(W, timeToX(ev.t + ev.dur));
      const wSpan     = wRight - wLeft;

      ctx.save();
      ctx.beginPath();
      ctx.rect(wLeft, laneY, wSpan, laneH);
      ctx.clip();

      for (let w = 0; w < 3; w++) {
        const wAlpha = (1 - w * 0.28) * 0.8;
        const wAmp   = amp * (1 - w * 0.25);
        const wPhase = str.phase + w * 0.4;

        if (w === 0) {
          const grad = ctx.createLinearGradient(0, midY - wAmp, 0, midY + wAmp);
          grad.addColorStop(0,   str.color + "cc");
          grad.addColorStop(0.5, str.color + "ff");
          grad.addColorStop(1,   str.color + "cc");
          ctx.strokeStyle = grad;
          ctx.lineWidth   = 2.5 * dpr * 0.6;
        } else {
          ctx.strokeStyle = str.color + Math.round(wAlpha * 255).toString(16).padStart(2, "0");
          ctx.lineWidth   = Math.max(0.5, (2 - w) * dpr * 0.5);
        }

        ctx.beginPath();
        const steps = Math.floor(wSpan / 2);
        for (let xi = 0; xi <= steps; xi++) {
          const t1      = xi / steps;
          const x       = wLeft + t1 * wSpan;
          const vibrato = Math.sin(time * 8 + t1 * 12) * amp * 0.08;
          const harm    = Math.sin(t1 * Math.PI * 4 * modFreq + time * modFreq * 3 + wPhase) * amp * 0.3;
          const main    = Math.sin(t1 * Math.PI * 2 * modFreq + time * modFreq * 2 + wPhase) * wAmp;
          const y       = midY + main + harm + vibrato + bowOffset;
          xi === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      //Particles
      const particleCount = Math.floor(intensity * 8);
      for (let p = 0; p < particleCount; p++) {
        const px    = wLeft + ((time * (40 + p * 17) * modFreq) % 1) * wSpan;
        const waveX = (px - wLeft) / wSpan;
        const waveY = midY + Math.sin(waveX * Math.PI * 2 * modFreq + time * modFreq * 2 + str.phase) * amp;
        const pSize  = (1.5 + Math.sin(time * 3 + p) * 0.8) * dpr;
        const pAlpha = 0.4 + Math.sin(time * 2 + p * 0.7) * 0.3;
        ctx.beginPath();
        ctx.arc(px, waveY, pSize, 0, Math.PI * 2);
        ctx.fillStyle = str.color + Math.round(pAlpha * 255).toString(16).padStart(2, "0");
        ctx.fill();
      }

      ctx.restore();
    }

    //Live pitch indicator
    if (isCurrentActive && liveFreq > 0 && ev.pitches?.[str.name]) {
      const targetMidi = noteToMidi(ev.pitches[str.name]);
      if (targetMidi !== null) {
        const targetFreq = 440 * Math.pow(2, (targetMidi - 69) / 12);
        //a cent is a logarithmic unit used to measure the pitch interval between two notes
        const cents      = 1200 * Math.log2(liveFreq / targetFreq);
        const clamped    = Math.max(-60, Math.min(60, cents));
        //sharp (cents > 0) → line moves UP (lower Y), flat → DOWN
        const lineY      = midY - (clamped / 60) * (laneH * 0.38);
        const inTune     = Math.abs(cents) < 10;
        //Warn if too high/sharp or too low/flat
        const lineColor  = inTune ? "#4ade80" : cents > 0 ? "#f87171" : "#60a5fa";

        // Faint dashed center (target pitch)
        ctx.strokeStyle = "rgba(255,255,255,0.13)";
        ctx.lineWidth   = 1 * dpr;
        ctx.setLineDash([4 * dpr, 5 * dpr]);
        ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(W, midY); ctx.stroke();
        ctx.setLineDash([]);

        // Live pitch line with glow
        ctx.strokeStyle = lineColor + "cc";
        ctx.lineWidth   = 2 * dpr;
        ctx.shadowColor = lineColor;
        ctx.shadowBlur  = 8 * dpr;
        ctx.beginPath(); ctx.moveTo(0, lineY); ctx.lineTo(W, lineY); ctx.stroke();
        ctx.shadowBlur  = 0;
      }
    }

    //String name label (pinned left)
    ctx.font      = `500 ${Math.round(11 * dpr)}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = isCurrentActive ? str.color : "rgba(255,255,255,0.12)";
    ctx.textAlign = "left";
    ctx.fillText(str.name, 5 * dpr, midY + 4 * dpr);

    //Lane line
    if (si < nLanes - 1) {
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(0, laneY + laneH);
      ctx.lineTo(W, laneY + laneH);
      ctx.stroke();
    }

    ctx.restore();
  });

  //Rests — drawn as a neutral band across all lanes since they have no string
  SCORE.forEach(scoreEv => {
    if (!scoreEv.rest) return;

    const bLeft  = timeToX(scoreEv.t);
    const bRight = timeToX(scoreEv.t + scoreEv.dur);
    if (bRight <= 0 || bLeft >= W) return;

    const cLeft = Math.max(0, bLeft);
    const cRight = Math.min(W, bRight);
    const bW    = cRight - cLeft;
    if (bW <= 0) return;

    const isCurrent = scoreEv === ev;
    const isPast    = bRight < PLAYHEAD_X;

    const fillA = isPast ? 0.03 : isCurrent ? 0.10 : 0.06;
    ctx.fillStyle = `rgba(255,255,255,${fillA})`;
    ctx.fillRect(cLeft, 0, bW, H);

    if (!isPast) {
      ctx.strokeStyle = `rgba(255,255,255,${isCurrent ? 0.3 : 0.14})`;
      ctx.lineWidth   = (isCurrent ? 1.5 : 1) * dpr;
      ctx.setLineDash([2 * dpr, 5 * dpr]);
      ctx.strokeRect(cLeft + 0.5, 0.5, bW - 1, H - 1);
      ctx.setLineDash([]);

      if (bW > 10 * dpr) {
        ctx.font      = `500 ${Math.round((isCurrent ? 16 : 13) * dpr)}px Inter, system-ui, sans-serif`;
        ctx.fillStyle = `rgba(255,255,255,${isCurrent ? 0.55 : 0.3})`;
        ctx.textAlign = "center";
        ctx.fillText("𝄽", (cLeft + cRight) / 2, H / 2 + 5 * dpr);
      }
    }
  });

  //Slur groups: unified border + arc
  SLUR_GROUPS.forEach(sg => {
    const x1    = timeToX(sg.startT);
    const x2    = timeToX(sg.endT);              //arc ends at START of last note 
    const x2End = timeToX(sg.endT + sg.endDur);  //border extends to end of last note
    if (x2End <= 0 || x1 >= W) return;

    const si1 = STRINGS.findIndex(s => s.name === sg.startStr);
    const si2 = STRINGS.findIndex(s => s.name === sg.endStr);
    if (si1 < 0 || si2 < 0) return;

    const str1    = STRINGS[si1];
    const str2    = STRINGS[si2];
    const laneY1  = si1 * laneH;
    const laneY2  = si2 * laneH;
    // Arc endpoints at the horizontal centre of the first and last note blocks
    const arcX1   = Math.max(0, timeToX(sg.startT + sg.startDur / 2));
    const arcX2   = Math.min(W, timeToX(sg.endT   + sg.endDur   / 2));
    const arcY1   = laneY1 + 6 * dpr;
    const arcY2   = laneY2 + 6 * dpr;

    ctx.setLineDash([]);

    if (si1 === si2) {
      // ── Same-string slur ───────────────────────────────────────────
      const overhang = 10 * dpr;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, laneY1 - overhang, W, laneH + overhang);
      ctx.clip();

      // Outer border spanning first note to end of last note
      const bL = Math.max(0, x1);
      const bR = Math.min(W, x2End);
      ctx.strokeStyle = str1.color + "cc";
      ctx.lineWidth   = 1.5 * dpr;
      ctx.strokeRect(bL + 0.5, laneY1 + 4.5, bR - bL - 1, laneH - 9);

      // Arc bowing above the blocks
      const midX   = (arcX1 + arcX2) / 2;
      const arcCpY = laneY1 - overhang + 2 * dpr;
      ctx.strokeStyle = str1.color + "ee";
      ctx.lineWidth   = 2 * dpr;
      ctx.shadowColor = str1.color;
      ctx.shadowBlur  = 5 * dpr;
      ctx.beginPath();
      ctx.moveTo(arcX1, arcY1);
      ctx.quadraticCurveTo(midX, arcCpY, arcX2, arcY1);
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.fillStyle = str1.color + "ee";
      if (x1 >= 0) { ctx.beginPath(); ctx.arc(arcX1, arcY1, 3 * dpr, 0, Math.PI * 2); ctx.fill(); }
      if (x2 <= W) { ctx.beginPath(); ctx.arc(arcX2, arcY1, 3 * dpr, 0, Math.PI * 2); ctx.fill(); }

      ctx.restore();

    } else {
      //Cross-string slur
      //Arc drawn without lane clipping so it can cross boundaries.
      //Control point sits above the topmost lane, centred horizontally.
      const topLaneY = Math.min(laneY1, laneY2);
      const cpX      = (arcX1 + arcX2) / 2;
      const cpY      = topLaneY - 10 * dpr;   // peaks above the higher string lane

      ctx.strokeStyle = str1.color + "dd";
      ctx.lineWidth   = 2 * dpr;
      ctx.shadowColor = str1.color;
      ctx.shadowBlur  = 5 * dpr;
      ctx.beginPath();
      ctx.moveTo(arcX1, arcY1);
      ctx.quadraticCurveTo(cpX, cpY, arcX2, arcY2);
      ctx.stroke();
      ctx.shadowBlur = 0;

      //endpoint dots in each string's colour
      ctx.fillStyle = str1.color + "ee";
      if (x1 >= 0) { ctx.beginPath(); ctx.arc(arcX1, arcY1, 3 * dpr, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = str2.color + "ee";
      if (x2 <= W) { ctx.beginPath(); ctx.arc(arcX2, arcY2, 3 * dpr, 0, Math.PI * 2); ctx.fill(); }
    }
  });

  //Beat metronome flash
  const beatPhase = (time * beatsPerSec) % 1;
  if (playing && beatPhase < 0.12) {
    const t = 1 - beatPhase / 0.12;
    const glow = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, H * 0.6);
    glow.addColorStop(0, `rgba(196,169,107,${(0.04 * t).toFixed(3)})`);
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
  }

  //Playhead (fixed vertical line)
  ctx.strokeStyle = "rgba(196,169,107,0.85)";
  ctx.lineWidth   = 1.5 * dpr;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(PLAYHEAD_X, 0);
  ctx.lineTo(PLAYHEAD_X, H);
  ctx.stroke();
}

// ── Animation loop ────────────────────────────────────────────────────────────
function loop(ts) {
  if (!lastTs) lastTs = ts;
  const dt = Math.min((ts - lastTs) / 1000, 0.05);
  lastTs = ts;

  const bpm = parseInt(tempoSlider.value, 10);
  time += dt;

  if (mode === "play-along") {
    songPos += dt * (bpm / 72);
    if (songPos >= SONG_DURATION) songPos = 0;
    holdStart = null;
    advanceTarget = null;
  } else {
    //Wait for Me: keep creeping forward at tempo even before the note is played, but never more than half the current note's length ahead of
    //its start — once that slack is used up the cursor parks there until the note is actually played. Once it is being played correctly, the
    //cap no longer applies the cursor keeps moving smoothly through the note while the hold timer below confirms it, instead of freezing.
    const correctNow = isNoteCorrect(liveNote);
    if (advanceTarget === null) {
      const waitingEv = getCurrentEvent(songPos);

      //Stop just short of the note's own end (not exactly at it) so
      //getCurrentEvent doesn't flip to the next note before this one
      //is actually confirmed via the hold timer below.
      const cap = correctNow
        ? waitingEv.t + waitingEv.dur - 0.001
        : waitingEv.t + waitingEv.dur * 0.5;
      songPos = Math.min(songPos + dt * (bpm / 72), cap);
    }

    //Advance only once correct note is held for its required time
    if (correctNow) {
      if (holdStart === null) holdStart = ts;
      const ev = getCurrentEvent(songPos);
      if (ts - holdStart >= holdRequiredMs(ev, bpm) && advanceTarget === null) {
        const idx = SCORE.indexOf(ev);
        const nxt = SCORE[idx + 1];
        if (nxt) {
          advanceTarget = nxt.t;
        } else {
          songPos = 0;
        }
        holdStart = null;
      }
    } else {
      holdStart = null;
    }

    // Glide toward the next note at the current tempo instead of snapping
    if (advanceTarget !== null) {
      songPos += dt * (bpm / 72);
      if (songPos >= advanceTarget) {
        songPos = advanceTarget;
        advanceTarget = null;
      }
    }
  }

  const ev = getCurrentEvent(songPos);
  movementDisplay.textContent = ev.name || "";

  const beat = (Math.floor(time * bpm / 60) % 4) + 1;
  beatDisplay.textContent = "♩ " + beat;

  timelineFill.style.width = ((songPos / SONG_DURATION) * 100).toFixed(1) + "%";

  drawFrame();
  animFrame = requestAnimationFrame(loop);
}

// ── Controls ─────────────────────────────────────────────────────────────────
playBtn.addEventListener("click", () => {
  playing = !playing;
  if (playing) {
    playBtn.innerHTML = '<i class="ti ti-player-pause" aria-hidden="true"></i>';
    lastTs = null;
    animFrame = requestAnimationFrame(loop);
  } else {
    playBtn.innerHTML = '<i class="ti ti-player-play" aria-hidden="true"></i>';
    cancelAnimationFrame(animFrame);
  }
});

tempoSlider.addEventListener("input", () => {
  tempoVal.textContent = tempoSlider.value + " BPM";
});

intensitySlider.addEventListener("input", () => {
  intensityVal.textContent = intensitySlider.value;
});

//Click on timeline to scrub
document.getElementById("timeline").addEventListener("click", (e) => {
  const rect  = e.currentTarget.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  const raw   = ratio * SONG_DURATION;
  if (mode === "wait-for-me" && SCORE.length) {
    //Snap to the start of whichever note event is closest to the click
    const next = SCORE.find(ev => ev.t >= raw);
    const prev = [...SCORE].reverse().find(ev => ev.t < raw);
    const snapNext = next ? Math.abs(next.t - raw) : Infinity;
    const snapPrev = prev ? Math.abs(prev.t - raw) : Infinity;
    songPos = (snapNext <= snapPrev ? next : prev).t;
    holdStart = null;
    advanceTarget = null;
  } else {
    songPos = raw;
  }
  if (!playing) drawFrame();
});

pieceSelect.addEventListener("change", () => {
  const wasPlaying = playing;
  if (playing) {
    playing = false;
    cancelAnimationFrame(animFrame);
    playBtn.innerHTML = '<i class="ti ti-player-play" aria-hidden="true"></i>';
  }
  loadScore(pieceSelect.value).then(() => {
    if (wasPlaying) {
      playing = true;
      playBtn.innerHTML = '<i class="ti ti-player-pause" aria-hidden="true"></i>';
      lastTs = null;
      animFrame = requestAnimationFrame(loop);
    }
  });
});

//Note → MIDI conversion
function noteToMidi(note) {
  const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const m = note.match(/^([A-G])([#b]?)(-?\d+)$/);
  if (!m) return null;
  const semi = SEMI[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
  return (parseInt(m[3], 10) + 1) * 12 + semi;
}

//Live note polling
setInterval(async () => {
  try {
    const res  = await fetch("/api/live-note");
    const data = await res.json();
    liveNote = data.note;   // keep globals in sync
    liveFreq = data.freq || 0;

    if (!data.note) {
      liveNoteDisplay.textContent = "—";
      liveNoteDisplay.style.opacity = "0.25";
      liveNoteDisplay.className = "";
      return;
    }

    liveNoteDisplay.textContent = data.note;
    liveNoteDisplay.style.opacity = "1";

    // Collect expected MIDI pitches for the current score position
    const ev = getCurrentEvent(songPos);
    const expectedMidis = (ev.notes || [])
      .map(n => ev.pitches?.[n])
      .filter(Boolean)
      .map(noteToMidi)
      .filter(m => m !== null);

    if (!expectedMidis.length) { liveNoteDisplay.className = ""; return; }

    const liveMidi = noteToMidi(data.note);
    if (liveMidi === null) { liveNoteDisplay.className = ""; return; }

    const closest = expectedMidis.reduce((best, m) =>
      Math.abs(m - liveMidi) < Math.abs(best - liveMidi) ? m : best
    );

    if (liveMidi === closest)      liveNoteDisplay.className = "correct";
    else if (liveMidi < closest)   liveNoteDisplay.className = "too-low";
    else                           liveNoteDisplay.className = "too-high";

  } catch (_) { /* server not yet ready */ }
}, 50);

//Back button
document.getElementById("backBtn").addEventListener("click", () => {
  if (playing) {
    playing = false;
    cancelAnimationFrame(animFrame);
    playBtn.innerHTML = '<i class="ti ti-player-play" aria-hidden="true"></i>';
  }
  startScreen.style.display = "";
  requestAnimationFrame(() => { startScreen.style.opacity = "1"; });
});

//Start screen
const startScreen = document.getElementById("start-screen");

document.querySelectorAll(".mode-card").forEach(card => {
  card.addEventListener("click", () => {
    document.querySelectorAll(".mode-card").forEach(c => c.classList.remove("selected"));
    card.classList.add("selected");
  });
});

document.getElementById("startBtn").addEventListener("click", async () => {
  const pieceCard = document.querySelector(".piece-card.selected");
  const modeCard  = document.querySelector(".mode-card.selected");
  const pieceId   = pieceCard?.dataset.pieceId ?? pieceSelect.value;

  mode = modeCard?.dataset.mode ?? "play-along";
  modeBadge.textContent = mode === "wait-for-me" ? "Wait for Me" : "Play Along";

  if (pieceId) pieceSelect.value = pieceId;
  await loadScore(pieceId);

  //Fade out start screen
  startScreen.style.opacity = "0";
  startScreen.addEventListener("transitionend", () => {
    startScreen.style.display = "none";
  }, { once: true });

  //Begin animation
  if (!playing) {
    playing = true;
    playBtn.innerHTML = '<i class="ti ti-player-pause" aria-hidden="true"></i>';
    lastTs    = null;
    animFrame = requestAnimationFrame(loop);
  }
});

loadPieceList();
