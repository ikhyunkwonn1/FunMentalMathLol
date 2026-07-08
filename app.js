const Status = {
  IDLE: "idle",
  RUNNING: "running",
  FAILED: "failed",
};

const STAGE_CLASSES = ["stage-calm", "stage-warning", "stage-danger", "stage-critical"];

const STORAGE_KEYS = {
  bestStreak: "numberlineBestStreak",
  bestPoints: "numberlineBestPoints",
  startTime: "numberlineStartTime",
  timeMultiplier: "numberlineTimeMultiplier",
  operatorMode: "numberlineOperatorMode",
};

const LEADERBOARD_DEFAULTS = {
  startTime: 10,
  timeMultiplier: 0.925,
  operatorMode: "both",
};

// Set this to false to remove the temporary leaderboard access button.
const LEADERBOARD_BUTTON_ENABLED = true;
const LEADERBOARD_ID_VISIBLE_CHARS = 15;

const leaderboardConfig = window.NUMBERLINE_SUPABASE || {};
const leaderboardClient =
  leaderboardConfig.url && leaderboardConfig.anonKey && window.supabase
    ? window.supabase.createClient(leaderboardConfig.url, leaderboardConfig.anonKey)
    : null;

const els = {
  game: document.getElementById("game"),
  fuseFill: document.getElementById("fuseFill"),
  phaseLabel: document.getElementById("phaseLabel"),
  streak: document.getElementById("streak"),
  points: document.getElementById("points"),
  bestStreak: document.getElementById("bestStreak"),
  timeLeft: document.getElementById("timeLeft"),
  problemText: document.getElementById("problemText"),
  pressureText: document.getElementById("pressureText"),
  difficultyScore: document.getElementById("difficultyScore"),
  answerInput: document.getElementById("answerInput"),
  statusLine: document.getElementById("statusLine"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayCopy: document.getElementById("overlayCopy"),
  resultGrid: document.getElementById("resultGrid"),
  finalStreak: document.getElementById("finalStreak"),
  finalPoints: document.getElementById("finalPoints"),
  finalBestStreak: document.getElementById("finalBestStreak"),
  finalBestPoints: document.getElementById("finalBestPoints"),
  finalFastest: document.getElementById("finalFastest"),
  finalAverage: document.getElementById("finalAverage"),
  missedLine: document.getElementById("missedLine"),
  customizePanel: document.getElementById("customizePanel"),
  customizeSummary: document.querySelector("#customizePanel > summary"),
  leaderboardOpenButton: document.getElementById("leaderboardOpenButton"),
  leaderboardOverlay: document.getElementById("leaderboardOverlay"),
  leaderboardKicker: document.getElementById("leaderboardKicker"),
  leaderboardTitle: document.getElementById("leaderboardPromptTitle"),
  leaderboardStatus: document.getElementById("leaderboardStatus"),
  leaderboardEntry: document.getElementById("leaderboardEntry"),
  leaderboardList: document.getElementById("leaderboardList"),
  leaderboardRows: document.getElementById("leaderboardRows"),
  leaderboardRunStreak: document.getElementById("leaderboardRunStreak"),
  leaderboardRunScore: document.getElementById("leaderboardRunScore"),
  leaderboardRunFastest: document.getElementById("leaderboardRunFastest"),
  leaderboardRunAverage: document.getElementById("leaderboardRunAverage"),
  leaderboardSubmitForm: document.getElementById("leaderboardSubmitForm"),
  leaderboardName: document.getElementById("leaderboardName"),
  leaderboardSubmitButton: document.getElementById("leaderboardSubmitButton"),
  leaderboardSkipButton: document.getElementById("leaderboardSkipButton"),
  leaderboardReturnButton: document.getElementById("leaderboardReturnButton"),
  startButton: document.getElementById("startButton"),
};

const SETTINGS = {
  startTime: { min: 6, max: 12, step: 0.1, defaultValue: 10 },
  timeMultiplier: { min: 0.9, max: 0.98, step: 0.005, defaultValue: 0.925 },
  operatorMode: ["both", "add", "sub"],
};

const initialSettings = readSettings();
let customizeExpanded = false;
let customizeAnimationFrame = 0;

const state = {
  status: Status.IDLE,
  streak: 0,
  points: 0,
  bestStreak: readNumber(STORAGE_KEYS.bestStreak),
  bestPoints: readNumber(STORAGE_KEYS.bestPoints),
  currentProblem: null,
  duration: initialSettings.startTime,
  deadline: 0,
  roundStartedAt: 0,
  rafId: 0,
  lastProblemLabel: "",
  failReason: "",
  missedEquation: "",
  missedDifficultyColor: "",
  missedDifficultyScore: "",
  missedInput: "",
  answerTimes: [],
  settings: initialSettings,
  pendingLeaderboardRun: null,
};

function readNumber(key) {
  try {
    return Number(localStorage.getItem(key) || 0);
  } catch {
    return 0;
  }
}

function writeNumber(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Local persistence is a bonus, not required for play.
  }
}

