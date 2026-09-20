import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { RotateCcw, Move, Lock, Unlock, Sparkles } from "lucide-react";

const CONFIGS = {
  stereo: {
    label: "Стерео 2.0",
    channels: [
      { id: "L", label: "Левый фронт", angle: -30, type: "main", mirror: "R" },
      { id: "R", label: "Правый фронт", angle: 30, type: "main", mirror: "L" },
    ],
  },
  "5.1": {
    label: "5.1",
    channels: [
      { id: "L", label: "Левый фронт", angle: -30, type: "main", mirror: "R" },
      { id: "C", label: "Центр", angle: 0, type: "center" },
      { id: "R", label: "Правый фронт", angle: 30, type: "main", mirror: "L" },
      { id: "LS", label: "Левый тыл", angle: -110, type: "surround", mirror: "RS" },
      { id: "RS", label: "Правый тыл", angle: 110, type: "surround", mirror: "LS" },
      { id: "SW", label: "Сабвуфер", type: "sub" },
    ],
  },
  "7.1": {
    label: "7.1",
    channels: [
      { id: "L", label: "Левый фронт", angle: -30, type: "main", mirror: "R" },
      { id: "C", label: "Центр", angle: 0, type: "center" },
      { id: "R", label: "Правый фронт", angle: 30, type: "main", mirror: "L" },
      { id: "LS", label: "Левый боковой", angle: -90, type: "surround", mirror: "RS" },
      { id: "RS", label: "Правый боковой", angle: 90, type: "surround", mirror: "LS" },
      { id: "LB", label: "Левый задний", angle: -135, type: "rear", mirror: "RB" },
      { id: "RB", label: "Правый задний", angle: 135, type: "rear", mirror: "LB" },
      { id: "SW", label: "Сабвуфер", type: "sub" },
    ],
  },
  atmos: {
    label: "Dolby Atmos 5.1.2",
    channels: [
      { id: "L", label: "Левый фронт", angle: -30, type: "main", mirror: "R" },
      { id: "C", label: "Центр", angle: 0, type: "center" },
      { id: "R", label: "Правый фронт", angle: 30, type: "main", mirror: "L" },
      { id: "LS", label: "Левый тыл", angle: -110, type: "surround", mirror: "RS" },
      { id: "RS", label: "Правый тыл", angle: 110, type: "surround", mirror: "LS" },
      { id: "HL", label: "Высотный левый", angle: -45, type: "height", mirror: "HR" },
      { id: "HR", label: "Высотный правый", angle: 45, type: "height", mirror: "HL" },
      { id: "SW", label: "Сабвуфер", type: "sub" },
    ],
  },
};

const TYPE_STYLE = {
  main: { color: "#E8A33D", note: "Высота: на уровне ушей сидя, ≈100–120 см" },
  center: { color: "#F2C572", note: "Высота: вровень с L/R, не перекрыт экраном" },
  surround: { color: "#4FD1C5", note: "Высота: на 60–90 см выше уровня ушей" },
  rear: { color: "#3AA7A0", note: "Высота: на уровне ушей или немного выше" },
  height: { color: "#B39DDB", note: "На потолке, направлен вниз к месту прослушивания" },
  sub: { color: "#E76F51", note: "Высота не критична — у стены или в углу" },
};

const CANVAS = 540;
const PAD = 56;
const WEIGHTS = { geometry: 0.25, coverage: 0.25, spl: 0.2, distance: 0.2, symmetry: 0.1 };

const DIRECTIVITY = { main: 70, center: 80, surround: 100, rear: 100, height: 90 };
const BEAM_LENGTH = 220;

// --- v1.4.0 experiment: "can a smartphone hear the room?" -------------
// Octave-ish bands for a crude live/averaged spectrum from the phone mic.
// Bands below ~200 Hz are flagged unreliable: phone mic capsules/ports
// typically roll off badly there, independent of software.
const MIC_BANDS = [
  { freq: 63, label: "63", reliable: false },
  { freq: 125, label: "125", reliable: false },
  { freq: 250, label: "250", reliable: true },
  { freq: 500, label: "500", reliable: true },
  { freq: 1000, label: "1k", reliable: true },
  { freq: 2000, label: "2k", reliable: true },
  { freq: 4000, label: "4k", reliable: true },
  { freq: 8000, label: "8k", reliable: true },
];
const MIC_SNAPSHOT_MS = 3000;
const MIC_SAMPLE_MS = 120;

function beamWidthFor(type) { return DIRECTIVITY[type] || 90; }

function beamEnd(point, headingDeg, distance = BEAM_LENGTH) {
  const rad = (headingDeg * Math.PI) / 180;
  return { x: point.x + distance * Math.sin(rad), y: point.y - distance * Math.cos(rad) };
}

