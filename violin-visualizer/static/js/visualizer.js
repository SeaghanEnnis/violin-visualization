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
import { Scorer, freqToMidi, gradeFor } from "./scoring.js";

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
let lastMicActive = true;           // last /api/live-note "mic" flag seen — refresh the picker when this flips
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
const micSelect        = document.getElementById("micSelect");
const micRefreshBtn    = document.getElementById("micRefresh");
const micStatus        = document.getElementById("micStatus");
const sheetArea        = document.getElementById("sheet-area");
const sheetScroll      = document.getElementById("sheetScroll");
const sheetPages       = document.getElementById("sheetPages");
const sheetRowHighlight = document.getElementById("sheetRowHighlight");
const appEl            = document.getElementById("app");
const scoreHud         = document.getElementById("scoreHud");
const noteFeedback     = document.getElementById("noteFeedback");
const countInEl        = document.getElementById("countIn");
const resultsEl        = document.getElementById("results");

// ── Input device picker ──────────────────────────────────────────────────────
// The backend (app.py) ranks devices by the current OS's native audio API —
// WASAPI on Windows, Core Audio on Mac, ALSA/PulseAudio on Linux — and this
// dropdown lets the auto-picked one be overridden. "Auto-detect" (empty
// value) asks the server to re-run that same platform-aware pick.
async function loadAudioDevices(preserveSelection = true) {
  const wanted = preserveSelection ? micSelect.value : "";
  try {
    const res  = await fetch("/api/audio-devices");
    const data = await res.json();

    micSelect.innerHTML = "";
    const autoOpt = document.createElement("option");
    autoOpt.value = "";
    autoOpt.textContent = "Auto-detect";
    micSelect.appendChild(autoOpt);
    data.devices.forEach(d => {
      const opt = document.createElement("option");
      opt.value       = d.index;
      opt.textContent = `${d.name} — ${d.hostapi}`;
      micSelect.appendChild(opt);
    });

    //Keep whatever the user had selected if it's still in the list; otherwise
    //reflect what the server is actually running (may differ from "wanted"
    //right after a failed switch, which falls back to auto).
    const stillThere = wanted && [...micSelect.options].some(o => o.value === wanted);
    micSelect.value = stillThere ? wanted : (data.auto ? "" : String(data.current ?? ""));

    micStatus.className = data.active ? "mic-status ok" : "mic-status fail";
    micStatus.title = data.active
      ? `Listening on ${data.name ?? "device " + data.current}`
      : "No working microphone — Wait for Me and Points modes won't hear you";
  } catch (err) {
    micStatus.className = "mic-status fail";
    micStatus.title = "Could not reach the server to list input devices";
    console.error("Failed to load audio devices:", err);
  }
}

micSelect.addEventListener("change", async () => {
  const raw    = micSelect.value;
  const device = raw === "" ? null : parseInt(raw, 10);
  micSelect.disabled = true;
  //A device that fails can take a few seconds (a couple of retries on the
  //server, since some devices only fail a beat after they're asked to start)
  //— without this the picker just looks frozen for that stretch.
  micStatus.className = "mic-status";
  micStatus.title = "Switching…";
  try {
    const res  = await fetch("/api/audio-devices", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ device }),
    });
    const data = await res.json();
    if (!data.ok) console.warn("Could not switch input device:", data.error);
    await loadAudioDevices();
  } finally {
    micSelect.disabled = false;
  }
});

micRefreshBtn.addEventListener("click", () => {
  micRefreshBtn.classList.add("spinning");
  loadAudioDevices().finally(() => micRefreshBtn.classList.remove("spinning"));
});

