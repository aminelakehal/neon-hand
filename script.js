const video = document.getElementById("video");
const canvas = document.getElementById("hudCanvas");
const ctx = canvas.getContext("2d");

const coordX = document.getElementById("coordX");
const coordY = document.getElementById("coordY");
const statusText = document.getElementById("statusText");

const STATUS = {
  NO_HAND: "NO HAND",
  HAND_DETECTED: "HAND DETECTED",
  WRITING: "WRITING MODE",
  PAUSED: "PAUSED",
  CAMERA_DENIED: "CAMERA ACCESS DENIED",
};

const WRITING_DISTANCE_THRESHOLD = 4;
const PARTICLE_LIFE = 24;
const LANDMARK_SMOOTHING_ALPHA = 0.42;
const particles = [];
const strokePoints = [];

let isWriting = false;
let lastPoint = null;
let hasHand = false;
let smoothedHandPoints = null;

// MediaPipe hand connection pairs for skeleton rendering.
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

window.addEventListener("resize", resizeCanvas);
resizeCanvas();

function setStatus(text) {
  statusText.textContent = text;
}

function resetCoordinates() {
  coordX.textContent = "X: ---";
  coordY.textContent = "Y: ---";
}

function updateCoordinates(x, y) {
  coordX.textContent = `X: ${Math.round(x)}`;
  coordY.textContent = `Y: ${Math.round(y)}`;
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function isFingerUp(landmarks, tipIndex, pipIndex) {
  return landmarks[tipIndex].y < landmarks[pipIndex].y;
}

function isOpenPalm(landmarks) {
  const thumbUp = landmarks[4].y < landmarks[3].y;
  const indexUp = isFingerUp(landmarks, 8, 6);
  const middleUp = isFingerUp(landmarks, 12, 10);
  const ringUp = isFingerUp(landmarks, 16, 14);
  const pinkyUp = isFingerUp(landmarks, 20, 18);
  return thumbUp && indexUp && middleUp && ringUp && pinkyUp;
}

function isPinch(landmarks) {
  return dist(landmarks[4], landmarks[8]) < 0.05;
}

function shouldStartWriting(landmarks) {
  return isFingerUp(landmarks, 8, 6);
}

function toCanvasPoint(landmark) {
  return {
    // Mirror X so motion behaves like a selfie camera.
    x: canvas.width - landmark.x * canvas.width,
    y: landmark.y * canvas.height,
  };
}

function getSmoothedHandPoints(landmarks) {
  const mappedPoints = landmarks.map(toCanvasPoint);

  if (!smoothedHandPoints || smoothedHandPoints.length !== mappedPoints.length) {
    smoothedHandPoints = mappedPoints;
    return mappedPoints;
  }

  smoothedHandPoints = mappedPoints.map((point, index) => {
    const previous = smoothedHandPoints[index];
    return {
      x: previous.x + (point.x - previous.x) * LANDMARK_SMOOTHING_ALPHA,
      y: previous.y + (point.y - previous.y) * LANDMARK_SMOOTHING_ALPHA,
    };
  });

  return smoothedHandPoints;
}

function addParticles(x, y) {
  for (let i = 0; i < 2; i += 1) {
    particles.push({
      x: x + (Math.random() - 0.5) * 5,
      y: y + (Math.random() - 0.5) * 5,
      vx: (Math.random() - 0.5) * 0.7,
      vy: (Math.random() - 0.5) * 0.7,
      life: PARTICLE_LIFE,
      radius: 1 + Math.random() * 1.8,
    });
  }
}

function drawParticles() {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  for (let i = particles.length - 1; i >= 0; i -= 1) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.life -= 1;

    if (p.life <= 0) {
      particles.splice(i, 1);
      continue;
    }

    const alpha = p.life / PARTICLE_LIFE;
    ctx.beginPath();
    ctx.fillStyle = `rgba(0, 246, 255, ${alpha * 0.8})`;
    ctx.shadowBlur = 12;
    ctx.shadowColor = "#00f6ff";
    ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawNeonNode(x, y, radius, color, glow) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = color;
  ctx.shadowBlur = glow;
  ctx.shadowColor = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawNeonLine(a, b, color, width, glow) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowBlur = glow;
  ctx.shadowColor = color;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

function drawSkeleton(points) {
  HAND_CONNECTIONS.forEach(([s, e]) => {
    drawNeonLine(points[s], points[e], "#a100ff", 2.2, 14);
    drawNeonLine(points[s], points[e], "#00f6ff", 1, 10);
  });

  points.forEach((point, index) => {
    if (index === 8) {
      drawNeonNode(point.x, point.y, 6.2, "#00f6ff", 20);
      return;
    }

    drawNeonNode(point.x, point.y, 3.8, "#d68bff", 14);
  });
}

function drawSmoothedStroke() {
  if (strokePoints.length < 2) {
    return;
  }

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.strokeStyle = "#00f6ff";
  ctx.lineWidth = 4.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowBlur = 22;
  ctx.shadowColor = "#00f6ff";

  ctx.beginPath();
  ctx.moveTo(strokePoints[0].x, strokePoints[0].y);

  // Bezier-like smoothing using quadratic interpolation between midpoint segments.
  for (let i = 1; i < strokePoints.length - 1; i += 1) {
    const current = strokePoints[i];
    const next = strokePoints[i + 1];
    const midX = (current.x + next.x) / 2;
    const midY = (current.y + next.y) / 2;
    ctx.quadraticCurveTo(current.x, current.y, midX, midY);
  }

  const last = strokePoints[strokePoints.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
  ctx.restore();
}

function pushSmoothedPoint(rawPoint) {
  if (!lastPoint) {
    lastPoint = rawPoint;
    strokePoints.push(rawPoint);
    return;
  }

  const movement = dist(lastPoint, rawPoint);

  // Distance filtering to suppress tiny jitter.
  if (movement < WRITING_DISTANCE_THRESHOLD) {
    return;
  }

  // Interpolate extra points for smoother curves when movement jumps.
  const steps = Math.ceil(movement / 8);
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    strokePoints.push({
      x: lastPoint.x + (rawPoint.x - lastPoint.x) * t,
      y: lastPoint.y + (rawPoint.y - lastPoint.y) * t,
    });
  }

  // Keep memory bounded while preserving smooth drawing continuity.
  if (strokePoints.length > 2200) {
    strokePoints.splice(0, 300);
  }

  lastPoint = rawPoint;
}

function clearDrawingState() {
  strokePoints.length = 0;
  particles.length = 0;
  lastPoint = null;
}

function renderFrame(points) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  drawSmoothedStroke();
  drawParticles();

  if (!points) {
    return;
  }

  drawSkeleton(points);
}

function onResults(results) {
  const hand = results.multiHandLandmarks && results.multiHandLandmarks[0];

  if (!hand) {
    hasHand = false;
    isWriting = false;
    lastPoint = null;
    smoothedHandPoints = null;
    setStatus(STATUS.NO_HAND);
    resetCoordinates();
    renderFrame(null);
    return;
  }

  hasHand = true;
  const points = getSmoothedHandPoints(hand);
  const indexPoint = points[8];
  updateCoordinates(indexPoint.x, indexPoint.y);

  if (isOpenPalm(hand)) {
    isWriting = false;
    clearDrawingState();
    setStatus(STATUS.PAUSED);
    renderFrame(points);
    return;
  }

  if (isPinch(hand)) {
    isWriting = false;
    lastPoint = null;
    setStatus(STATUS.PAUSED);
    renderFrame(points);
    return;
  }

  if (shouldStartWriting(hand)) {
    isWriting = true;
  }

  if (isWriting) {
    pushSmoothedPoint(indexPoint);
    addParticles(indexPoint.x, indexPoint.y);
    setStatus(STATUS.WRITING);
  } else {
    setStatus(hasHand ? STATUS.HAND_DETECTED : STATUS.NO_HAND);
  }

  renderFrame(points);
}

const hands = new Hands({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
});

hands.setOptions({
  maxNumHands: 1,
  modelComplexity: 1,
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.7,
});

hands.onResults(onResults);

const camera = new Camera(video, {
  onFrame: async () => {
    await hands.send({ image: video });
  },
  width: 1280,
  height: 720,
  fps: 30,
});

camera
  .start()
  .then(() => setStatus(STATUS.PAUSED))
  .catch(() => setStatus(STATUS.CAMERA_DENIED));
