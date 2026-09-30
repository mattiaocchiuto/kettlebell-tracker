const app = document.getElementById("app");
let PROGRAM = null; // built from kettlebell-sessions.json by buildProgram()

/* ---------- program (kettlebell-sessions.json) ---------- */
const firstNum = s => { const m = String(s || "").match(/\d+/); return m ? Number(m[0]) : null; };

// "8", "2/side", "30 m/side", "30 s/side"
function parseReps(s) {
  const m = String(s).trim().match(/^(\d+)\s*(m|s)?\s*(\/side)?$/i);
  if (!m) return { n: firstNum(s) || 0, unit: null, perSide: /side/i.test(s) };
  return { n: Number(m[1]), unit: m[2] ? m[2].toLowerCase() : null, perSide: !!m[3] };
}

function buildProgram(j) {
  const phases = j.phases.map(p => {
    const kg = firstNum(p.load); // default bell for the phase, adjustable per set
    const sessions = {};
    for (const [key, list] of Object.entries(p.sessions || {})) {
      sessions[key] = {
        title: `Session ${key}`,
        exercises: list.map(it => {
          const def = j.exercises[it.exercise] || { name: it.exercise, cue: "" };
          const r = parseReps(it.reps);
          const timed = r.unit === "s";
          return {
            id: it.exercise, name: def.name, cue: def.cue || "", note: it.note || "",
            sets: it.sets, rest: it.rest_s ?? 60, perSide: r.perSide,
            kind: timed ? "time" : "reps", hold: timed ? r.n : undefined,
            reps: timed ? undefined : r.n, unit: timed ? null : r.unit, kg: timed ? null : kg,
          };
        }),
      };
    }
    return { id: p.id, label: p.label, status: p.status, load: p.load || "", note: p.note || "", sessions };
  });
  return { meta: j.meta || {}, rules: j.rules || {}, warmup: j.warmup || null, phases };
}

/* ---------- storage ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};

let settings = { phase: null, sound: true, vibrate: true, ...store.get("kb.settings", {}) };
let history = store.get("kb.history", []);
let run = store.get("kb.run", null);      // active session, survives refresh
let view = "home";
let overviewKey = null;

const saveSettings = () => store.set("kb.settings", settings);
const saveRun = () => run ? store.set("kb.run", run) : store.del("kb.run");
const saveHistory = () => store.set("kb.history", history);

/* ---------- program helpers ---------- */
const phaseInfo = id => PROGRAM.phases.find(p => p.id === id);
const currentSessions = () => phaseInfo(settings.phase).sessions;
const STATUS = { done: "done", current: "current", next: "next", upcoming: "upcoming" };

function buildSteps(session) {
  const steps = [];
  session.exercises.forEach((ex, exIdx) => {
    for (let set = 1; set <= ex.sets; set++) {
      const sides = ex.perSide ? ["Left", "Right"] : [null];
      sides.forEach((side, si) => steps.push({ exIdx, set, side, lastOfSet: si === sides.length - 1 }));
    }
  });
  return steps;
}

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;
const fmtDate = t => new Date(t).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

function targetText(ex) {
  if (ex.kind === "time") return `${ex.hold} s`;
  return `${ex.reps}${ex.unit ? " " + ex.unit : " reps"}`;
}
function setSummary(ex) {
  const per = ex.perSide ? "/side" : "";
  return ex.kind === "time" ? `${ex.sets} × ${ex.hold} s${per}` : `${ex.sets} × ${ex.reps}${ex.unit ? " " + ex.unit : ""}${per}`;
}

/* ---------- last-used load ---------- */
function lastKg(ex) {
  if (ex.kg == null) return null;
  if (run) {
    for (let i = run.log.length - 1; i >= 0; i--) if (run.log[i].ex === ex.name && run.log[i].kg != null) return run.log[i].kg;
  }
  for (let i = history.length - 1; i >= 0; i--) {
    const hit = [...history[i].sets].reverse().find(s => s.ex === ex.name && s.kg != null);
    if (hit) return hit.kg;
  }
  return ex.kg;
}