// ── Sheet-music PDF sync ─────────────────────────────────────────────────────
// Scroll position follows songPos through PIXEL_ANCHORS — {t, y} points built
// from %%sync page/row tags in the ABC source (see sheet_music_reader.py): the
// view holds at a row's y while it plays and eases to the next row's y as that
// row starts (see interpolateSheetAnchors). Where each row really sits on the
// page is found by scanning the rendered page for its staves
// (detectStaffSystems), so title blocks, margins and blank paper don't distort
// the spacing; if that can't be trusted the rows are assumed evenly spaced down
// the page. With no tags at all we fall back to a uniform songPos/SONG_DURATION
// mapping onto the PDF's total scroll height, which drifts on pieces with
// uneven engraving but at least keeps moving in lockstep with tempo.
let pdfDoc          = null;
let currentPdfUrl   = null;
let sheetMaxScroll  = 0;
let SYNC_ANCHORS    = [];      // raw {t, page, row} from the API
let SYNC_PAGE_ROWS  = {};      // declared {page: totalRows} from %%syncpage, keyed by string
let PAGE_META       = [];      // [{top, height, left, width}] per PDF page, 0-indexed
let PAGE_SYSTEMS    = {};      // {pageNum: {systems:[{top}], staffGap} | null} detected staves, as fractions of page height
let PIXEL_ANCHORS   = [];      // [{t, y}] resolved from SYNC_ANCHORS + PAGE_META, sorted by t
let ROW_BANDS       = [];      // [{t, page, top, bottom}] the strip to highlight for each tagged row, sorted by t
let highlightedBand = -2;      // index into ROW_BANDS currently shown (-1 = none, -2 = needs placing)
let userScrolling   = false;   // true while the user is actively/recently interacting
let snapping        = false;   // true while catching back up to the time-derived position
let userScrollTimer = null;
//The view holds still while a row plays, and eases to the next row only once
//that row has started — so the last measures of a row, which you're reading
//ahead into the next row from, never move under you.
//  LOOKBACK_ROWS: where the held row sits, in rows below the top of the panel,
//    so the previous row stays visible above it for context.
//  GLIDE_BEATS: how long the ease to the next row takes, counted from that
//    row's first beat (a bar's worth by default), and never more than
//    GLIDE_MAX_FRACTION of the row so a short row still settles.
const SCROLL_LOOKBACK_ROWS  = 1;
const SCROLL_GLIDE_BEATS    = 4;
const SCROLL_GLIDE_MAX_FRACTION = 0.4;
const SNAP_INACTIVITY_MS = 900;   // how long to leave the user alone after they scroll
const SNAP_CATCHUP       = 0.22;  // fraction of the gap closed per animation frame
const SNAP_DONE_PX       = 1.5;

//Finds the staff systems on a PDF page: renders it offscreen at a fixed
//scale and scans for long horizontal ink runs (the staff lines — everything
//else on the page, notes and text and beams, spans far less of the width),
//then groups those into systems. Positions come back as fractions of the
//page height so they hold at any display size. Null if nothing staff-like.
async function detectStaffSystems(pageNum) {
  const page     = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 2 });
  const off      = document.createElement("canvas");
  off.width  = Math.ceil(viewport.width);
  off.height = Math.ceil(viewport.height);
  const octx = off.getContext("2d", { willReadFrequently: true });
  await page.render({ canvasContext: octx, viewport }).promise;

  const { data, width: W, height: H } = octx.getImageData(0, 0, off.width, off.height);

  const isLineRow = new Uint8Array(H);
  for (let y = 0; y < H; y++) {
    let dark = 0;
    for (let x = 0, i = y * W * 4; x < W; x++, i += 4) {
      //Composite over white so a transparent page background isn't read as black
      const a    = data[i + 3] / 255;
      const gray = 255 - a * (255 - (data[i] + data[i + 1] + data[i + 2]) / 3);
      if (gray < 170) dark++;
    }
    isLineRow[y] = dark / W >= 0.4 ? 1 : 0;
  }

  //Consecutive line rows are one staff line (allowing a 2px antialiasing gap)
  const lines = [];
  let runStart = -1, runEnd = -1;
  for (let y = 0; y < H; y++) {
    if (isLineRow[y]) {
      if (runStart < 0) runStart = y;
      runEnd = y;
    } else if (runStart >= 0 && y - runEnd > 2) {
      lines.push((runStart + runEnd) / 2);
      runStart = -1;
    }
  }
  if (runStart >= 0) lines.push((runStart + runEnd) / 2);
  if (lines.length < 4) return null;

  //Lines within a staff sit one staffGap apart; systems are separated by far more
  const gaps     = lines.slice(1).map((y, i) => y - lines[i]);
  const minGap   = Math.min(...gaps);
  const small    = gaps.filter(g => g <= minGap * 1.6).sort((a, b) => a - b);
  const staffGap = small[Math.floor(small.length / 2)];

  const groups = [];
  let cur = [lines[0]];
  gaps.forEach((g, i) => {
    if (g > staffGap * 2.2) { groups.push(cur); cur = []; }
    cur.push(lines[i + 1]);
  });
  groups.push(cur);

  const systems = groups.filter(g => g.length >= 4).map(g => ({ top: g[0] / H }));
  return systems.length ? { systems, staffGap: staffGap / H } : null;
}