function readSettings() {
  return {
    startTime: readNumericSetting(STORAGE_KEYS.startTime, SETTINGS.startTime),
    timeMultiplier: readNumericSetting(STORAGE_KEYS.timeMultiplier, SETTINGS.timeMultiplier),
    operatorMode: readOption(STORAGE_KEYS.operatorMode, SETTINGS.operatorMode, "both"),
  };
}

function readNumericSetting(key, config) {
  const raw = readStoredValue(key);
  const fallback = config.defaultValue;
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return normalizeNumericSetting(parsed, config);
}

function readOption(key, allowedValues, fallback) {
  const raw = readStoredValue(key);
  const next = raw === null ? fallback : raw;
  return allowedValues.includes(next) ? next : fallback;
}

function readStoredValue(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSetting(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Settings persistence is optional.
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundToStep(value, step, min) {
  const decimals = step.toString().includes(".") ? step.toString().split(".")[1].length : 0;
  const rounded = Math.round((value - min) / step) * step + min;
  return Number(rounded.toFixed(decimals));
}

function normalizeNumericSetting(value, config) {
  return roundToStep(clamp(value, config.min, config.max), config.step, config.min);
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function formatTime(seconds) {
  return Math.max(0, seconds).toFixed(1);
}

function getRoundDuration(streak) {
  return Math.max(1.8, state.settings.startTime * Math.pow(state.settings.timeMultiplier, streak));
}

function getPhase(streak) {
  if (streak >= 18) return "Overdrive";
  if (streak >= 8) return "Pressure";
  return "Warmup";
}

function getTimeLeft(now = performance.now()) {
  if (state.status === Status.FAILED) return 0;
  if (state.status !== Status.RUNNING) return state.duration;
  return Math.max(0, (state.deadline - now) / 1000);
}

function getPressureStage(progress) {
  if (progress < 0.1) return "critical";
  if (progress < 0.25) return "danger";
  if (progress < 0.5) return "warning";
  return "calm";
}

function getShakeIntensity(progress) {
  if (state.status !== Status.RUNNING) return 0;
  return clamp((0.5 - progress) / 0.5, 0, 1);
}

function makeProblem() {
  const streak = state.streak;
  let problem;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const operator = chooseOperator(streak);
    const min = streak < 8 ? 10 : streak < 18 ? 18 : 31;
    const max = streak < 8 ? 69 : streak < 18 ? 89 : 99;
    const left = randomInt(min, max);
    const right = randomInt(10, max);

    if (operator === "+") {
      problem = {
        answer: left + right,
        difficultyScore: NumberlineDifficulty.scoreProblem(left, operator, right),
        label: `${left} + ${right}`,
      };
    } else {
      const high = Math.max(left, right);
      const low = Math.min(left, right);
      problem = {
        answer: high - low,
        difficultyScore: NumberlineDifficulty.scoreProblem(high, operator, low),
        label: `${high} - ${low}`,
      };
    }

    if (problem.label !== state.lastProblemLabel) break;
  }

  return problem;
}

function chooseOperator(streak) {
  if (state.settings.operatorMode === "add") return "+";
  if (state.settings.operatorMode === "sub") return "-";
  const subtractionChance = streak < 8 ? 0.25 : streak < 18 ? 0.5 : 0.62;
  return Math.random() < subtractionChance ? "-" : "+";
}

function setOverlay(show) {
  els.overlay.classList.toggle("show", show);
  els.overlay.setAttribute("aria-hidden", String(!show));
}

function retrigger(element, className) {
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
}

function queueNextProblem() {
  state.currentProblem = makeProblem();
  state.lastProblemLabel = state.currentProblem.label;
  state.duration = getRoundDuration(state.streak);
  state.roundStartedAt = performance.now();
  state.deadline = state.roundStartedAt + state.duration * 1000;
  els.problemText.textContent = state.currentProblem.label;
  els.answerInput.value = "";
  retrigger(els.problemText, "snap");
  render();
}

function startRun() {
  cancelAnimationFrame(state.rafId);
  state.status = Status.RUNNING;
  syncLeaderboardOpenButton();
  state.streak = 0;
  state.points = 0;
  state.failReason = "";
  state.missedEquation = "";
  state.missedDifficultyColor = "";
  state.missedDifficultyScore = "";
  state.missedInput = "";
  state.answerTimes = [];
  state.pendingLeaderboardRun = null;
  closeLeaderboardPrompt();
  els.answerInput.disabled = false;
  els.statusLine.classList.remove("hot");
  els.game.classList.remove("failed");
  setOverlay(false);
  queueNextProblem();
  keepFocus();
  tick();
}

function failRun(reason, submittedAnswer = "") {
  if (state.status !== Status.RUNNING) return;
  state.status = Status.FAILED;
  state.failReason = reason;
  state.missedEquation = state.currentProblem
    ? `${state.currentProblem.label} = ${state.currentProblem.answer}`
    : "";
  state.missedDifficultyColor = state.currentProblem
    ? NumberlineDifficulty.getDifficultyColor(state.currentProblem.difficultyScore)
    : "";
  state.missedDifficultyScore = state.currentProblem
    ? NumberlineDifficulty.formatDifficultyScore(state.currentProblem.difficultyScore)
    : "";
  state.missedInput = submittedAnswer;
  cancelAnimationFrame(state.rafId);
  els.answerInput.disabled = true;
  updateBests();
  render();
  showFailureOverlay();
  processLeaderboardRun();
  retrigger(els.game, "failed");
}

function updateBests() {
  const nextBestStreak = Math.max(state.bestStreak, state.streak);
  const nextBestPoints = Math.max(state.bestPoints, state.points);
  if (nextBestStreak !== state.bestStreak) {
    state.bestStreak = nextBestStreak;
    writeNumber(STORAGE_KEYS.bestStreak, state.bestStreak);
  }
  if (nextBestPoints !== state.bestPoints) {
    state.bestPoints = nextBestPoints;
    writeNumber(STORAGE_KEYS.bestPoints, state.bestPoints);
  }
}

function submitAnswer() {
  if (state.status !== Status.RUNNING) return;
  const raw = els.answerInput.value.trim();
  if (raw === "") return;

  const timeLeft = getTimeLeft();
  if (Number(raw) !== state.currentProblem.answer) {
    failRun("Miss", raw);
    return;
  }

  const answerTime = Math.max(0, (performance.now() - state.roundStartedAt) / 1000);
  const speedBonus = Math.round((timeLeft / state.duration) * 100);
  state.answerTimes.push(answerTime);
  state.points += 100 + speedBonus;
  state.streak += 1;
  updateBests();
  els.statusLine.textContent = `Clean +${100 + speedBonus}`;
  els.statusLine.classList.remove("hot");
  queueNextProblem();
  keepFocus();
}

function tick() {
  if (state.status !== Status.RUNNING) return;
  const timeLeft = getTimeLeft();
  if (timeLeft <= 0) {
    failRun("Too slow");
    return;
  }
  render();
  state.rafId = requestAnimationFrame(tick);
}

function render() {
  const timeLeft = getTimeLeft();
  const progress = state.duration > 0 ? clamp(timeLeft / state.duration, 0, 1) : 1;
  const stage = getPressureStage(progress);
  setGamePressure(stage, progress);
  els.fuseFill.style.transform = `scaleX(${progress})`;
  els.phaseLabel.textContent = getPhase(state.streak);
  els.streak.textContent = state.streak;
  els.points.textContent = state.points;
  els.bestStreak.textContent = state.bestStreak;
  els.timeLeft.textContent = formatTime(timeLeft);
  els.pressureText.textContent = pressureLabel(stage);
  els.difficultyScore.textContent = state.currentProblem
    ? NumberlineDifficulty.formatDifficultyScore(state.currentProblem.difficultyScore)
    : "Difficulty 0.00";
  els.difficultyScore.style.color = state.currentProblem
    ? NumberlineDifficulty.getDifficultyColor(state.currentProblem.difficultyScore)
    : "";
  els.statusLine.classList.toggle("hot", stage === "danger" || stage === "critical");
}

function setGamePressure(stage, progress) {
  const shake = getShakeIntensity(progress);
  els.game.classList.remove(...STAGE_CLASSES);
  els.game.classList.add(`stage-${stage}`);
  els.game.classList.toggle("is-running", state.status === Status.RUNNING);
  els.game.style.setProperty("--shake-distance", `${(shake * 6).toFixed(2)}px`);
  els.game.style.setProperty("--shake-speed", `${Math.round(180 - shake * 80)}ms`);
}

function pressureLabel(stage) {
  if (state.status === Status.IDLE) return "Ready";
  if (state.status === Status.FAILED) return state.failReason;
  if (stage === "critical") return "Critical";
  if (stage === "danger") return "Danger";
  if (stage === "warning") return "Burning";
  return "Clean";
}

function showIdleOverlay() {
  els.overlayTitle.textContent = "Numberline";
  els.overlayCopy.textContent = "Sprint through two-digit math before the fuse burns down.";
  els.resultGrid.hidden = true;
  els.missedLine.hidden = true;
  closeLeaderboardPrompt();
  els.startButton.textContent = "Start Run";
  setOverlay(true);
  syncLeaderboardOpenButton();
}

function showFailureOverlay() {
  const fastest = state.answerTimes.length ? Math.min(...state.answerTimes) : 0;
  const average = state.answerTimes.length
    ? state.answerTimes.reduce((sum, value) => sum + value, 0) / state.answerTimes.length
    : 0;

  els.overlayTitle.textContent = state.failReason;
  els.overlayCopy.textContent = "Run ended.";
  els.finalStreak.textContent = state.streak;
  els.finalPoints.textContent = state.points;
  els.finalBestStreak.textContent = state.bestStreak;
  els.finalBestPoints.textContent = state.bestPoints;
  els.finalFastest.textContent = `${fastest.toFixed(2)}s`;
  els.finalAverage.textContent = `${average.toFixed(2)}s`;
  els.missedLine.replaceChildren();
  const difficultyLine = document.createElement("div");
  difficultyLine.className = "missed-detail";
  difficultyLine.textContent = state.missedDifficultyScore;
  difficultyLine.style.color = state.missedDifficultyColor;
  const alertBlock = document.createElement("div");
  alertBlock.className = "missed-alert";
  if (state.missedInput) {
    const enteredLine = document.createElement("div");
    enteredLine.textContent = `You entered ${state.missedInput}`;
    const equationLine = document.createElement("div");
    equationLine.textContent = `Correct answer: ${state.missedEquation}`;
    alertBlock.append(enteredLine, equationLine);
    els.missedLine.append(difficultyLine, alertBlock);
  } else {
    const equationLine = document.createElement("div");
    equationLine.textContent = `Correct answer: ${state.missedEquation}`;
    alertBlock.append(equationLine);
    els.missedLine.append(difficultyLine, alertBlock);
  }
  els.resultGrid.hidden = false;
  els.missedLine.hidden = !state.missedEquation;
  els.startButton.textContent = "Restart";
  setOverlay(true);
  syncLeaderboardOpenButton();
}

function leaderboardSettingsAreDefault() {
  return (
    Number(state.settings.startTime.toFixed(1)) === LEADERBOARD_DEFAULTS.startTime &&
    Number(state.settings.timeMultiplier.toFixed(3)) === LEADERBOARD_DEFAULTS.timeMultiplier &&
    state.settings.operatorMode === LEADERBOARD_DEFAULTS.operatorMode
  );
}

function getLeaderboardRunPayload(username = "") {
  const payload = {
    p_streak: state.streak,
    p_score: state.points,
    p_starting_time_seconds: Number(state.settings.startTime.toFixed(1)),
    p_time_multiplier: Number(state.settings.timeMultiplier.toFixed(3)),
    p_operator_mode: state.settings.operatorMode,
  };
  if (username) {
    payload.p_username = username;
  }
  return payload;
}

function setLeaderboardStatus(message, hot = false) {
  els.leaderboardStatus.textContent = message;
  els.leaderboardStatus.hidden = !message;
  els.leaderboardStatus.classList.toggle("is-hot", hot);
}

function setLeaderboardPromptVisible(visible) {
  els.leaderboardOverlay.hidden = !visible;
  els.leaderboardSubmitButton.disabled = false;
  if (!visible) {
    els.leaderboardName.value = "";
  }
  syncLeaderboardOpenButton();
}

function syncLeaderboardOpenButton() {
  els.leaderboardOpenButton.hidden =
    !LEADERBOARD_BUTTON_ENABLED ||
    state.status === Status.RUNNING ||
    !els.leaderboardOverlay.hidden;
}

function openLeaderboardPrompt() {
  els.leaderboardSubmitForm.classList.remove("is-list-view", "is-expanding", "is-expanded");
  els.leaderboardEntry.hidden = false;
  els.leaderboardList.hidden = true;
  renderLeaderboardRows([]);
  syncLeaderboardRunStats();
  els.leaderboardTitle.textContent = "You made the all-time top 10!";
  setLeaderboardStatus("Claim your spot with a player ID!", false);
  setLeaderboardPromptVisible(true);
  launchLeaderboardConfetti();
  els.leaderboardName.focus({ preventScroll: true });
}

function closeLeaderboardPrompt() {
  setLeaderboardPromptVisible(false);
  els.leaderboardSubmitForm.classList.remove("is-list-view", "is-expanding", "is-expanded");
  els.leaderboardEntry.hidden = false;
  els.leaderboardList.hidden = true;
  renderLeaderboardRows([]);
}

function syncLeaderboardRunStats() {
  els.leaderboardRunStreak.textContent = els.finalStreak.textContent;
  els.leaderboardRunScore.textContent = els.finalPoints.textContent;
  els.leaderboardRunFastest.textContent = els.finalFastest.textContent;
  els.leaderboardRunAverage.textContent = els.finalAverage.textContent;
}

function formatLeaderboardId(id) {
  const value = String(id || "Player");
  if (value.length <= LEADERBOARD_ID_VISIBLE_CHARS) return value;
  return `${value.slice(0, LEADERBOARD_ID_VISIBLE_CHARS)}...`;
}

function createLeaderboardCrownIcon() {
  const svgNamespace = "http://www.w3.org/2000/svg";
  const crown = document.createElementNS(svgNamespace, "svg");
  crown.setAttribute("class", "leaderboard-crown-icon");
  crown.setAttribute("viewBox", "0 0 24 18");
  crown.setAttribute("role", "img");
  crown.setAttribute("aria-label", "Rank 1");

  const body = document.createElementNS(svgNamespace, "path");
  body.setAttribute("d", "M3 16h18L19.6 5.8 14.4 10 12 2 9.6 10 4.4 5.8 3 16Z");

  const base = document.createElementNS(svgNamespace, "path");
  base.setAttribute("d", "M5.2 16h13.6");
  base.setAttribute("class", "leaderboard-crown-base");

  crown.append(body, base);
  return crown;
}

function renderLeaderboardRows(rows = []) {
  els.leaderboardRows.replaceChildren();
  rows.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "leaderboard-list-row";
    const parsedRank = Number(entry.rank);
    const rankNumber = Number.isInteger(parsedRank) && parsedRank > 0 ? parsedRank : index + 1;
    if (rankNumber >= 1 && rankNumber <= 3) {
      row.classList.add("is-podium", `is-rank-${rankNumber}`);
    }

    const rank = document.createElement("strong");
    rank.className = "leaderboard-list-rank";
    if (rankNumber === 1) {
      rank.append(createLeaderboardCrownIcon());
    } else {
      rank.textContent = `#${rankNumber}`;
    }

    const id = document.createElement("span");
    id.className = "leaderboard-list-player";
    id.textContent = formatLeaderboardId(entry.id);
    id.title = String(entry.id || "Player");

    const score = document.createElement("strong");
    score.className = "leaderboard-list-score";
    score.textContent = entry.score;

    const streak = document.createElement("span");
    streak.className = "leaderboard-list-streak";
    streak.textContent = entry.streak;

    const time = document.createElement("span");
    time.className = "leaderboard-list-time";
    time.textContent = entry.time;
    time.title = entry.time;

    row.append(rank, id, score, streak, time);
    els.leaderboardRows.append(row);
  });
}