/* ---------- audio / vibration / wake lock ---------- */
let audioCtx = null;
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) {}
}
function beep(freq = 880, dur = 0.15, delay = 0) {
  if (!settings.sound || !audioCtx) return;
  try {
    const t = audioCtx.currentTime + delay;
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = freq; o.connect(g); g.connect(audioCtx.destination);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.02);
  } catch (e) {}
}
function buzz(pattern) { if (settings.vibrate && navigator.vibrate) navigator.vibrate(pattern); }
function alertDone() { beep(880, 0.15); beep(880, 0.15, 0.22); beep(1175, 0.35, 0.44); buzz([200, 100, 200, 100, 400]); }

let wakeLock = null;
async function acquireWake() {
  try { if ("wakeLock" in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); } } catch (e) {}
}
function releaseWake() { try { wakeLock && wakeLock.release(); } catch (e) {} wakeLock = null; }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && run && !run.finished) acquireWake(); });

/* ---------- session flow ---------- */
function startSession(key) {
  unlockAudio();
  const hasWarmup = !!(PROGRAM.warmup && PROGRAM.warmup.items.length);
  run = { key, phase: settings.phase, startedAt: Date.now(), stage: hasWarmup ? "warmup" : "work", warmDone: {},
    i: 0, log: [], restEndAt: null, restTotal: 0, holdEndAt: null, finished: false, cur: null };
  acquireWake();
  if (hasWarmup) { view = "warmup"; saveRun(); render(); } else beginWork();
}

function beginWork() {
  run.stage = "work";
  prepStep();
  view = "exercise";
  saveRun(); render();
}

const runSession = () => phaseInfo(run.phase).sessions[run.key];
const runSteps = () => buildSteps(runSession());

function prepStep() {
  const step = runSteps()[run.i];
  const ex = runSession().exercises[step.exIdx];
  run.cur = { kg: lastKg(ex), reps: ex.kind === "time" ? ex.hold : ex.reps };
  run.holdEndAt = null;
}

function completeStep() {
  const steps = runSteps();
  const step = steps[run.i];
  const ex = runSession().exercises[step.exIdx];
  run.log.push({ ex: ex.name, set: step.set, side: step.side, kg: run.cur.kg, reps: run.cur.reps, unit: ex.kind === "time" ? "s" : (ex.unit || "reps") });
  run.holdEndAt = null;

  if (run.i >= steps.length - 1) {
    run.finished = true; run.endedAt = Date.now();
    view = "summary"; releaseWake();
    beep(1175, 0.4); buzz([300]);
  } else {
    run.i++;
    if (step.lastOfSet) {
      run.restTotal = ex.rest;
      run.restEndAt = Date.now() + ex.rest * 1000;
      view = "rest";
      announce(`Rest ${ex.rest} seconds`);
    }
    prepStep();
  }
  saveRun(); render();
}

function endRest(silent) {
  run.restEndAt = null; view = "exercise";
  if (!silent) alertDone();
  saveRun(); render();
  announce("Rest over");
}

function backStep() {
  if (!run || run.i === 0 || !run.log.length) return;
  run.log.pop(); run.i--; run.restEndAt = null; view = "exercise";
  const last = run.log[run.log.length - 1];
  prepStep();
  saveRun(); render();
}

function finishEarly() {
  if (!run) return;
  if (!run.log.length) return discardRun();
  run.finished = true; run.endedAt = Date.now(); view = "summary"; releaseWake();
  saveRun(); render();
}
function discardRun() { run = null; saveRun(); releaseWake(); view = "home"; render(); }

function saveSummary() {
  const note = (document.getElementById("note") || {}).value || "";
  history.push({
    id: run.startedAt, date: run.startedAt, key: run.key, title: runSession().title, phase: run.phase,
    durationSec: Math.round(((run.endedAt || Date.now()) - run.startedAt) / 1000),
    sets: run.log, note: note.trim(),
  });
  saveHistory();
  run = null; saveRun(); view = "home"; render();
}