//Detects staves on just the pages the ABC actually tags (cached per PDF).
async function detectTaggedPages() {
  const pages = [...new Set(SYNC_ANCHORS.map(a => a.page))];
  for (const p of pages) {
    if (p in PAGE_SYSTEMS || p > pdfDoc.numPages) continue;
    try {
      PAGE_SYSTEMS[p] = await detectStaffSystems(p);
    } catch (err) {
      console.warn(`Staff detection failed on page ${p}:`, err);
      PAGE_SYSTEMS[p] = null;
    }
  }
}

//Where a page's rows sit, in scroll-content pixels: {rows, rowY(row), rowBand(row)}
//— rowY is where to scroll to for a row, rowBand the {top, bottom} strip to
//highlight while it plays. Uses the detected staves when they agree with the
//row count (declared by %%syncpage, else the highest row tagged); otherwise
//spaces the rows evenly down the page, which is only right for a page the
//music fills edge to edge.
function pageRowLayout(page, maxTaggedRow) {
  const meta = PAGE_META[page - 1];
  if (!meta) return null;

  const declared = SYNC_PAGE_ROWS[page];
  const found    = PAGE_SYSTEMS[page];
  const trusted  = found && (declared ? found.systems.length === declared
                                      : found.systems.length >= maxTaggedRow);
  if (found && declared && !trusted) {
    console.warn(`Page ${page}: found ${found.systems.length} staves but %%syncpage declares ${declared} rows — spacing the rows evenly instead.`);
  }

  if (trusted) {
    //Sit a little above the top staff line so measure numbers, tempo marks
    //and high notes stay in view rather than being clipped by the panel edge.
    const staffH = found.staffGap * meta.height * 4;   // five lines = four gaps
    const lead   = staffH;
    const tops   = found.systems.map(s => meta.top + s.top * meta.height);
    //Highlight = the staff plus half the space to its neighbour on either
    //side, so the bands tile the page and take in the stems, dynamics and
    //measure numbers that sit around the staff.
    const pitchAt = i => i + 1 < tops.length ? tops[i + 1] - tops[i]
                       : i > 0               ? tops[i] - tops[i - 1]
                       :                       staffH * 3;
    const buffer = SCROLL_LOOKBACK_ROWS * (tops.length > 1 ? (tops[tops.length - 1] - tops[0]) / (tops.length - 1) : staffH * 3);
    return {
      rows: tops.length,
      rowY: row => tops[row - 1] - lead - buffer,
      rowBand: row => {
        const i = row - 1, margin = Math.max(0, (pitchAt(i) - staffH) / 2);
        return { top: tops[i] - margin, bottom: tops[i] + staffH + margin };
      },
    };
  }

  const rows = declared || maxTaggedRow;
  const rowH = meta.height / rows;
  return {
    rows,
    rowY: row => meta.top + (row - 1) * rowH - SCROLL_LOOKBACK_ROWS * rowH,
    rowBand: row => ({ top: meta.top + (row - 1) * rowH, bottom: meta.top + row * rowH }),
  };
}

