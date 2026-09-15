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
  
  