/* ---------- views ---------- */
const CHEVRON = `<svg class="chev" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const workSets = s => s.exercises.reduce((a, e) => a + e.sets * (e.perSide ? 2 : 1), 0);

function viewHome() {
  const p = phaseInfo(settings.phase);
  const sessions = currentSessions();
  const keys = Object.keys(sessions);
  const mine = history.filter(h => h.phase === settings.phase);
  const lastKey = mine.length ? mine[mine.length - 1].key : null;
  const upNext = keys.length > 1 && lastKey && keys.includes(lastKey) ? keys[(keys.indexOf(lastKey) + 1) % keys.length] : keys[0];
  const last = key => { const h = [...history].reverse().find(x => x.key === key && x.phase === settings.phase); return h ? `Last done ${fmtDate(h.date)}` : "Not done yet"; };
  const len = PROGRAM.meta.session_length_min;
  return `
    <div class="top"><span class="kicker">${esc(PROGRAM.meta.title || "Kettlebell block")}</span><button class="link" data-act="go" data-v="settings">Settings</button></div>
    <h1>Kettlebell Coach</h1>
    <span class="phase-chip">${esc(p.label)} · ${STATUS[p.status] || ""}</span>
    ${p.note ? `<div class="warn">${esc(p.note)}</div>` : ""}
    <h2>Choose a session</h2>
    ${keys.map(k => { const s = sessions[k]; return `
      <button class="card tap" data-act="overview" data-k="${k}">
        <div class="card-main">
          <div class="t">${esc(s.title)}${keys.length > 1 && k === upNext ? ` <span class="badge">Up next</span>` : ""}</div>
          <div class="dim">${esc(s.exercises.map(e => e.name).join(" · "))}</div>
          <div class="meta">${s.exercises.length} exercises · ${workSets(s)} sets${len ? ` · ${esc(len)} min` : ""} · ${last(k)}</div>
        </div>${CHEVRON}
      </button>`; }).join("")}
    <div class="grow"></div>
    <button class="btn" data-act="go" data-v="history">History (${history.length})</button>`;
}

function viewOverview() {
  const p = phaseInfo(settings.phase);
  const s = p.sessions[overviewKey];
  const stops = PROGRAM.rules.stop_and_reassess || [];
  const len = PROGRAM.meta.session_length_min;
  return `
    <div class="top"><button class="link" data-act="go" data-v="home">‹ Back</button></div>
    <h1>${esc(s.title)}</h1>
    <p class="dim" style="margin-top:0">${workSets(s)} work sets${len ? ` · ${esc(len)} min` : ""}${p.load ? ` · ${esc(p.load)}` : ""}</p>
    ${s.exercises.map((e, i) => `
      <div class="ex-row"><div class="n mono">${i + 1}</div><div>
        <div class="m">${esc(e.name)}</div>
        <div class="s mono">${esc(setSummary(e))} · rest ${e.rest}s</div>
        ${e.note ? `<div class="s"><strong>${esc(e.note)}</strong></div>` : ""}
        <div class="s">${esc(e.cue)}</div></div></div>`).join("")}
    ${stops.length ? `<h2>Stop and reassess if</h2>
      <div class="notes"><ul>${stops.map(t => `<li>${esc(t)}</li>`).join("")}</ul>
      ${PROGRAM.rules.progression ? `<p><strong>Progression:</strong> ${esc(PROGRAM.rules.progression)}</p>` : ""}</div>` : ""}
    <div class="grow"></div>
    <div class="dock"><button class="btn primary big" data-act="start" data-k="${overviewKey}">Start session</button></div>`;
}

function viewWarmup() {
  const w = PROGRAM.warmup;
  const done = run.warmDone;
  const n = w.items.filter(it => done[it.id]).length;
  return `
    <div class="top"><span class="kicker">Warm-up · ~${w.duration_min} min</span><button class="link danger" data-act="discard">Cancel</button></div>
    <h1>${esc(runSession().title)}</h1>
    <p class="dim" style="margin-top:0">Tap each move as you finish it (${n}/${w.items.length}).</p>
    ${w.items.map(it => `
      <label class="opt check${done[it.id] ? " is-done" : ""}">
        <span>${esc(it.name)} <span class="dim mono">· ${esc(it.reps)}</span></span>
        <input type="checkbox" data-act="wtoggle" data-id="${esc(it.id)}" ${done[it.id] ? "checked" : ""}>
      </label>`).join("")}
    <div class="grow"></div>
    <div class="dock"><button class="btn primary big" data-act="work">${n === w.items.length ? "Start first exercise" : "Start exercises"}</button>
    ${n < w.items.length ? `<div class="next-up">Skip whatever you haven't done.</div>` : ""}</div>`;
}

function progressInfo() {
  const steps = runSteps();
  return { steps, pct: Math.round((run.i / steps.length) * 100) };
}

const barHtml = pct => `<div class="bar" role="progressbar" aria-label="Session progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>`;
const topHtml = canUndo => `<div class="top"><button class="link" data-act="back" ${canUndo ? "" : "disabled"}>‹ Undo last</button><button class="link danger" data-act="end">End session</button></div>`;