//Builds {t, y} pixel anchors from the raw page/row sync tags.
function buildPixelAnchors() {
  PIXEL_ANCHORS = [];
  ROW_BANDS     = [];
  highlightedBand = -2;   // force the highlight to re-place itself against the new layout
  if (!SYNC_ANCHORS.length || !PAGE_META.length) return;

  const maxRow = {};
  SYNC_ANCHORS.forEach(a => { maxRow[a.page] = Math.max(maxRow[a.page] || 0, a.row); });
  const layouts = {};
  Object.keys(maxRow).forEach(p => { layouts[p] = pageRowLayout(Number(p), maxRow[p]); });

  const resolved = SYNC_ANCHORS
    .map(a => layouts[a.page] && { t: a.t, y: layouts[a.page].rowY(a.row), page: a.page, row: a.row })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
  if (!resolved.length) return;

  PIXEL_ANCHORS = resolved.map(({ t, y }) => ({ t, y }));
  ROW_BANDS     = resolved.map(r => ({ t: r.t, page: r.page, ...layouts[r.page].rowBand(r.row) }));
}

//Where the sheet should be scrolled to right now — never past the end of the
//last page. Near the end of a piece (or all through one whose pages barely
//exceed the panel) the ideal position (the current row SCROLL_LOOKBACK_ROWS
//below the top) lies beyond what can scroll, so the view just rests at the
//bottom of the document.
function sheetTargetScrollTop() {
  let y;
  if (PIXEL_ANCHORS.length) {
    y = interpolateSheetAnchors(songPos);
  } else {
    const ratio = SONG_DURATION > 0 ? Math.max(0, Math.min(1, songPos / SONG_DURATION)) : 0;
    y = ratio * sheetMaxScroll;
  }
  return Math.max(0, Math.min(y, sheetMaxScroll));
}

//Hold at the current row's y, easing over from the previous row's y during
//the opening beats of this row. (Easing after the row starts rather than
//before it means a row's final measures are read from a view that isn't
//moving.)
function interpolateSheetAnchors(t) {
  const anchors = PIXEL_ANCHORS;
  for (let i = anchors.length - 1; i > 0; i--) {
    if (t < anchors[i].t) continue;              // not into this row yet
    const rowLen = i + 1 < anchors.length ? anchors[i + 1].t - anchors[i].t : Infinity;
    const glide  = Math.min(SCROLL_GLIDE_BEATS, SCROLL_GLIDE_MAX_FRACTION * rowLen);
    const f      = glide > 0 ? Math.min(1, (t - anchors[i].t) / glide) : 1;
    const eased  = f * f * (3 - 2 * f);          // smoothstep: gentle at both ends
    return anchors[i - 1].y + (anchors[i].y - anchors[i - 1].y) * eased;
  }
  return anchors[0].y;                           // the first row, or before it
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

//Moves the highlight band to whichever tagged row songPos is currently in
//(the last one whose start time has passed). Only touches the DOM when the
//row actually changes; hidden before the first tagged row or with no tags.
function updateRowHighlight() {
  let idx = -1;
  if (pdfDoc) {
    for (let i = ROW_BANDS.length - 1; i >= 0; i--) {
      if (songPos >= ROW_BANDS[i].t) { idx = i; break; }
    }
  }
  if (idx === highlightedBand) return;

  const wasShown = highlightedBand >= 0;
  highlightedBand = idx;
  if (idx < 0) {
    sheetRowHighlight.style.display = "none";
    return;
  }

  const band = ROW_BANDS[idx];
  const meta = PAGE_META[band.page - 1];
  if (!meta) { sheetRowHighlight.style.display = "none"; return; }

  //Appearing (first show, or after a re-layout) shouldn't glide in from
  //wherever it last was — only row-to-row changes animate.
  if (!wasShown) sheetRowHighlight.style.transition = "none";
  sheetRowHighlight.style.display = "block";
  sheetRowHighlight.style.left    = meta.left + "px";
  sheetRowHighlight.style.width   = meta.width + "px";
  sheetRowHighlight.style.top     = band.top + "px";
  sheetRowHighlight.style.height  = (band.bottom - band.top) + "px";
  if (!wasShown) {
    void sheetRowHighlight.offsetHeight;   // commit the un-animated position
    sheetRowHighlight.style.transition = "";
  }
}

//Runs every frame regardless of play/pause so the sheet snaps into place
//immediately on load/scrub and still catches up while paused.
function sheetScrollLoop() {
  updateRowHighlight();
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
  ROW_BANDS = [];   // the old bands no longer match the pages; the highlight hides until rebuilt

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
      left:   canvasRect.left - scrollRect.left,
      width:  canvasRect.width,
    });
  }

  //The scrollable range is exactly the pages — no runway past the last one.
  //(Padding there would let late rows reach the top of the panel, but only by
  //scrolling the page away and showing an empty void, as if the PDF went on.)
  sheetMaxScroll = Math.max(0, sheetScroll.scrollHeight - sheetScroll.clientHeight);
  await detectTaggedPages();
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
    ROW_BANDS     = [];
    return;
  }

  sheetArea.hidden = false;
  userScrolling = false;
  snapping = false;
  clearTimeout(userScrollTimer);

  if (url === currentPdfUrl && pdfDoc) {
    await detectTaggedPages();   // page layout is already known; the tags may have changed
    buildPixelAnchors();
    sheetScroll.scrollTop = sheetTargetScrollTop();
    return;
  }

  currentPdfUrl = url;
  PAGE_SYSTEMS  = {};   // detected staves belong to the previous document
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
    if (mode === "points") preparePointsRun();   // new piece = new run
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
  //Before the first event (Points mode's count-in): nothing is current yet —
  //returning SCORE[0] would light its lane up and animate a note that hasn't
  //arrived.
  if (SCORE.length) return { notes: [], pitches: {}, dynamic: 0, bow: "down", name: "", rest: true, t: pos, dur: 0 };
  return { notes: [], dynamic: 0.5, bow: "down", name: "" };
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
    if (bar >= 0) ctx.fillText(`M${Math.round(bar / 4) + 1}`, bx + 4 * dpr, 11 * dpr);   // no "M0" in a count-in
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

  //Beat metronome flash (Points pulses off the song clock, so it agrees with the notes)
  const beatPhase = mode === "points" ? ((songPos % 1) + 1) % 1 : (time * beatsPerSec) % 1;
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