function renderLeaderboardLoadingRows() {
  els.leaderboardRows.replaceChildren();
  for (let index = 0; index < 2; index += 1) {
    const row = document.createElement("div");
    row.className = "leaderboard-list-row is-loading";

    const cell = document.createElement("span");
    cell.className = "leaderboard-loading-cell";
    row.append(cell);

    els.leaderboardRows.append(row);
  }
}

function showLeaderboardRows(rows = []) {
  els.leaderboardSubmitForm.classList.add("is-list-view");
  els.leaderboardEntry.hidden = true;
  els.leaderboardList.hidden = false;
  renderLeaderboardRows(rows);
  els.leaderboardTitle.textContent = "All-Time Leaderboard";
  setLeaderboardStatus("");
  if (els.leaderboardSubmitForm.classList.contains("is-expanding")) {
    requestAnimationFrame(() => {
      els.leaderboardSubmitForm.classList.add("is-expanded");
    });
  }
  els.leaderboardReturnButton.focus({ preventScroll: true });
}

async function openLeaderboardList() {
  state.pendingLeaderboardRun = null;
  els.leaderboardOpenButton.disabled = true;
  els.leaderboardSubmitForm.classList.add("is-list-view");
  els.leaderboardSubmitForm.classList.add("is-expanding");
  els.leaderboardSubmitForm.classList.remove("is-expanded");
  els.leaderboardTitle.textContent = "All-Time Leaderboard";
  els.leaderboardEntry.hidden = true;
  els.leaderboardList.hidden = false;
  renderLeaderboardLoadingRows();
  setLeaderboardStatus("Loading leaderboard...");
  setLeaderboardPromptVisible(true);

  if (!leaderboardClient) {
    els.leaderboardSubmitForm.classList.remove("is-expanding", "is-expanded");
    renderLeaderboardRows([]);
    setLeaderboardStatus("Leaderboard is not connected yet.", true);
    els.leaderboardOpenButton.disabled = false;
    els.leaderboardReturnButton.focus({ preventScroll: true });
    return;
  }

  const { data, error } = await leaderboardClient.rpc("get_leaderboard");
  els.leaderboardOpenButton.disabled = false;

  if (error) {
    console.error(error);
    els.leaderboardSubmitForm.classList.remove("is-expanding", "is-expanded");
    renderLeaderboardRows([]);
    setLeaderboardStatus("Leaderboard could not load.", true);
    els.leaderboardReturnButton.focus({ preventScroll: true });
    return;
  }

  showLeaderboardRows(data || []);
}