function viewExercise() {
  const { steps, pct } = progressInfo();
  const step = steps[run.i];
  const session = runSession();
  const ex = session.exercises[step.exIdx];
  const nextStep = steps[run.i + 1];
  const nextTxt = nextStep
    ? (nextStep.exIdx !== step.exIdx ? `Next: ${session.exercises[nextStep.exIdx].name}` : nextStep.side ? `Next: ${nextStep.side} side` : `Next: set ${nextStep.set}`)
    : "Last one!";
  const timed = ex.kind === "time";
  const inc = timed || ex.unit ? 5 : 1;
  const dots = Array.from({ length: ex.sets }, (_, k) => `<i class="dot${k + 1 < step.set ? " done" : k + 1 === step.set ? " cur" : ""}"></i>`).join("");
  const firstOfEx = step.set === 1 && (!step.side || step.side === "Left");
  const repsLabel = timed ? "Seconds held" : ex.unit === "m" ? "Distance (m)" : "Reps done";
  return `
    ${topHtml(run.i > 0)}
    ${barHtml(pct)}
    <div class="kicker">Exercise ${step.exIdx + 1} of ${session.exercises.length}</div>
    <div class="ex-name">${esc(ex.name)}</div>
    <div class="dots-row"><div class="dots" aria-hidden="true">${dots}</div><span class="setline">Set ${step.set} of ${ex.sets}</span></div>
    ${step.side ? `<div class="side-banner ${step.side.toLowerCase()}"><span>${step.side.toUpperCase()} SIDE</span><span>${step.side === "Left" ? "then right" : "last side"}</span></div>` : ""}
    <div class="target">${esc(targetText(ex))}</div>
    ${ex.note ? `<div class="exnote">${esc(ex.note)}</div>` : ""}
    ${timed ? `<div class="hold mono" id="hold" role="timer" aria-label="Hold time remaining">${holdText()}</div>
      <button class="btn" style="margin-bottom:1rem" data-act="hold">${run.holdEndAt ? "Stop hold" : "Start hold"}</button>` : ""}
    <div class="steppers">
      ${ex.kg != null ? `<div class="stepper" role="group" aria-label="Load in kilograms"><div class="l">Load (kg)</div><output class="v" id="v-kg" aria-live="polite">${run.cur.kg}</output>
        <div class="b"><button data-act="adj" data-f="kg" data-d="-2" aria-label="Decrease load by 2 kilograms">−</button><button data-act="adj" data-f="kg" data-d="2" aria-label="Increase load by 2 kilograms">+</button></div></div>` : ""}
      <div class="stepper${ex.kg == null ? " wide" : ""}" role="group" aria-label="${repsLabel}"><div class="l">${repsLabel}</div><output class="v" id="v-reps" aria-live="polite">${run.cur.reps}</output>
        <div class="b"><button data-act="adj" data-f="reps" data-d="-${inc}" aria-label="Decrease by ${inc}">−</button><button data-act="adj" data-f="reps" data-d="${inc}" aria-label="Increase by ${inc}">+</button></div></div>
    </div>
    ${ex.cue ? `<details class="cuebox"${firstOfEx ? " open" : ""}><summary>Form cue</summary><p>${esc(ex.cue)}</p></details>` : ""}
    <div class="grow"></div>
    <div class="dock"><button class="btn primary big" data-act="done">${step.side === "Left" ? "Done — switch side" : "Done set"}</button>
    <div class="next-up">${esc(nextTxt)}${step.lastOfSet && nextStep ? ` · rest ${ex.rest}s` : ""}</div></div>`;
}