// ── Points mode ──────────────────────────────────────────────────────────────
// Plays like Play Along, but every note is scored (see scoring.js) from what
// the mic hears. The mic and the song run on different clocks, so each mic
// reading is stamped with when it was captured and placed on the song clock
// via posHistory; the scorer never sees wall-clock time.
const COUNT_IN_BEATS = 4;   // lead-in before the piece starts, so the first note is fair
const MODE_LABELS    = { "play-along": "Play Along", "wait-for-me": "Wait for Me", "points": "Points" };
let scorer       = null;
let posHistory   = [];      // [{ts, pos}] recent (frame time, songPos) pairs
let lastMicSeq   = -1;      // last mic block taken, so a block polled twice counts once
let micBlockSec  = 0.05;    // mic block length, from the server

//How long the audio device sits on sound before handing it over, beyond the
//block's own length. Nothing can measure this reliably (PortAudio's own
//figures for it disagreed on the real mic), so it's an allowance: a middle
//guess by default, adjustable from the results screen, remembered.
const MIC_DELAY_KEY = "violin.micDelayMs";
const MIC_DELAY_DEFAULT_MS = 100;
let micDelayMs = (() => {
  try {
    const v = parseInt(localStorage.getItem(MIC_DELAY_KEY), 10);
    return Number.isFinite(v) ? v : MIC_DELAY_DEFAULT_MS;
  } catch (_) { return MIC_DELAY_DEFAULT_MS; }
})();
function saveMicDelay() {
  try { localStorage.setItem(MIC_DELAY_KEY, String(micDelayMs)); } catch (_) { /* private mode etc. */ }
}

const hudScore   = document.getElementById("hudScore");
const hudTempo   = document.getElementById("hudTempo");
const hudNotes   = document.getElementById("hudNotes");
const hudTune    = document.getElementById("hudTune");
const hudWarn    = document.getElementById("hudWarn");