function launchLeaderboardConfetti() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const existingLayer = els.leaderboardOverlay.querySelector(".leaderboard-confetti-layer");
  if (existingLayer) {
    existingLayer.remove();
  }

  const layer = document.createElement("div");
  layer.className = "leaderboard-confetti-layer";
  const colors = ["#19d27f", "#ffcc00", "#ff3b30", "#f4f1e8", "#8debc0"];
  const particleCount = 96;

  for (let index = 0; index < particleCount; index += 1) {
    const piece = document.createElement("span");
    const size = randomInt(5, 10);
    const side = index % 4;
    const startX =
      side === 0 ? 50 + (Math.random() - 0.5) * 30 :
      side === 1 ? 50 + (Math.random() - 0.5) * 30 :
      side === 2 ? 28 + Math.random() * 10 :
      62 + Math.random() * 10;
    const startY =
      side === 0 ? 30 + Math.random() * 10 :
      side === 1 ? 60 + Math.random() * 10 :
      40 + Math.random() * 20;
    const pushFromCenter = startX < 50 ? -1 : 1;
    const drift = pushFromCenter * (70 + Math.random() * 220);
    const fall = side === 0 ? 160 + Math.random() * 260 : 90 + Math.random() * 210;
    const spin = (Math.random() - 0.5) * 920;
    const delay = Math.random() * 190;
    const duration = 1575 + Math.random() * 975;

    piece.className = `leaderboard-confetti${index % 5 === 0 ? " is-dot" : ""}`;
    piece.style.setProperty("--confetti-x", `${startX.toFixed(2)}%`);
    piece.style.setProperty("--confetti-y", `${startY.toFixed(2)}%`);
    piece.style.setProperty("--confetti-size", `${size}px`);
    piece.style.setProperty("--confetti-color", colors[index % colors.length]);
    piece.style.setProperty("--confetti-drift", `${drift.toFixed(2)}px`);
    piece.style.setProperty("--confetti-fall", `${fall.toFixed(2)}px`);
    piece.style.setProperty("--confetti-spin", `${spin.toFixed(2)}deg`);
    piece.style.setProperty("--confetti-delay", `${delay.toFixed(0)}ms`);
    piece.style.setProperty("--confetti-duration", `${duration.toFixed(0)}ms`);
    layer.append(piece);
  }

  els.leaderboardOverlay.prepend(layer);
  window.setTimeout(() => layer.remove(), 3300);
}