function holdText() {
  const ex = runSession().exercises[runSteps()[run.i].exIdx];
  if (!run.holdEndAt) return fmtTime(ex.hold);
  return fmtTime(Math.max(0, Math.ceil((run.holdEndAt - Date.now()) / 1000)));
}

const RING = 2 * Math.PI * 90;
function viewRest() {
  const { steps, pct } = progressInfo();
  const step = steps[run.i];
  const session = runSession();
  const ex = session.exercises[step.exIdx];
  const same = steps[run.i - 1].exIdx === step.exIdx;
  return `
    ${topHtml(true)}
    ${barHtml(pct)}
    <div class="center"><div class="kicker">Rest</div></div>
    <div class="ring-wrap" role="timer" aria-label="Rest time remaining">
      <svg viewBox="0 0 200 200" aria-hidden="true"><circle class="bg" cx="100" cy="100" r="90" fill="none" stroke-width="10"/>
        <circle class="fg" id="ring" cx="100" cy="100" r="90" fill="none" stroke-width="10" stroke-linecap="round" stroke-dasharray="${RING}" stroke-dashoffset="0"/></svg>
      <div class="num mono" id="rt">${fmtTime(remaining())}</div>
    </div>
    <button class="btn" data-act="plus">+15 s rest</button>
    <div class="card" style="margin-top:1.2rem"><div class="kicker">Up next</div>
      <div class="t">${esc(ex.name)}</div>
      <div class="dim">${same ? `Set ${step.set} of ${ex.sets}` : "New exercise"}${step.side ? ` · ${step.side} side` : ""} · ${esc(targetText(ex))}${run.cur.kg != null ? ` · ${run.cur.kg} kg` : ""}</div>
      ${ex.note ? `<div class="exnote" style="margin-top:.4rem">${esc(ex.note)}</div>` : ""}
      ${ex.cue && !same ? `<details class="cuebox" style="margin:.7rem 0 0"><summary>Form cue</summary><p>${esc(ex.cue)}</p></details>` : ""}</div>
    <div class="grow"></div>
    <div class="dock"><button class="btn primary big" data-act="skip">Skip rest</button></div>`;
}
const remaining = () => Math.max(0, Math.ceil((run.restEndAt - Date.now()) / 1000));

function viewSummary() {
  const dur = Math.round(((run.endedAt || Date.now()) - run.startedAt) / 1000);
  const vol = run.log.reduce((a, s) => a + (s.kg && s.unit === "reps" ? s.kg * s.reps : 0), 0);
  return `
    <div class="kicker">Session complete</div>
    <h1>${esc(runSession().title)} done</h1>
    <div class="stat"><div><b>${fmtTime(dur)}</b><span>Time</span></div><div><b>${run.log.length}</b><span>Sets</span></div><div><b>${vol}</b><span>kg × reps</span></div></div>
    <h2 style="margin-top:.5rem"><label for="note">Notes</label></h2>
    <textarea id="note" placeholder="How did it feel? Any lower-back or get-up issues?"></textarea>
    <div class="grow"></div>
    <div class="dock"><button class="btn primary big" data-act="save">Save to history</button>
    <button class="link danger" style="width:100%;justify-content:center" data-act="discard">Discard</button></div>`;
}