function conePoints(point, headingDeg, widthDeg, distance = BEAM_LENGTH, segments = 10) {
  const start = headingDeg - widthDeg / 2;
  const end = headingDeg + widthDeg / 2;
  const pts = [point];
  for (let i = 0; i <= segments; i++) {
    pts.push(beamEnd(point, start + ((end - start) * i) / segments, distance));
  }
  return pts;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function computeBase(roomW, roomL, listen, radius, subSide, channels) {
  const pts = {};
  channels.forEach((ch) => {
    if (ch.type === "sub") {
      const x = subSide === "left" ? roomW * 0.22 : roomW * 0.78;
      const y = roomL * 0.06;
      pts[ch.id] = { x: clamp(x, 20, roomW - 20), y: clamp(y, 15, roomL - 15) };
      return;
    }
    const rad = (ch.angle * Math.PI) / 180;
    const x = listen.x + radius * Math.sin(rad);
    const y = listen.y - radius * Math.cos(rad);
    pts[ch.id] = { x: clamp(x, 10, roomW - 10), y: clamp(y, 10, roomL - 10) };
  });
  return pts;
}

function volumePower(roomW, roomL, roomH) {
  const volume = (roomW / 100) * (roomL / 100) * (roomH / 100);
  const main = clamp(Math.round((volume * 11) / 5) * 5, 30, 150);
  const sub = clamp(Math.round((volume * 22) / 5) * 5, 60, 400);
  return { volume, main, sub };
}

function angleFrom(point, target) {
  const dx = target.x - point.x;
  const dy = point.y - target.y;
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

function angleDiffDeg(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

// --- Scoring ---------------------------------------------------------

function pointInsideBeam(speaker, target, headingDeg, widthDeg) {
  return angleDiffDeg(angleFrom(speaker, target), headingDeg) <= widthDeg / 2;
}

function computeScores(config, positions, orientations, listenPoints, roomW, roomL) {
  const center = listenPoints[1];
  const soundChannels = config.channels.filter((c) => c.type !== "sub");
  const idealRadius = clamp(Math.min(roomW, roomL) * 0.35, 120, 300);

  let geoTotal = 0;
  soundChannels.forEach((ch) => {
    const actual = angleFrom(center, positions[ch.id]);
    const posDiff = angleDiffDeg(actual, ch.angle);
    const posScore = clamp(100 - posDiff * 2.2, 0, 100);
    const autoAim = angleFrom(positions[ch.id], center);
    const actualAim = orientations[ch.id] !== undefined ? orientations[ch.id] : autoAim;
    const aimDiff = angleDiffDeg(actualAim, autoAim);
    const aimScore = clamp(100 - aimDiff * 2.5, 0, 100);
    geoTotal += posScore * 0.6 + aimScore * 0.4;
  });
  const geometry = soundChannels.length ? geoTotal / soundChannels.length : 100;

  const dists = soundChannels.map((ch) => {
    const p = positions[ch.id];
    return Math.hypot(p.x - center.x, p.y - center.y);
  });
  const meanD = dists.reduce((a, b) => a + b, 0) / (dists.length || 1);
  const variance = dists.reduce((a, d) => a + (d - meanD) ** 2, 0) / (dists.length || 1);
  const cv = meanD ? Math.sqrt(variance) / meanD : 0;
  const distance = clamp(100 - cv * 260, 0, 100);

  // SPL Proxy: distance-based approximation, NOT a physical SPL calculation.
  let splTotal = 0;
  soundChannels.forEach((ch) => {
    const p = positions[ch.id];
    const d = Math.hypot(p.x - center.x, p.y - center.y);
    const penalty = (Math.abs(d - idealRadius) / idealRadius) * 100;
    splTotal += clamp(100 - penalty * 1.3, 0, 100);
  });
  const spl = soundChannels.length ? splTotal / soundChannels.length : 100;

  let covTotal = 0;
  soundChannels.forEach((ch) => {
    const speaker = positions[ch.id];
    const heading = orientations[ch.id] !== undefined ? orientations[ch.id] : angleFrom(speaker, center);
    const width = beamWidthFor(ch.type);
    const inside = listenPoints.map((p) => pointInsideBeam(speaker, p, heading, width));
    covTotal += (inside.filter(Boolean).length / listenPoints.length) * 100;
  });
  const coverage = soundChannels.length ? covTotal / soundChannels.length : 100;

  const pairsSeen = new Set();
  let symTotal = 0, symCount = 0;
  soundChannels.forEach((ch) => {
    if (!ch.mirror || pairsSeen.has(ch.id)) return;
    const other = soundChannels.find((c) => c.id === ch.mirror);
    if (!other) return;
    pairsSeen.add(ch.id); pairsSeen.add(other.id);
    const pA = positions[ch.id], pB = positions[other.id];
    const dA = Math.hypot(pA.x - center.x, pA.y - center.y);
    const dB = Math.hypot(pB.x - center.x, pB.y - center.y);
    const angA = Math.abs(angleFrom(center, pA));
    const angB = Math.abs(angleFrom(center, pB));
    const dev = Math.abs(dA - dB) / 2 + Math.abs(angA - angB) * 3;
    symTotal += clamp(100 - dev, 0, 100);
    symCount++;
  });
  const symmetry = symCount ? symTotal / symCount : 100;

  const total = geometry * WEIGHTS.geometry + coverage * WEIGHTS.coverage + spl * WEIGHTS.spl + distance * WEIGHTS.distance + symmetry * WEIGHTS.symmetry;
  return { total: Math.round(total), geometry: Math.round(geometry), coverage: Math.round(coverage), spl: Math.round(spl), distance: Math.round(distance), symmetry: Math.round(symmetry) };
}

// --- Optimizer: local stochastic search over unlocked channels -------

function optimizePositions(config, basePositions, currentOverrides, locked, orientations, listen, listenPoints, roomW, roomL) {
  const soundChannels = config.channels.filter((c) => c.type !== "sub" && !locked[c.id]);
  let positions = {};
  config.channels.forEach((ch) => {
    positions[ch.id] = currentOverrides[ch.id] || basePositions[ch.id];
  });
  if (soundChannels.length === 0) return positions;

  let bestScore = computeScores(config, positions, orientations, listenPoints, roomW, roomL).total;
  let current = { ...positions };

  for (let iter = 0; iter < 260; iter++) {
    const ch = soundChannels[Math.floor(Math.random() * soundChannels.length)];
    const p = current[ch.id];
    const curAngle = angleFrom(listen, p);
    const curRadius = Math.hypot(p.x - listen.x, p.y - listen.y);
    const newAngle = curAngle + (Math.random() * 16 - 8);
    const newRadius = clamp(curRadius + (Math.random() * 40 - 20), 70, Math.min(roomW, roomL) * 0.65);
    const rad = (newAngle * Math.PI) / 180;
    const candidate = {
      x: clamp(listen.x + newRadius * Math.sin(rad), 10, roomW - 10),
      y: clamp(listen.y - newRadius * Math.cos(rad), 10, roomL - 10),
    };
    const trial = { ...current, [ch.id]: candidate };
    const trialScore = computeScores(config, trial, orientations, listenPoints, roomW, roomL).total;
    if (trialScore >= bestScore) {
      bestScore = trialScore;
      current = trial;
    }
  }
  return current;
}

// --- Pseudo-3D projection (oblique/perspective trick, plain SVG, no WebGL) --

const VIEW3D = { width: 540, height: 540, frontY: 72, backY: 462, frontW: 310, backW: 500 };

function project3D(point, z, roomW, roomL) {
  const t = clamp(point.y / Math.max(roomL, 1), 0, 1);
  const halfW = (VIEW3D.frontW + (VIEW3D.backW - VIEW3D.frontW) * t) / 2;
  const x = VIEW3D.width / 2 + ((point.x - roomW / 2) / Math.max(roomW, 1)) * halfW * 2;
  const y = VIEW3D.frontY + t * (VIEW3D.backY - VIEW3D.frontY) - z * (0.34 - 0.08 * t);
  return { x, y };
}
function floorPoint(point, roomW, roomL) { return project3D(point, 0, roomW, roomL); }
function heightForType(type, roomH) {
  if (type === "height") return Math.max(220, roomH - 20);
  if (type === "sub") return 35;
  if (type === "surround" || type === "rear") return 165;
  return 110;
}
function beam3DPoints(point, heading, width, length, z, roomW, roomL, spread = 1) {
  const half = width / 2;
  const left = beamEnd(point, heading - half * spread, length);
  const right = beamEnd(point, heading + half * spread, length);
  return [project3D(point, z, roomW, roomL), project3D(left, z, roomW, roomL), project3D(right, z, roomW, roomL)];
}
function speakerBox3D(point, heading, z, roomW, roomL) {
  const rad = (heading * Math.PI) / 180;
  const f = { x: Math.sin(rad), y: Math.cos(rad) };
  const side = { x: Math.cos(rad), y: -Math.sin(rad) };
  const w = 22, d = 15, h = 34;
  const corners = [
    { x: point.x + side.x * w / 2 + f.x * d / 2, y: point.y + side.y * w / 2 + f.y * d / 2 },
    { x: point.x - side.x * w / 2 + f.x * d / 2, y: point.y - side.y * w / 2 + f.y * d / 2 },
    { x: point.x - side.x * w / 2 - f.x * d / 2, y: point.y - side.y * w / 2 - f.y * d / 2 },
    { x: point.x + side.x * w / 2 - f.x * d / 2, y: point.y + side.y * w / 2 - f.y * d / 2 },
  ];
  return { bottom: corners.map(c => project3D(c, z, roomW, roomL)), top: corners.map(c => project3D(c, z + h, roomW, roomL)) };
}

// --- Component ---------------------------------------------------------

export default function HomeTheaterPlanner() {
  const [roomWInput, setRoomWInput] = useState("420");
  const [roomLInput, setRoomLInput] = useState("560");
  const [roomHInput, setRoomHInput] = useState("270");
  const roomW = Number(roomWInput) || 0;
  const roomL = Number(roomLInput) || 0;
  const roomH = Number(roomHInput) || 0;
  const validRoom = roomW >= 200 && roomL >= 200 && roomH >= 200;

  const [configKey, setConfigKey] = useState("5.1");
  const [subSide, setSubSide] = useState("left");
  const [listen, setListen] = useState({ x: 210, y: 336 });
  const [radius, setRadius] = useState(180);
  const [sofaWidth, setSofaWidth] = useState(160);
  const [overrides, setOverrides] = useState({});
  const [locked, setLocked] = useState({});
  const [dragging, setDragging] = useState(null);
  const [optimizing, setOptimizing] = useState(false);
  const [orientations, setOrientations] = useState({});
  const [viewMode, setViewMode] = useState("3d");

  // --- v1.4.0 mic experiment state ---
  const [micStatus, setMicStatus] = useState("idle"); // idle | requesting | active | denied | error
  const [micError, setMicError] = useState(null);
  const [liveLevels, setLiveLevels] = useState(() => MIC_BANDS.map(() => 0));
  const [snapshot, setSnapshot] = useState(null); // { levels: number[], time: number }
  const [prevSnapshot, setPrevSnapshot] = useState(null);
  const [capturing, setCapturing] = useState(false);
  const [captureProgress, setCaptureProgress] = useState(0);

  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const streamRef = useRef(null);
  const sampleIntervalRef = useRef(null);
  const captureBufferRef = useRef([]);
  const captureTimeoutRef = useRef(null);
  const captureStartRef = useRef(0);

  const svgRef = useRef(null);

  const config = CONFIGS[configKey];

  useEffect(() => {
    setOverrides({});
    setLocked({});
    setOrientations({});
    setListen((prev) => ({
      x: clamp(prev.x, 20, roomW - 20),
      y: clamp(prev.y, 20, roomL - 20),
    }));
  }, [configKey]);

  useEffect(() => {
    if (roomW < 200 || roomL < 200) return;
    setListen({
      x: clamp(roomW / 2, 20, roomW - 20),
      y: clamp(roomL * 0.6, 20, roomL - 20),
    });
    setRadius(clamp(Math.min(roomW, roomL) * 0.42, 90, 320));
    setOverrides({});
    setLocked({});
    setOrientations({});
  }, [roomW, roomL]);

  const basePositions = useMemo(
    () => computeBase(roomW, roomL, listen, radius, subSide, config.channels),
    [roomW, roomL, listen, radius, subSide, config]
  );

  const positions = useMemo(() => {
    const merged = {};
    config.channels.forEach((ch) => {
      merged[ch.id] = overrides[ch.id] || basePositions[ch.id];
    });
    return merged;
  }, [config, basePositions, overrides]);

  const halfSofa = sofaWidth / 2;
  const listenPoints = useMemo(() => {
    return [
      { x: clamp(listen.x - halfSofa, 5, roomW - 5), y: listen.y },
      listen,
      { x: clamp(listen.x + halfSofa, 5, roomW - 5), y: listen.y },
    ];
  }, [listen, halfSofa, roomW]);

  const scores = useMemo(
    () => (validRoom ? computeScores(config, positions, orientations, listenPoints, roomW, roomL) : null),
    [config, positions, orientations, listenPoints, roomW, roomL, validRoom]
  );

  const scale = useMemo(
    () => (validRoom ? Math.min((CANVAS - PAD * 2) / roomW, (CANVAS - PAD * 2) / roomL) : 0.5),
    [roomW, roomL, validRoom]
  );
  const offX = (CANVAS - roomW * scale) / 2;
  const offY = (CANVAS - roomL * scale) / 2;
  const toPx = useCallback((p) => ({ x: offX + p.x * scale, y: offY + p.y * scale }), [offX, offY, scale]);
  const toRoom = useCallback(
    (px, py) => ({ x: clamp((px - offX) / scale, 5, roomW - 5), y: clamp((py - offY) / scale, 5, roomL - 5) }),
    [offX, offY, scale, roomW, roomL]
  );

  // Dragging only makes sense in 2D: the 3D view is a nonlinear (perspective)
  // projection, and inverting it correctly for every element's own height
  // is non-trivial. Rather than ship an approximate/incorrect inverse,
  // 3D is view-only for now — edit positions in the 2D plan.
  const startDrag = (id) => (e) => {
    if (viewMode !== "2d") return;
    e.preventDefault();
    setDragging(id);
  };

  useEffect(() => {
    if (!dragging) return;
    const move = (e) => {
      const rect = svgRef.current.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const px = ((clientX - rect.left) / rect.width) * CANVAS;
      const py = ((clientY - rect.top) / rect.height) * CANVAS;
      const room = toRoom(px, py);
      if (dragging === "LISTEN") setListen(room);
      else setOverrides((prev) => ({ ...prev, [dragging]: room }));
    };
    const up = () => setDragging(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", up);
    };
  }, [dragging, toRoom]);

  const getOrientation = (ch) => {
    if (ch.type === "sub") return null;
    if (orientations[ch.id] !== undefined) return orientations[ch.id];
    return angleFrom(positions[ch.id], listen);
  };

  const rotateSpeaker = (id, delta) => {
    const ch = config.channels.find((c) => c.id === id);
    if (!ch || ch.type === "sub") return;
    const current = getOrientation(ch);
    setOrientations((prev) => ({ ...prev, [id]: ((current + delta + 540) % 360) - 180 }));
  };

  const resetSpeakerOrientation = (id) => {
    setOrientations((prev) => { const next = { ...prev }; delete next[id]; return next; });
  };

  const angleInfo = (ch) => {
    if (ch.type === "sub" || ch.angle === undefined) return null;
    const p = positions[ch.id];
    const actual = angleFrom(listen, p);
    const diff = angleDiffDeg(actual, ch.angle);
    const dist = Math.hypot(p.x - listen.x, p.y - listen.y);
    return { actual: Math.round(actual), diff: Math.round(diff), dist: Math.round(dist) };
  };

  const power = volumePower(roomW, roomL, roomH);

  const resetAll = () => {
    setOverrides({});
    setLocked({});
    setOrientations({});
    setListen({ x: roomW / 2, y: roomL * 0.6 });
    setRadius(clamp(Math.min(roomW, roomL) * 0.42, 90, 320));
  };

  const toggleLock = (id) => setLocked((prev) => ({ ...prev, [id]: !prev[id] }));

  const runOptimize = () => {
    setOptimizing(true);
    setTimeout(() => {
      const result = optimizePositions(config, basePositions, overrides, locked, orientations, listen, listenPoints, roomW, roomL);
      const newOverrides = {};
      config.channels.forEach((ch) => {
        if (ch.type === "sub") { if (overrides[ch.id]) newOverrides[ch.id] = overrides[ch.id]; return; }
        newOverrides[ch.id] = result[ch.id];
      });
      setOverrides(newOverrides);
      setOptimizing(false);
    }, 260);
  };

  // --- v1.4.0 mic experiment: capture + band levels ---
  const readBandLevels = useCallback(() => {
    const analyser = analyserRef.current;
    const audioCtx = audioCtxRef.current;
    if (!analyser || !audioCtx) return MIC_BANDS.map(() => 0);
    const bins = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(bins);
    const hzPerBin = audioCtx.sampleRate / analyser.fftSize;
    return MIC_BANDS.map((band) => {
      const lo = Math.max(0, Math.floor((band.freq / Math.SQRT2) / hzPerBin));
      const hi = Math.min(bins.length - 1, Math.ceil((band.freq * Math.SQRT2) / hzPerBin));
      let sum = 0, count = 0;
      for (let i = lo; i <= hi; i++) { sum += bins[i]; count++; }
      const avgByte = count ? sum / count : 0;
      // rough dB-like value, clamped; not a calibrated measurement
      const db = 20 * Math.log10(avgByte / 255 + 0.001);
      return clamp(db, -60, 0);
    });
  }, []);

  const stopMic = useCallback(() => {
    if (sampleIntervalRef.current) { clearInterval(sampleIntervalRef.current); sampleIntervalRef.current = null; }
    if (captureTimeoutRef.current) { clearTimeout(captureTimeoutRef.current); captureTimeoutRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.close().catch(() => {}); audioCtxRef.current = null; }
    analyserRef.current = null;
    setCapturing(false);
    setCaptureProgress(0);
    setMicStatus("idle");
  }, []);

  useEffect(() => stopMic, [stopMic]); // stop mic on unmount

  const startMic = async () => {
    setMicError(null);
    setMicStatus("requesting");
    const attempts = [
      { audio: { echoCancellation: { ideal: false }, noiseSuppression: { ideal: false }, autoGainControl: { ideal: false } } },
      { audio: true },
    ];
    let stream = null;
    let lastErr = null;
    for (const constraints of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (err) {
        lastErr = err;
        if (err && err.name === "NotAllowedError") break; // denied — no point retrying
      }
    }
    if (!stream) {
      setMicStatus(lastErr && lastErr.name === "NotAllowedError" ? "denied" : "error");
      setMicError(lastErr ? `${lastErr.name}: ${lastErr.message}` : "Не удалось получить доступ к микрофону");
      return;
    }
    try {
      streamRef.current = stream;
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioCtx();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      audioCtxRef.current = audioCtx;
      analyserRef.current = analyser;
      setMicStatus("active");
      sampleIntervalRef.current = setInterval(() => {
        const levels = readBandLevels();
        setLiveLevels(levels);
      }, MIC_SAMPLE_MS);
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      setMicStatus("error");
      setMicError(err ? `${err.name}: ${err.message}` : "Не удалось запустить обработку звука");
    }
  };

  const takeSnapshot = () => {
    if (micStatus !== "active" || capturing) return;
    captureBufferRef.current = [];
    captureStartRef.current = Date.now();
    setCapturing(true);
    setCaptureProgress(0);
    const tick = () => {
      captureBufferRef.current.push(readBandLevels());
      const elapsed = Date.now() - captureStartRef.current;
      setCaptureProgress(clamp(elapsed / MIC_SNAPSHOT_MS, 0, 1));
      if (elapsed < MIC_SNAPSHOT_MS) {
        captureTimeoutRef.current = setTimeout(tick, MIC_SAMPLE_MS);
      } else {
        const samples = captureBufferRef.current;
        const avgLevels = MIC_BANDS.map((_, i) => {
          const vals = samples.map((s) => s[i]);
          return vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
        });
        setSnapshot((prev) => {
          if (prev) setPrevSnapshot(prev);
          return { levels: avgLevels, time: Date.now() };
        });
        setCapturing(false);
        setCaptureProgress(0);
      }
    };
    tick();
  };

  const scoreCards = scores
    ? [
        { key: "geometry", label: "Geometry", weight: 25, value: scores.geometry },
        { key: "coverage", label: "Coverage", weight: 25, value: scores.coverage },
        { key: "spl", label: "SPL Proxy", weight: 20, value: scores.spl },
        { key: "distance", label: "Distance", weight: 20, value: scores.distance },
        { key: "symmetry", label: "Symmetry", weight: 10, value: scores.symmetry },
      ]
    : [];

  const scoreColor = (v) => (v >= 85 ? "#4FD1C5" : v >= 65 ? "#E8A33D" : "#E76F51");

  return (
    <div className="htp-root">
      <style>{`
        .htp-root { background: #0B1B2B; color: #E7EEF3; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; min-height: 100%; padding: 28px; box-sizing: border-box; }
        .htp-title { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 2px 0; }
        .htp-sub { color: #7F93A8; font-size: 13px; margin: 0 0 6px 0; }
        .htp-caveat { color: #5C7086; font-size: 12px; margin: 0 0 22px 0; border-left: 2px solid #24435F; padding-left: 10px; line-height: 1.5; max-width: 640px; }
        .htp-layout { display: flex; gap: 24px; flex-wrap: wrap; align-items: flex-start; }
        .htp-panel { width: 300px; flex-shrink: 0; background: #12283D; border: 1px solid #1E3A52; border-radius: 10px; padding: 18px; }
        .htp-field { margin-bottom: 16px; }
        .htp-field label { display: block; font-size: 12px; color: #93A5B8; margin-bottom: 6px; }
        .htp-row { display: flex; gap: 10px; }
        .htp-row .htp-field { flex: 1; }
        .htp-input, .htp-select { width: 100%; background: #0B1B2B; border: 1px solid #24435F; color: #E7EEF3; border-radius: 6px; padding: 8px 10px; font-size: 14px; box-sizing: border-box; font-family: inherit; }
        .htp-input:focus, .htp-select:focus { outline: 2px solid #E8A33D; border-color: #E8A33D; }
        .htp-unit { color: #5C7086; font-size: 11px; margin-left: 4px; }
        .htp-toggle { display: flex; gap: 8px; }
        .htp-toggle button { flex: 1; background: #0B1B2B; border: 1px solid #24435F; color: #93A5B8; border-radius: 6px; padding: 7px 0; font-size: 13px; cursor: pointer; }
        .htp-toggle button.active { border-color: #E8A33D; color: #E8A33D; }
        .htp-reset { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; background: transparent; border: 1px solid #24435F; color: #93A5B8; border-radius: 6px; padding: 9px 0; font-size: 13px; cursor: pointer; margin-top: 4px; }
        .htp-reset:hover { border-color: #E8A33D; color: #E8A33D; }
        .htp-optimize { display: flex; align-items: center; justify-content: center; gap: 7px; width: 100%; background: #E8A33D; border: none; color: #0B1B2B; border-radius: 6px; padding: 11px 0; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 14px; }
        .htp-optimize:hover { background: #F2B658; }
        .htp-optimize:disabled { opacity: 0.6; cursor: default; }
        .htp-canvas-wrap { flex: 1; min-width: 320px; }
        .htp-canvas-box { background: #0E2136; border: 1px solid #1E3A52; border-radius: 10px; padding: 10px; }
        .htp-hint { display: flex; align-items: center; gap: 6px; color: #5C7086; font-size: 12px; margin: 10px 2px 2px 2px; }
        .htp-scores { display: flex; gap: 12px; flex-wrap: wrap; margin: 20px 0 4px 0; }
        .htp-score-total { background: #12283D; border: 1px solid #1E3A52; border-radius: 10px; padding: 16px 22px; min-width: 170px; }
        .htp-score-total .lbl { font-size: 12px; color: #93A5B8; margin-bottom: 4px; }
        .htp-score-total .val { font-size: 30px; font-weight: 700; }
        .htp-score-mini { background: #0E2136; border: 1px solid #1E3A52; border-radius: 10px; padding: 12px 16px; min-width: 100px; }
        .htp-score-mini .lbl { font-size: 11px; color: #7F93A8; display: flex; justify-content: space-between; }
        .htp-score-mini .val { font-size: 20px; font-weight: 600; margin-top: 4px; }
        .htp-table { width: 100%; border-collapse: collapse; margin-top: 18px; font-size: 13px; }
        .htp-table th { text-align: left; color: #7F93A8; font-weight: 500; font-size: 11px; padding: 6px 8px; border-bottom: 1px solid #1E3A52; }
        .htp-table td { padding: 8px 8px; border-bottom: 1px solid #16293C; vertical-align: middle; }
        .htp-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; margin-right: 7px; }
        .htp-power { display: flex; gap: 14px; margin-top: 18px; flex-wrap: wrap; }
        .htp-power-card { background: #12283D; border: 1px solid #1E3A52; border-radius: 10px; padding: 14px 18px; flex: 1; min-width: 150px; }
        .htp-power-card .num { font-size: 24px; font-weight: 600; color: #E8A33D; }
        .htp-power-card .cap { font-size: 12px; color: #93A5B8; margin-top: 2px; }
        .htp-note { color: #5C7086; font-size: 12px; margin-top: 12px; line-height: 1.5; }
        .htp-mic { margin-top: 32px; border-top: 1px solid #1E3A52; padding-top: 24px; }
        .htp-mic-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }
        .htp-mic-head h2 { font-size: 17px; margin: 0; font-weight: 600; }
        .htp-mic-badge { font-size: 11px; color: #E8A33D; border: 1px solid #E8A33D; border-radius: 10px; padding: 1px 8px; }
        .htp-mic-sub { color: #7F93A8; font-size: 13px; margin: 4px 0 14px 0; }
        .htp-mic-disclaimer { background: #12283D; border: 1px solid #24435F; border-radius: 8px; padding: 12px 14px; font-size: 12px; color: #93A5B8; line-height: 1.6; margin-bottom: 16px; }
        .htp-mic-controls { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 18px; }
        .htp-mic-btn { display: inline-flex; align-items: center; gap: 7px; background: #E8A33D; border: none; color: #0B1B2B; border-radius: 6px; padding: 10px 16px; font-size: 13px; font-weight: 600; cursor: pointer; }
        .htp-mic-btn:hover { background: #F2B658; }
        .htp-mic-btn:disabled { opacity: 0.55; cursor: default; }
        .htp-mic-btn.ghost { background: transparent; border: 1px solid #24435F; color: #93A5B8; }
        .htp-mic-btn.ghost:hover { border-color: #E8A33D; color: #E8A33D; }
        .htp-mic-status { font-size: 12px; color: #7F93A8; }
        .htp-mic-bars { display: flex; gap: 8px; align-items: flex-end; height: 120px; background: #0E2136; border: 1px solid #1E3A52; border-radius: 10px; padding: 14px; margin-bottom: 8px; }
        .htp-mic-bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; gap: 6px; }
        .htp-mic-bar-track { width: 100%; max-width: 26px; height: 100%; display: flex; align-items: flex-end; }
        .htp-mic-bar-fill { width: 100%; border-radius: 3px 3px 0 0; transition: height 0.12s linear; }
        .htp-mic-bar-label { font-size: 10px; color: #5C7086; }
        .htp-mic-bar-label.weak { color: #3E4E5E; font-style: italic; }
        .htp-mic-diff-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; border-bottom: 1px solid #16293C; font-size: 13px; }
        .htp-mic-diff-row:last-child { border-bottom: none; }
        .htp-badge { font-size: 11px; padding: 1px 7px; border-radius: 10px; }
        .htp-lockbtn { background: transparent; border: 1px solid #24435F; color: #93A5B8; border-radius: 6px; padding: 4px 8px; font-size: 11px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
        .htp-lockbtn.on { border-color: #E8A33D; color: #E8A33D; }
        .htp-orient { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
        .htp-orient button { background: transparent; border: 1px solid #24435F; color: #93A5B8; border-radius: 5px; padding: 3px 5px; font-size: 10px; cursor: pointer; }
        .htp-orient button:hover { border-color: #E8A33D; color: #E8A33D; }
        .htp-orient span { min-width: 34px; text-align: center; color: #E7EEF3; font-size: 11px; }
        .htp-view-toggle { display: inline-flex; gap: 4px; margin-bottom: 10px; background: #0B1B2B; border: 1px solid #1E3A52; border-radius: 7px; padding: 3px; }
        .htp-view-toggle button { background: transparent; border: 0; color: #7F93A8; border-radius: 5px; padding: 6px 11px; font-size: 11px; cursor: pointer; }
        .htp-view-toggle button.active { background: #1A3853; color: #E7EEF3; }
        .htp-scene-label { font-size: 10px; letter-spacing: .03em; fill: #93A5B8; }
        .htp-3d-shadow { opacity: .18; }
        .htp-3d-grid { stroke: #1E405A; stroke-width: 1; opacity: .55; }
      `}</style>

      <h1 className="htp-title">Geometric &amp; Directional Acoustic Setup Optimization — v1.3</h1>
      <p className="htp-sub">Расстановка колонок по геометрии комнаты, зоне прослушивания и направленности</p>
      <p className="htp-caveat">
        Пока без отражений, поглощения, дифракции и мод помещения — это геометрическая и условная направленная оптимизация,
        а не полная модель акустического поля. Направленность пока задана визуальной/условной моделью, а не измеренной АЧХ.
        3D-вид — стилизованная проекция тех же геометрических данных (перспективный трюк на SVG), а не физически точный рендер.
        Полноценную физическую модель (Acoustic Field Optimization) планируем как следующий этап.
      </p>

      <div className="htp-layout">
        <div className="htp-panel">
          <div className="htp-field">
            <label>Конфигурация системы</label>
            <select className="htp-select" value={configKey} onChange={(e) => setConfigKey(e.target.value)}>
              {Object.entries(CONFIGS).map(([key, c]) => (
                <option key={key} value={key}>{c.label}</option>
              ))}
            </select>
          </div>

          <div className="htp-row">
            <div className="htp-field">
              <label>Ширина комнаты <span className="htp-unit">см (200–1200)</span></label>
              <input className="htp-input" type="number" value={roomWInput}
                onChange={(e) => setRoomWInput(e.target.value)}
                onBlur={() => setRoomWInput(String(clamp(Number(roomWInput) || 200, 200, 1200)))} />
            </div>
            <div className="htp-field">
              <label>Длина комнаты <span className="htp-unit">см (200–1200)</span></label>
              <input className="htp-input" type="number" value={roomLInput}
                onChange={(e) => setRoomLInput(e.target.value)}
                onBlur={() => setRoomLInput(String(clamp(Number(roomLInput) || 200, 200, 1200)))} />
            </div>
          </div>

          <div className="htp-field">
            <label>Высота потолка <span className="htp-unit">см (200–400)</span></label>
            <input className="htp-input" type="number" value={roomHInput}
              onChange={(e) => setRoomHInput(e.target.value)}
              onBlur={() => setRoomHInput(String(clamp(Number(roomHInput) || 200, 200, 400)))} />
          </div>

          <div className="htp-field">
            <label>Ширина зоны прослушивания (диван) <span className="htp-unit">см</span></label>
            <input className="htp-input" type="range" min={0} max={280} value={sofaWidth}
              onChange={(e) => setSofaWidth(Number(e.target.value))} />
          </div>

          <div className="htp-field">
            <label>Радиус расстановки от кресла <span className="htp-unit">см</span></label>
            <input className="htp-input" type="range" min={80}
              max={validRoom ? Math.min(roomW, roomL) * 0.55 : 300} value={radius}
              onChange={(e) => setRadius(Number(e.target.value))} />
          </div>

          {config.channels.some((c) => c.type === "sub") && (
            <div className="htp-field">
              <label>Сторона сабвуфера</label>
              <div className="htp-toggle">
                <button className={subSide === "left" ? "active" : ""} onClick={() => setSubSide("left")}>Слева</button>
                <button className={subSide === "right" ? "active" : ""} onClick={() => setSubSide("right")}>Справа</button>
              </div>
            </div>
          )}

          <button className="htp-optimize" onClick={runOptimize} disabled={optimizing || !validRoom}>
            <Sparkles size={16} /> {optimizing ? "Считаю…" : "Найти оптимум"}
          </button>

          <button className="htp-reset" onClick={resetAll}>
            <RotateCcw size={14} /> Сбросить расстановку
          </button>

          <p className="htp-note">
            Если колонку физически некуда поставить (например, там окно) — перетащите её на возможное место
            и нажмите 🔒 в таблице ниже. Оптимизатор зафиксирует эту точку и пересчитает остальные.
          </p>
        </div>

        <div className="htp-canvas-wrap">
          <div className="htp-view-toggle">
            <button className={viewMode === "2d" ? "active" : ""} onClick={() => setViewMode("2d")}>2D схема</button>
            <button className={viewMode === "3d" ? "active" : ""} onClick={() => setViewMode("3d")}>3D вид</button>
          </div>
          <div className="htp-canvas-box">
            {viewMode === "2d" ? <svg ref={svgRef} viewBox={`0 0 ${CANVAS} ${CANVAS}`} width="100%" style={{ display: "block", touchAction: "none" }}>
              <rect x={offX} y={offY} width={roomW * scale} height={roomL * scale} fill="none" stroke="#2E5474" strokeWidth="2" rx="4" />
              {Array.from({ length: Math.max(0, Math.floor(roomW / 50)) }).map((_, i) => (
                <line key={"gv" + i} x1={offX + i * 50 * scale} y1={offY} x2={offX + i * 50 * scale} y2={offY + roomL * scale} stroke="#173049" strokeWidth="1" />
              ))}
              {Array.from({ length: Math.max(0, Math.floor(roomL / 50)) }).map((_, i) => (
                <line key={"gh" + i} x1={offX} y1={offY + i * 50 * scale} x2={offX + roomW * scale} y2={offY + i * 50 * scale} stroke="#173049" strokeWidth="1" />
              ))}
              <text x={offX + roomW * scale / 2} y={offY - 12} fill="#5C7086" fontSize="11" textAnchor="middle">экран / фронтальная стена</text>

              {(() => {
                const a = toPx(listenPoints[0]);
                const b = toPx(listenPoints[2]);
                return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#E7EEF3" strokeOpacity="0.25" strokeWidth="6" strokeLinecap="round" />;
              })()}

              {config.channels.map((ch) => {
                if (ch.type === "sub") return null;
                const speaker = positions[ch.id];
                const heading = getOrientation(ch);
                const beamLength = Math.min(BEAM_LENGTH, Math.min(roomW, roomL) * 0.42);
                const poly = conePoints(speaker, heading, beamWidthFor(ch.type), beamLength).map(toPx).map((p) => `${p.x},${p.y}`).join(" ");
                const sp = toPx(speaker);
                const ep = toPx(beamEnd(speaker, heading, beamLength));
                return (
                  <g key={"beam-" + ch.id} pointerEvents="none">
                    <polygon points={poly} fill={TYPE_STYLE[ch.type].color} fillOpacity="0.08" stroke={TYPE_STYLE[ch.type].color} strokeOpacity="0.28" strokeWidth="1" />
                    <line x1={sp.x} y1={sp.y} x2={ep.x} y2={ep.y} stroke={TYPE_STYLE[ch.type].color} strokeOpacity="0.45" strokeWidth="1.5" />
                  </g>
                );
              })}

              {listenPoints.map((lp, i) => {
                const p = toPx(lp);
                return <circle key={"lp-" + i} cx={p.x} cy={p.y} r={i === 1 ? 4 : 3} fill="#E7EEF3" fillOpacity={i === 1 ? 0.9 : 0.5} />;
              })}

              {config.channels.map((ch) => {
                if (ch.type === "sub") return null;
                const a = toPx(listen);
                const b = toPx(positions[ch.id]);
                return <line key={"line-" + ch.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={TYPE_STYLE[ch.type].color} strokeOpacity="0.35" strokeWidth="1.5" />;
              })}

              {(() => {
                const p = toPx(listen);
                return (
                  <g onPointerDown={startDrag("LISTEN")} onTouchStart={startDrag("LISTEN")} style={{ cursor: "grab" }}>
                    <circle cx={p.x} cy={p.y} r="11" fill="#0B1B2B" stroke="#E7EEF3" strokeWidth="2" />
                    <circle cx={p.x} cy={p.y} r="3.5" fill="#E7EEF3" />
                    <text x={p.x} y={p.y + 26} fill="#E7EEF3" fontSize="11" textAnchor="middle">место прослушивания</text>
                  </g>
                );
              })()}

              {config.channels.map((ch) => {
                const p = toPx(positions[ch.id]);
                const style = TYPE_STYLE[ch.type];
                const isLocked = locked[ch.id];
                return (
                  <g key={ch.id} onPointerDown={startDrag(ch.id)} onTouchStart={startDrag(ch.id)} style={{ cursor: "grab" }}>
                    <circle cx={p.x} cy={p.y} r="10" fill={style.color} stroke={isLocked ? "#E7EEF3" : "#0B1B2B"} strokeWidth={isLocked ? 3 : 2} />
                    <text x={p.x} y={p.y + 4} fill="#0B1B2B" fontSize="9.5" fontWeight="700" textAnchor="middle">{ch.id}</text>
                  </g>
                );
              })}
            </svg> : (() => {
              const floor = [
                floorPoint({ x: 0, y: 0 }, roomW, roomL),
                floorPoint({ x: roomW, y: 0 }, roomW, roomL),
                floorPoint({ x: roomW, y: roomL }, roomW, roomL),
                floorPoint({ x: 0, y: roomL }, roomW, roomL),
              ];
              const [frontLeft, frontRight, backRight, backLeft] = floor;
              const wallLift = Math.max(90, roomH * 0.34);
              const screenY = frontLeft.y;
              return <svg ref={svgRef} viewBox={`0 0 ${VIEW3D.width} ${VIEW3D.height}`} width="100%" style={{ display: "block", touchAction: "none" }}>
                <defs>
                  <linearGradient id="roomFloorGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#163650" /><stop offset="100%" stopColor="#0B1B2B" /></linearGradient>
                </defs>
                <polygon points={floor.map(p => `${p.x},${p.y}`).join(" ")} fill="url(#roomFloorGradient)" stroke="#2E5474" strokeWidth="2" />
                <polygon points={`${frontLeft.x},${frontLeft.y} ${frontRight.x},${frontRight.y} ${frontRight.x},${frontRight.y-wallLift} ${frontLeft.x},${frontLeft.y-wallLift}`} fill="#0D2032" stroke="#294A66" strokeWidth="1.2" />
                <polygon points={`${frontRight.x},${frontRight.y} ${backRight.x},${backRight.y} ${backRight.x},${backRight.y-wallLift*.55} ${frontRight.x},${frontRight.y-wallLift}`} fill="#132D45" stroke="#294A66" strokeWidth="1.2" />
                <polygon points={`${frontLeft.x},${frontLeft.y} ${backLeft.x},${backLeft.y} ${backLeft.x},${backLeft.y-wallLift*.55} ${frontLeft.x},${frontLeft.y-wallLift}`} fill="#132D45" stroke="#294A66" strokeWidth="1.2" />
                {Array.from({ length: Math.max(2, Math.floor(roomL / 100) + 1) }).map((_, i) => {
                  const n = Math.max(1, Math.floor(roomL / 100)); const y = Math.min(roomL, i * roomL / n);
                  const a = floorPoint({ x: 0, y }, roomW, roomL), b = floorPoint({ x: roomW, y }, roomW, roomL);
                  return <line key={`d3gy${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="htp-3d-grid" />;
                })}
                {Array.from({ length: Math.max(2, Math.floor(roomW / 100) + 1) }).map((_, i) => {
                  const n = Math.max(1, Math.floor(roomW / 100)); const x = Math.min(roomW, i * roomW / n);
                  const a = floorPoint({ x, y: 0 }, roomW, roomL), b = floorPoint({ x, y: roomL }, roomW, roomL);
                  return <line key={`d3gx${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="htp-3d-grid" />;
                })}
                <polygon points={`${frontLeft.x},${screenY} ${frontRight.x},${screenY} ${frontRight.x},${screenY-25} ${frontLeft.x},${screenY-25}`} fill="#07131F" stroke="#5C7086" strokeWidth="1" />
                <text x={VIEW3D.width/2} y={screenY-34} textAnchor="middle" className="htp-scene-label">ЭКРАН / ФРОНТАЛЬНАЯ СТЕНА</text>
                {config.channels.map(ch => {
                  if (ch.type === "sub") return null;
                  const speaker = positions[ch.id], heading = getOrientation(ch), z = heightForType(ch.type, roomH), style = TYPE_STYLE[ch.type];
                  const beamLength = Math.min(BEAM_LENGTH, Math.min(roomW, roomL) * .42);
                  const layers = [
                    beam3DPoints(speaker, heading, beamWidthFor(ch.type), beamLength, Math.max(35,z-22), roomW, roomL, .70),
                    beam3DPoints(speaker, heading, beamWidthFor(ch.type), beamLength*.82, z+4, roomW, roomL, .86),
                    beam3DPoints(speaker, heading, beamWidthFor(ch.type), beamLength*.60, z+28, roomW, roomL, 1),
                  ];
                  const sp = project3D(speaker,z,roomW,roomL), fp=floorPoint(speaker,roomW,roomL);
                  return <g key={`d3beam${ch.id}`} pointerEvents="none">
                    {layers.map((b,i)=><polygon key={i} points={b.map(p=>`${p.x},${p.y}`).join(" ")} fill={style.color} fillOpacity={0.035+i*.02} stroke={style.color} strokeOpacity={0.14+i*.05} />)}
                    <line x1={fp.x} y1={fp.y} x2={sp.x} y2={sp.y} stroke={style.color} strokeOpacity=".18" strokeDasharray="3 3" />
                    <line x1={sp.x} y1={sp.y} x2={layers[2][1].x} y2={layers[2][1].y} stroke={style.color} strokeOpacity=".28" />
                    <line x1={sp.x} y1={sp.y} x2={layers[2][2].x} y2={layers[2][2].y} stroke={style.color} strokeOpacity=".28" />
                  </g>;
                })}
                {config.channels.map(ch => {
                  const speaker=positions[ch.id], z=heightForType(ch.type,roomH), heading=ch.type === "sub" ? 0 : getOrientation(ch), style=TYPE_STYLE[ch.type];
                  const box=speakerBox3D(speaker,heading,z,roomW,roomL), fp=floorPoint(speaker,roomW,roomL);
                  return <g key={`d3sp${ch.id}`}>
                    <ellipse cx={fp.x} cy={fp.y+2} rx="15" ry="5" fill="#000" className="htp-3d-shadow" />
                    <polygon points={box.bottom.map(p=>`${p.x},${p.y}`).join(" ")} fill={style.color} fillOpacity=".82" stroke="#07131F" strokeWidth="1.5" />
                    <polygon points={`${box.bottom[0].x},${box.bottom[0].y} ${box.bottom[1].x},${box.bottom[1].y} ${box.top[1].x},${box.top[1].y} ${box.top[0].x},${box.top[0].y}`} fill={style.color} fillOpacity=".96" stroke="#07131F" strokeWidth="1.2" />
                    <polygon points={`${box.bottom[1].x},${box.bottom[1].y} ${box.bottom[2].x},${box.bottom[2].y} ${box.top[2].x},${box.top[2].y} ${box.top[1].x},${box.top[1].y}`} fill="#07131F" fillOpacity=".45" stroke="#07131F" strokeWidth="1" />
                    <text x={box.top[0].x} y={box.top[0].y-5} fill="#E7EEF3" fontSize="10" fontWeight="700" textAnchor="middle">{ch.id}</text>
                  </g>;
                })}
                {listenPoints.map((lp,i)=>{ const p=project3D(lp,0,roomW,roomL); return <circle key={`d3lp${i}`} cx={p.x} cy={p.y} r={i===1?7:5} fill="#E7EEF3" fillOpacity={i===1?.9:.45} stroke="#07131F" strokeWidth="2" />; })}
                {(() => { const p=project3D(listen,0,roomW,roomL); return <><circle cx={p.x} cy={p.y} r="10" fill="none" stroke="#E7EEF3" strokeWidth="1.5" strokeOpacity=".5"/><circle cx={p.x} cy={p.y} r="3.5" fill="#E7EEF3"/></>; })()}
                <text x="18" y="520" className="htp-scene-label">3D VIEW • визуализация геометрического расчёта, только просмотр</text>
              </svg>;
            })()}
          </div>
          <div className="htp-hint">
            <Move size={13} />
            {viewMode === "2d"
              ? "Точки, кресло и колонки можно двигать мышью или пальцем; направление колонок меняется в таблице ниже"
              : "3D — режим просмотра. Чтобы подвинуть колонки или кресло, переключитесь на 2D-схему; направление меняется в таблице ниже"}
          </div>
        </div>
      </div>

      {scores && (
        <div className="htp-scores">
          <div className="htp-score-total">
            <div className="lbl">Acoustic Score</div>
            <div className="val" style={{ color: scoreColor(scores.total) }}>{scores.total}/100</div>
          </div>
          {scoreCards.map((s) => (
            <div key={s.key} className="htp-score-mini">
              <div className="lbl"><span>{s.label}</span><span>{s.weight}%</span></div>
              <div className="val" style={{ color: scoreColor(s.value) }}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      <table className="htp-table">
        <thead>
          <tr>
            <th>Канал</th>
            <th>Угол (реком. / текущий)</th>
            <th>Направление</th>
            <th>Расстояние</th>
            <th>Установка</th>
            <th>Закрепить</th>
          </tr>
        </thead>
        <tbody>
          {config.channels.map((ch) => {
            const info = angleInfo(ch);
            const style = TYPE_STYLE[ch.type];
            let badgeColor = "#4FD1C5", badgeBg = "rgba(79,209,197,0.12)", badgeText = "точно";
            if (info) {
              if (info.diff > 15) { badgeColor = "#E76F51"; badgeBg = "rgba(231,111,81,0.14)"; badgeText = "проверьте угол"; }
              else if (info.diff > 5) { badgeColor = "#E8A33D"; badgeBg = "rgba(232,163,61,0.14)"; badgeText = "близко"; }
            }
            return (
              <tr key={ch.id}>
                <td><span className="htp-dot" style={{ background: style.color }} />{ch.label}</td>
                <td>
                  {info ? (
                    <>{ch.angle}° / {info.actual}°{" "}
                      <span className="htp-badge" style={{ color: badgeColor, background: badgeBg }}>{badgeText}</span>
                    </>
                  ) : "—"}
                </td>
                <td>
                  {ch.type !== "sub" ? (
                    <div className="htp-orient">
                      <button onClick={() => rotateSpeaker(ch.id, -5)}>−5°</button>
                      <span>{Math.round(getOrientation(ch))}°</span>
                      <button onClick={() => rotateSpeaker(ch.id, 5)}>+5°</button>
                      <button title="Автонаведение" onClick={() => resetSpeakerOrientation(ch.id)}>↺</button>
                    </div>
                  ) : "—"}
                </td>
                <td>{info ? `${(info.dist / 100).toFixed(2)} м` : "у фронтальной стены"}</td>
                <td style={{ color: "#93A5B8" }}>{style.note}</td>
                <td>
                  {ch.type !== "sub" && (
                    <button className={"htp-lockbtn" + (locked[ch.id] ? " on" : "")} onClick={() => toggleLock(ch.id)}>
                      {locked[ch.id] ? <Lock size={12} /> : <Unlock size={12} />}
                      {locked[ch.id] ? "закреплено" : "закрепить"}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="htp-power">
        <div className="htp-power-card">
          <div className="num">{power.main} Вт</div>
          <div className="cap">рекомендуемая мощность на канал (L/C/R/surround)</div>
        </div>
        <div className="htp-power-card">
          <div className="num">{power.sub} Вт</div>
          <div className="cap">рекомендуемая мощность сабвуфера</div>
        </div>
        <div className="htp-power-card">
          <div className="num">{power.volume.toFixed(1)} м³</div>
          <div className="cap">объём помещения</div>
        </div>
      </div>

      <p className="htp-note">
        Score считается по геометрии (позиция + ручное наведение), Coverage — по тому, сколько точек зоны
        прослушивания реально попадают в конус направленности каждой колонки, равномерности и абсолютной
        величине расстояний (SPL Proxy, Distance) и симметрии левых/правых каналов. Мощность — приблизительный
        расчёт по объёму помещения, справочный характер.
      </p>

      <div className="htp-mic">
        <div className="htp-mic-head">
          <h2>🎙️ Слышит ли смартфон комнату?</h2>
          <span className="htp-mic-badge">v1.4.0 · эксперимент</span>
        </div>
        <p className="htp-mic-sub">
          Технический спайк, отдельно от расчёта выше: проверяем, может ли микрофон телефона вообще дать
          осмысленные, повторяемые данные — прежде чем строить полноценное пошаговое измерение по каналам.
        </p>

        <div className="htp-mic-disclaimer">
          Это не калиброванный SPL-анализ. Микрофон телефона не откалиброван, автоматическая регулировка
          усиления может искажать показания даже после попытки её отключить, а полосы ниже ~200 Гц особенно
          ненадёжны из-за конструкции микрофона (они помечены курсивом и приглушены). Сравнивай только
          относительные изменения между снимками на одном и том же телефоне — не абсолютные числа, и не
          разные устройства между собой.
        </div>

        <div className="htp-mic-controls">
          {micStatus !== "active" ? (
            <button className="htp-mic-btn" onClick={startMic} disabled={micStatus === "requesting"}>
              <Sparkles size={15} /> {micStatus === "requesting" ? "Запрашиваю доступ…" : "Включить микрофон"}
            </button>
          ) : (
            <>
              <button className="htp-mic-btn" onClick={takeSnapshot} disabled={capturing}>
                {capturing ? `Снимаю… ${Math.round(captureProgress * 100)}%` : "Снять снимок (3 сек)"}
              </button>
              <button className="htp-mic-btn ghost" onClick={stopMic}>Выключить микрофон</button>
            </>
          )}
          {micStatus === "denied" && (
            <span className="htp-mic-status">Доступ к микрофону запрещён — разреши его в настройках браузера.</span>
          )}
          {micStatus === "error" && (
            <span className="htp-mic-status">Ошибка: {micError || "не удалось получить доступ к микрофону"}</span>
          )}
        </div>

        {micStatus === "active" && (
          <>
            <div className="htp-mic-bars">
              {MIC_BANDS.map((band, i) => {
                const db = liveLevels[i] ?? -60;
                const heightPct = clamp(((db + 60) / 60) * 100, 2, 100);
                const color = band.reliable ? "#4FD1C5" : "#2C4A56";
                return (
                  <div key={band.freq} className="htp-mic-bar-col">
                    <div className="htp-mic-bar-track">
                      <div className="htp-mic-bar-fill" style={{ height: `${heightPct}%`, background: color }} />
                    </div>
                    <span className={"htp-mic-bar-label" + (band.reliable ? "" : " weak")}>{band.label}</span>
                  </div>
                );
              })}
            </div>
            <p className="htp-note">Живой спектр, ≈ каждые {MIC_SAMPLE_MS} мс. Гц по нижней шкале.</p>
          </>
        )}

        {snapshot && (
          <div style={{ marginTop: 18 }}>
            <table className="htp-table">
              <thead>
                <tr>
                  <th>Полоса</th>
                  <th>Снимок</th>
                  {prevSnapshot && <th>Изменение с прошлого снимка</th>}
                </tr>
              </thead>
              <tbody>
                {MIC_BANDS.map((band, i) => {
                  const val = snapshot.levels[i];
                  const diff = prevSnapshot ? val - prevSnapshot.levels[i] : null;
                  let badgeColor = "#4FD1C5", badgeBg = "rgba(79,209,197,0.12)";
                  if (diff !== null) {
                    if (Math.abs(diff) > 5) { badgeColor = "#E76F51"; badgeBg = "rgba(231,111,81,0.14)"; }
                    else if (Math.abs(diff) > 2) { badgeColor = "#E8A33D"; badgeBg = "rgba(232,163,61,0.14)"; }
                  }
                  return (
                    <tr key={band.freq}>
                      <td style={{ color: band.reliable ? "#E7EEF3" : "#5C7086", fontStyle: band.reliable ? "normal" : "italic" }}>
                        {band.label} Гц
                      </td>
                      <td>{val.toFixed(1)} dB (усл.)</td>
                      {prevSnapshot && (
                        <td>
                          <span className="htp-badge" style={{ color: badgeColor, background: badgeBg }}>
                            {diff >= 0 ? "+" : ""}{diff.toFixed(1)} dB
                          </span>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="htp-note">
              Значения — условные единицы относительно максимума чувствительности микрофона в этом сеансе,
              не dB SPL. {prevSnapshot ? "Разница показывает, что изменилось между двумя снимками на этом телефоне." : "Сними ещё один снимок (например, передвинув телефон или колонку), чтобы увидеть разницу."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