async function processLeaderboardRun() {
  state.pendingLeaderboardRun = null;
  closeLeaderboardPrompt();

  if (!leaderboardClient) {
    console.error("Leaderboard is not configured.");
    return;
  }

  if (!leaderboardSettingsAreDefault()) {
    return;
  }

  const payload = getLeaderboardRunPayload();
  const { data, error } = await leaderboardClient.rpc("qualifies_for_leaderboard", payload);
  if (error) {
    console.error("Leaderboard qualification failed", error);
    return;
  }

  if (!data) {
    setLeaderboardStatus("Score did not reach the global top 10.");
    return;
  }

  state.pendingLeaderboardRun = payload;
  openLeaderboardPrompt();
}

async function submitLeaderboardRun(event) {
  event.preventDefault();
  if (!state.pendingLeaderboardRun || !leaderboardClient) return;

  const username = els.leaderboardName.value.trim();
  if (!username) {
    els.leaderboardName.focus();
    return;
  }

  els.leaderboardSubmitButton.disabled = true;
  setLeaderboardStatus("Saving score.", true);

  const payload = {
    ...state.pendingLeaderboardRun,
    p_username: username,
  };
  const { data, error } = await leaderboardClient.rpc("submit_leaderboard_score", payload);

  if (error) {
    console.error("Leaderboard save failed", error);
    els.leaderboardSubmitButton.disabled = false;
    setLeaderboardStatus("Score could not be saved.");
    return;
  }

  state.pendingLeaderboardRun = null;
  showLeaderboardRows(data || []);
}