//Song beats per second — Play Along's rate, so Points runs at the same speed
const songRate = bpm => bpm / 72;

const ICON_PLAY  = '<i class="ti ti-player-play" aria-hidden="true"></i>';
const ICON_PAUSE = '<i class="ti ti-player-pause" aria-hidden="true"></i>';

//The pitches an event asks for (empty for a rest)
function expectedMidis(ev) {
  return (ev.notes || [])
    .map(n => ev.pitches?.[n])
    .filter(Boolean)
    .map(noteToMidi)
    .filter(m => m !== null);
}

//Show or hide everything that belongs to the chosen mode
function applyModeUi() {
  const pts = mode === "points";
  appEl.classList.toggle("mode-points", pts);
  modeBadge.textContent = MODE_LABELS[mode] ?? "Play Along";
  scoreHud.hidden   = !pts;
  countInEl.hidden  = true;
  resultsEl.hidden  = true;
  noteFeedback.classList.remove("show");
}

//Fresh scorer, and the song clock parked in the count-in
function preparePointsRun() {
  scorer = new Scorer(SCORE.map(ev => ({ t: ev.t, dur: ev.dur, midis: expectedMidis(ev) })));
  posHistory = [];
  lastMicSeq = -1;
  songPos    = -COUNT_IN_BEATS;
  time       = 0;
  resultsEl.hidden = true;
  noteFeedback.classList.remove("show");
  hudWarn.hidden = true;
  updateHud();
}

function recordPos(ts) {
  posHistory.push({ ts, pos: songPos });
  if (posHistory.length > 180) posHistory.shift();
}

//songPos at an earlier wall-clock moment (performance.now() time), or null
//if the frame history doesn't reach back that far (e.g. before a resume)
function songPosAt(wall) {
  const h = posHistory;
  if (h.length < 2 || wall < h[0].ts) return null;
  const last = h[h.length - 1];
  if (wall >= last.ts) return last.pos + (wall - last.ts) / 1000 * songRate(parseInt(tempoSlider.value, 10));
  for (let i = h.length - 1; i > 0; i--) {
    if (h[i - 1].ts <= wall) {
      const a = h[i - 1], b = h[i];
      return a.pos + (b.pos - a.pos) * ((wall - a.ts) / ((b.ts - a.ts) || 1));
    }
  }
  return null;
}

//One /api/live-note response → one scorer sample, if it's a block we haven't seen
function takeMicReading(data, respondedAt) {
  if (!scorer) return;
  hudWarn.hidden = data.mic !== false;
  if (data.seq === undefined || data.seq === lastMicSeq || data.age_ms == null) return;
  lastMicSeq = data.seq;
  if (data.block_ms) micBlockSec = data.block_ms / 1000;

  //When the audio was actually played, on this page's clock: the middle of
  //the block, before it reached the server (age), before the device handed
  //it over (micDelayMs).
  const capturedAt = respondedAt - data.age_ms - (data.block_ms || 0) / 2 - micDelayMs;
  const p = songPosAt(capturedAt);
  if (p === null) return;
  scorer.addSample({ p, midiF: data.freq > 0 ? freqToMidi(data.freq) : null });
}

const pctText = v => v === null || v === undefined ? "–" : Math.round(v * 100) + "%";

function updateHud() {
  const s = scorer ? scorer.summary() : null;
  hudScore.textContent = s ? s.points.toLocaleString() : "0";
  hudTempo.textContent = pctText(s?.tempo);
  hudNotes.textContent = pctText(s?.note);
  hudTune.textContent  = pctText(s?.intonation);
}