function viewHistory() {
  const list = [...history].reverse();
  return `
    <div class="top"><button class="link" data-act="go" data-v="home">‹ Back</button></div>
    <h1>History</h1>
    ${list.length ? list.map(h => `
      <details class="card"><summary><div class="t">${esc(h.title)} <span class="dim" style="font-weight:400">· ${fmtDate(h.date)}</span></div>
        <div class="dim" style="font-size:.9rem">${fmtTime(h.durationSec)} · ${h.sets.length} sets</div></summary>
        <div class="log">${h.sets.map(s => `${esc(s.ex)} · set ${s.set}${s.side ? " " + s.side[0] : ""} — ${s.kg != null ? s.kg + " kg × " : ""}${s.reps} ${esc(s.unit || "")}`).join("<br>")}
        ${h.note ? `<br><em>“${esc(h.note)}”</em>` : ""}</div>
        <button class="link danger" data-act="delhist" data-id="${h.id}">Delete</button></details>`).join("")
      : `<p class="dim">No sessions logged yet.</p>`}`;
}

function viewSettings() {
  return `
    <div class="top"><button class="link" data-act="go" data-v="home">‹ Back</button></div>
    <h1>Settings</h1>
    <div class="opt"><span>Current phase</span><select id="phase">${PROGRAM.phases.map(p => `<option value="${p.id}" ${p.id === settings.phase ? "selected" : ""}>${esc(p.label)} (${STATUS[p.status] || ""})</option>`).join("")}</select></div>
    <div class="opt"><span>Sound</span><input type="checkbox" id="sound" ${settings.sound ? "checked" : ""}></div>
    <div class="opt"><span>Vibration</span><input type="checkbox" id="vibrate" ${settings.vibrate ? "checked" : ""}></div>
    <h2>Data</h2>
    <div class="row"><button class="btn small" data-act="export">Export JSON</button>
      <label class="btn small" style="margin:0">Import<input type="file" id="import" accept="application/json" hidden></label></div>
    <p class="dim" style="font-size:.875rem">Everything is stored on this device only. Export regularly to back it up.</p>`;
}

/* ---------- render / events ---------- */
let lastScreen = null;
function render() {
  const views = { home: viewHome, overview: viewOverview, warmup: viewWarmup, exercise: viewExercise, rest: viewRest, summary: viewSummary, history: viewHistory, settings: viewSettings };
  app.innerHTML = views[view]();
  window.scrollTo(0, 0);
  // On a new screen (or the next set) move focus to the heading so screen readers announce it.
  const screen = `${view}:${run ? run.i : ""}`;
  if (screen !== lastScreen) {
    lastScreen = screen;
    const h = app.querySelector(".ex-name, h1, .kicker");
    if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  }
}

const live = document.getElementById("live");
function announce(msg) { if (live) { live.textContent = ""; setTimeout(() => { live.textContent = msg; }, 50); } }