function keepFocus() {
  if (state.status === Status.RUNNING) {
    els.answerInput.focus({ preventScroll: true });
  }
}

function syncSettingsUI() {
  syncSliderSetting("startTime", state.settings.startTime);
  syncSliderSetting("timeMultiplier", state.settings.timeMultiplier);
  selectSetting("operatorMode", state.settings.operatorMode);
}

function syncSliderSetting(name, value) {
  const input = document.querySelector(`input[name="${name}"]`);
  if (!(input instanceof HTMLInputElement)) return;
  input.value = String(value);
  updateSettingReadout(name, value);
}

function selectSetting(name, value) {
  const inputs = document.querySelectorAll(`input[name="${name}"]`);
  inputs.forEach((input) => {
    input.checked = input.value === value;
  });
}

function formatSettingValue(name, value) {
  if (name === "startTime") {
    return `${value.toFixed(1)}s`;
  }
  if (name === "timeMultiplier") {
    return `${value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}x`;
  }
  return String(value);
}

function updateSettingReadout(name, value) {
  const output = document.getElementById(`${name}Value`);
  if (!(output instanceof HTMLOutputElement)) return;
  output.value = formatSettingValue(name, Number(value));
  output.textContent = output.value;
}

function updateSetting(name, value) {
  const nextValue =
    name === "startTime" || name === "timeMultiplier"
      ? normalizeNumericSetting(Number(value), SETTINGS[name])
      : value;
  state.settings = { ...state.settings, [name]: nextValue };
  writeSetting(STORAGE_KEYS[name], nextValue);
  if (name === "startTime" || name === "timeMultiplier") {
    syncSliderSetting(name, nextValue);
  }
  if (name === "startTime" && state.status !== Status.RUNNING) {
    state.duration = nextValue;
    render();
  }
}