//The verdict on the note just judged, popped up beside the playhead
const FEEDBACK_CLASS = { perfect: "fb-perfect", tempo: "fb-tempo", wrong: "fb-wrong", sharp: "fb-sharp", flat: "fb-flat" };
function showFeedback(r) {
  if (r.unscored) return;
  const detail = r.detail;
  let sub = "";
  if (!r.missed) {
    sub = "+" + Math.round(r.points.total);
    if (detail === "tempo")                    sub += ` · ${Math.round(Math.abs(r.errS) * 1000)} ms ${r.errS > 0 ? "late" : "early"}`;
    if (detail === "sharp" || detail === "flat") sub += ` · ${Math.round(Math.abs(r.cents))}¢ ${detail}`;
  }
  noteFeedback.className = FEEDBACK_CLASS[detail] ?? "fb-silent";
  noteFeedback.innerHTML = r.label + (sub ? `<small>${sub}</small>` : "");
  void noteFeedback.offsetWidth;   // restart the animation if one is still running
  noteFeedback.classList.add("show");
}

//Called every frame of a Points run, after songPos has advanced. Returns
//true when the run has just finished.
function pointsTick(bpm) {
  if (songPos < 0) {
    const n = String(Math.ceil(-songPos));
    if (countInEl.textContent !== n) countInEl.textContent = n;
    countInEl.hidden = false;
  } else {
    countInEl.hidden = true;
  }

  const judged = scorer.update(songPos, songRate(bpm), micBlockSec);
  if (judged.length) {
    showFeedback(judged[judged.length - 1]);
    updateHud();
  }

  if (scorer.done && songPos >= SONG_DURATION) {
    endPointsRun(bpm);
    return true;
  }
  return false;
}

function endPointsRun(bpm) {
  playing = false;
  cancelAnimationFrame(animFrame);
  playBtn.innerHTML = ICON_PLAY;
  countInEl.hidden = true;
  scorer.finish(songRate(bpm));
  updateHud();
  showResults(scorer.summary());
}

//Fill in the results screen. `animate` grows the bars from empty (first
//showing); off, they just move to the new values (re-scoring after a
//mic-delay change).
function showResults(s, animate = true) {
  document.getElementById("resPiece").textContent = pieceTitle.textContent;
  document.getElementById("resScore").textContent = s.points.toLocaleString();
  document.getElementById("resOf").textContent    = s.judged ? `of ${s.maxPoints.toLocaleString()} points` : "";
  document.getElementById("resGrade").textContent =
    gradeFor(s.percent) + (s.percent === null ? "" : ` · ${Math.round(s.percent * 100)}%`);
  document.getElementById("calVal").textContent   = micDelayMs + " ms";

  const bars = [["Tempo", s.tempo], ["Note", s.note], ["Tune", s.intonation]];
  const setBars = () => bars.forEach(([k, v]) => {
    document.getElementById("res" + k + "Bar").style.width = Math.round((v || 0) * 100) + "%";
  });
  bars.forEach(([k, v]) => {
    document.getElementById("res" + k).textContent = pctText(v);
    if (animate) document.getElementById("res" + k + "Bar").style.width = "0%";
  });

  document.getElementById("resStats").textContent = s.judged
    ? `${s.hit} of ${s.judged} notes played · best streak ${s.bestStreak}` : "";

  //One line of advice: nothing heard, else which way the timing leaned,
  //else the weakest area
  let hint = "";
  if (!s.judged) {
    hint = "No notes were scored — check that a microphone is connected.";
  } else if (!s.hit) {
    hint = "None of your notes matched — check the microphone, or that you're playing the notes shown.";
  } else if (s.meanErrS !== null && Math.abs(s.meanErrS) >= 0.08) {
    hint = `You tended to ${s.meanErrS > 0 ? "play behind the beat" : "rush"} — about ${Math.round(Math.abs(s.meanErrS) * 1000)} ms on average.`;
  } else {
    const weakest = bars.reduce((a, b) => b[1] < a[1] ? b : a);
    if (weakest[1] < 0.75) hint = `Your weakest area was ${{ Tempo: "tempo", Note: "hitting the right notes", Tune: "intonation" }[weakest[0]]}.`;
  }
  document.getElementById("resHint").textContent = hint;

  resultsEl.hidden = false;
  if (animate) {
    requestAnimationFrame(() => requestAnimationFrame(setBars));   // let the 0% paint first so the bars grow
  } else {
    setBars();
  }
}