app.addEventListener("click", e => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const d = el.dataset;
  switch (d.act) {
    case "go": view = d.v; render(); break;
    case "overview": overviewKey = d.k; view = "overview"; render(); break;
    case "start": startSession(d.k); break;
    case "work": beginWork(); break;
    case "wtoggle": {
      const y = window.scrollY; run.warmDone[d.id] = el.checked; saveRun(); render(); window.scrollTo(0, y);
      const again = app.querySelector(`input[data-id="${CSS.escape(d.id)}"]`); if (again) again.focus({ preventScroll: true });
      break;
    }
    case "done": completeStep(); break;
    case "back": backStep(); break;
    case "skip": endRest(true); break;
    case "plus": run.restEndAt += 15000; run.restTotal += 15; saveRun(); tick(); break;
    case "adj": {
      const min = d.f === "kg" ? 0 : 0;
      run.cur[d.f] = Math.max(min, run.cur[d.f] + Number(d.d));
      document.getElementById(d.f === "kg" ? "v-kg" : "v-reps").textContent = run.cur[d.f];
      saveRun(); break;
    }
    case "hold":
      unlockAudio();
      if (run.holdEndAt) { run.holdEndAt = null; }
      else { const ex = runSession().exercises[runSteps()[run.i].exIdx]; run.holdEndAt = Date.now() + ex.hold * 1000; run.cur.reps = ex.hold; }
      saveRun(); render(); break;
    case "end":
      if (confirm("End this session?")) finishEarly();
      break;
    case "save": saveSummary(); break;
    case "discard": if (confirm("Discard this session without saving?")) discardRun(); break;
    case "delhist":
      if (confirm("Delete this session from history?")) { history = history.filter(h => String(h.id) !== d.id); saveHistory(); render(); }
      break;
    case "export": {
      const blob = new Blob([JSON.stringify({ settings, history }, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = `kettlebell-${new Date().toISOString().slice(0, 10)}.json`; a.click();
      break;
    }
  }
});

app.addEventListener("change", e => {
  if (e.target.id === "phase") { settings.phase = e.target.value; saveSettings(); }
  else if (e.target.id === "sound") { settings.sound = e.target.checked; saveSettings(); unlockAudio(); beep(660, 0.12); }
  else if (e.target.id === "vibrate") { settings.vibrate = e.target.checked; saveSettings(); buzz(80); }
  else if (e.target.id === "import") {
    const f = e.target.files[0]; if (!f) return;
    f.text().then(t => {
      const data = JSON.parse(t);
      if (Array.isArray(data.history)) { history = data.history; saveHistory(); }
      if (data.settings) { settings = { ...settings, ...data.settings }; saveSettings(); }
      render();
    }).catch(() => alert("Could not read that file."));
  }
});

/* ---------- timer tick (timestamp based, safe when the screen locks) ---------- */
let lastWhole = null;
function tick() {
  if (!run || run.finished) return;
  if (view === "rest" && run.restEndAt) {
    const left = remaining();
    const rt = document.getElementById("rt"), ring = document.getElementById("ring");
    if (rt) rt.textContent = fmtTime(left);
    if (ring) ring.setAttribute("stroke-dashoffset", String(RING * (1 - left / run.restTotal)));
    if (left <= 3 && left > 0 && left !== lastWhole) { beep(660, 0.08); buzz(40); }
    lastWhole = left;
    if (left <= 0) endRest(false);
  } else if (view === "exercise" && run.holdEndAt) {
    const left = Math.ceil((run.holdEndAt - Date.now()) / 1000);
    const h = document.getElementById("hold");
    if (h) h.textContent = fmtTime(Math.max(0, left));
    if (left <= 3 && left > 0 && left !== lastWhole) beep(660, 0.08);
    lastWhole = left;
    if (left <= 0) { run.holdEndAt = null; alertDone(); saveRun(); render(); announce("Hold complete"); }
  }
}
setInterval(tick, 250);

async function init() {
  try {
    const res = await fetch("kettlebell-sessions.json", { cache: "no-cache" });
    PROGRAM = buildProgram(await res.json());
  } catch (e) {
    app.innerHTML = `<h1>Kettlebell Coach</h1><div class="warn">Could not load kettlebell-sessions.json. Open the app through a web server (not file://) and check the JSON is valid.</div>`;
    return;
  }

  // Phase: keep the saved one if it still exists, otherwise the phase marked "current".
  if (!phaseInfo(settings.phase)) {
    settings.phase = (PROGRAM.phases.find(p => p.status === "current") || PROGRAM.phases[0]).id;
    saveSettings();
  }
  // Drop a saved session that no longer matches the program.
  if (run && !(phaseInfo(run.phase) && phaseInfo(run.phase).sessions[run.key])) { run = null; saveRun(); }

  if (run) {
    view = run.finished ? "summary" : run.stage === "warmup" ? "warmup" : run.restEndAt ? "rest" : "exercise";
    // A rest that expired while the app was closed: drop straight to the exercise.
    if (view === "rest" && run.restEndAt <= Date.now()) { run.restEndAt = null; view = "exercise"; saveRun(); }
    if (!run.finished) acquireWake();
  }
  render();
}

init();

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