els.answerInput.addEventListener("input", () => {
  els.answerInput.value = els.answerInput.value.replace(/\D+/g, "");
});

els.answerInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    submitAnswer();
  }
});

els.answerInput.addEventListener("blur", () => {
  window.setTimeout(keepFocus, 0);
});

els.startButton.addEventListener("click", startRun);
syncLeaderboardOpenButton();
els.leaderboardOpenButton.addEventListener("click", openLeaderboardList);
els.leaderboardSubmitForm.addEventListener("submit", submitLeaderboardRun);
els.leaderboardSkipButton.addEventListener("click", () => {
  state.pendingLeaderboardRun = null;
  closeLeaderboardPrompt();
});
els.leaderboardReturnButton.addEventListener("click", closeLeaderboardPrompt);

els.customizeSummary.addEventListener("click", (event) => {
  event.preventDefault();
  setCustomizeExpanded(!customizeExpanded);
});

els.customizePanel.addEventListener("transitionend", (event) => {
  if (event.target !== event.currentTarget.querySelector(".customize-body")) return;
  if (event.propertyName !== "grid-template-rows") return;
  if (!customizeExpanded) {
    els.customizePanel.open = false;
  }
});

els.customizePanel.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.name === "startTime" || target.name === "timeMultiplier" || target.name === "operatorMode") {
    updateSetting(target.name, target.value);
  }
});