//Nudge the mic-delay allowance and re-judge the finished run with it. More
//allowance takes the audio to have happened earlier, so the player reads
//earlier — the fix for "reads late even when I was on the beat".
const MIC_DELAY_STEP_MS = 20, MIC_DELAY_MIN_MS = -200, MIC_DELAY_MAX_MS = 600;
function adjustMicDelay(deltaMs) {
  const next = Math.max(MIC_DELAY_MIN_MS, Math.min(MIC_DELAY_MAX_MS, micDelayMs + deltaMs));
  const applied = next - micDelayMs;
  if (!applied || !scorer) return;
  micDelayMs = next;
  saveMicDelay();
  const bpm = parseInt(tempoSlider.value, 10);
  scorer.shiftAndRejudge(-applied / 1000 * songRate(bpm), songRate(bpm));
  updateHud();
  showResults(scorer.summary(), false);
}
document.getElementById("calMinus").addEventListener("click", () => adjustMicDelay(-MIC_DELAY_STEP_MS));
document.getElementById("calPlus").addEventListener("click", () => adjustMicDelay(MIC_DELAY_STEP_MS));

document.getElementById("resAgain").addEventListener("click", () => {
  preparePointsRun();
  playing = true;
  playBtn.innerHTML = ICON_PAUSE;
  lastTs = null;
  animFrame = requestAnimationFrame(loop);
});

document.getElementById("resMenu").addEventListener("click", () => {
  resultsEl.hidden = true;
  document.getElementById("backBtn").click();
});

// ── Animation loop ────────────────────────────────────────────────────────────
function loop(ts) {
  if (!lastTs) lastTs = ts;
  const dt = Math.min((ts - lastTs) / 1000, 0.05);
  lastTs = ts;

  const bpm = parseInt(tempoSlider.value, 10);
  time += dt;

  if (mode === "play-along" || mode === "points") {
    songPos += dt * songRate(bpm);
    //Play Along loops forever; a Points run ends once the last note is judged
    if (mode === "play-along" && songPos >= SONG_DURATION) songPos = 0;
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

  //Points: score what's been heard, and stop the loop if that was the end
  let runEnded = false;
  if (mode === "points") {
    recordPos(ts);
    runEnded = pointsTick(bpm);
  }

  const ev = getCurrentEvent(songPos);
  movementDisplay.textContent = ev.name || "";

  //Points counts beats off the song itself, so the pulse agrees with the
  //notes (and the count-in); the other modes keep the metronome's own clock
  const beat = mode === "points"
    ? ((Math.floor(songPos) % 4) + 4) % 4 + 1
    : (Math.floor(time * bpm / 60) % 4) + 1;
  beatDisplay.textContent = "♩ " + beat;

  timelineFill.style.width = (Math.max(0, songPos / SONG_DURATION) * 100).toFixed(1) + "%";

  drawFrame();
  if (!runEnded) animFrame = requestAnimationFrame(loop);
}

// ── Controls ─────────────────────────────────────────────────────────────────
playBtn.addEventListener("click", () => {
  playing = !playing;
  if (playing) {
    playBtn.innerHTML = '<i class="ti ti-player-pause" aria-hidden="true"></i>';
    //Frame history from before a pause can't place readings taken after it
    if (mode === "points") posHistory = [];
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
  if (mode === "points") return;   // seeking would make a scored run meaningless
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
    const sentAt = performance.now();
    const res  = await fetch("/api/live-note");
    const data = await res.json();
    const respondedAt = (sentAt + performance.now()) / 2;   // the server answered somewhere mid-flight
    liveNote = data.note;   // keep globals in sync
    liveFreq = data.freq || 0;
    if (mode === "points" && playing) takeMicReading(data, respondedAt);

    //Catch a device dropping out mid-session (unplugged, Bluetooth drops) —
    //cheap to check every poll, only touches the DOM when it actually flips.
    if (data.mic !== lastMicActive) {
      lastMicActive = data.mic;
      if (!data.mic) loadAudioDevices();   // also refreshes which device the dropdown shows as failed
    }

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
  applyModeUi();

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
loadAudioDevices();