els.customizePanel.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.name === "startTime" || target.name === "timeMultiplier") {
    updateSetting(target.name, target.value);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.leaderboardOverlay.hidden) {
    event.preventDefault();
    state.pendingLeaderboardRun = null;
    closeLeaderboardPrompt();
    return;
  }

  if (event.key === "Escape" && state.status === Status.RUNNING) {
    event.preventDefault();
    failRun("Abandoned");
    return;
  }

  if (event.key !== "Enter") return;
  if (!els.leaderboardOverlay.hidden) return;
  if (event.target === els.answerInput) return;
  if (event.target === els.leaderboardName) return;
  if (state.status === Status.IDLE || state.status === Status.FAILED) {
    event.preventDefault();
    startRun();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    keepFocus();
  }
});

function setCustomizeExpanded(expanded) {
  customizeExpanded = expanded;
  if (customizeAnimationFrame) {
    cancelAnimationFrame(customizeAnimationFrame);
    customizeAnimationFrame = 0;
  }

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    els.customizePanel.open = expanded;
    els.customizePanel.classList.toggle("is-expanded", expanded);
    return;
  }

  if (expanded) {
    els.customizePanel.open = true;
    customizeAnimationFrame = requestAnimationFrame(() => {
      customizeAnimationFrame = 0;
      els.customizePanel.classList.add("is-expanded");
    });
    return;
  }

  els.customizePanel.classList.remove("is-expanded");
}

syncSettingsUI();
render();
showIdleOverlay();
