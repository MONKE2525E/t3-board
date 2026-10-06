import { STATUS_LABELS, type Slot } from "../src/model.ts";
import type { KeyboardState } from "../src/keyboard.ts";
import { KeyLight, isAnimated } from "./animation.ts";
import { BODY_KEYS, effectAnimated } from "../src/effects.ts";
import { averageColor, bodyColors } from "./body-effect.ts";
import { initBodyPanel } from "./body-panel.ts";
import {
  CASE,
  DISPLAY,
  INDICATORS,
  KEYS,
  KNOB,
  STATUS_KEYS,
  keyTitle,
  type KeyGeometry,
} from "./geometry.ts";

interface State {
  demo: boolean;
  brightness: number;
  slots: Slot[];
  overflow: number;
  keyboard: KeyboardState;
  source: { connected: boolean; error: string | null };
  bridge: { connected: boolean };
  /** Missing when the board service predates body lighting. */
  bodyEffect?: unknown;
}
type SlotStatus = Slot["status"];

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const create = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const setText = (node: Element, text: string) => {
  if (node.textContent !== text) node.textContent = text;
};
const rgbString = (rgb: readonly number[]) => rgb.join(" ");

let token = "";
let current: State | null = null;
let pending = false;
let disconnected = false;
let statusNotice: string | null = null;
let brightness = 0.55;
let editingBrightness = false;
let selected: number | null = null;
const motion = matchMedia("(prefers-reduced-motion: reduce)");

const stage = $("keyboard");
const SLOTS = STATUS_KEYS.length;
const lights = Array.from({ length: SLOTS }, () => new KeyLight());
const keyEls: HTMLElement[] = [];
const rowEls: HTMLElement[] = [];
const painted: string[] = Array.from({ length: SLOTS }, () => "");
const bodyEls: HTMLElement[] = [];
const bodyPainted: string[] = [];
let bodyAverage = "";
let bodySignature = "";

// Keyboard ---------------------------------------------------------------

function legendNode(key: KeyGeometry) {
  const node = create("span", "legend");
  if (key.legend.length === 2) {
    node.classList.add("dual");
    for (const line of key.legend) node.append(create("span", "", line));
  } else {
    const text = key.legend[0] ?? "";
    node.textContent = text;
    node.classList.add(text.length > 1 ? "word" : "glyph");
    if (key.w >= 1.5 && text.length > 1) node.classList.add("left");
  }
  return node;
}

function buildKey(key: KeyGeometry) {
  const status = key.slot !== null;
  const node = create(status ? "button" : "div", `key ${key.tier}`);
  node.style.cssText = `--x:${key.x};--y:${key.y};--w:${key.w};--d:${Math.round(key.x * 16 + key.y * 55)}ms`;
  node.dataset.led = String(key.led);
  node.append(create("i", "glow"), create("i", "skirt"), create("span", "cap"));
  node.lastElementChild!.append(legendNode(key));
  if (status) {
    const slot = key.slot!;
    node.classList.add("status", "free");
    node.style.setProperty("--c", "0 0 0");
    (node as HTMLButtonElement).type = "button";
    node.dataset.slot = String(slot);
    node.append(create("i", "ring"));
    node.addEventListener("click", () => select(slot));
    node.addEventListener("focus", () => select(slot));
    node.addEventListener("keydown", (event) =>
      navigate(event as KeyboardEvent, slot),
    );
    node.addEventListener("pointerenter", () => hot(slot));
    node.addEventListener("pointerleave", () => hot(null));
    keyEls[slot] = node;
  } else {
    node.setAttribute("aria-hidden", "true");
    const index = BODY_KEYS.findIndex((body) => body.led === key.led);
    if (index >= 0) bodyEls[index] = node;
  }
  return node;
}

function buildStage() {
  stage.style.aspectRatio = `${CASE.w} / ${CASE.h}`;
  const fragment = document.createDocumentFragment();
  fragment.append(create("div", "spill"), create("div", "case"));
  fragment.append(create("div", "plate"));
  for (const key of KEYS) fragment.append(buildKey(key));
  const knob = create("div", "knob");
  knob.style.cssText = `--x:${KNOB.x - KNOB.r};--y:${KNOB.y - KNOB.r};--s:${KNOB.r * 2}`;
  const display = create("div", "display");
  display.style.cssText = `--x:${DISPLAY.x};--y:${DISPLAY.y};--w:${DISPLAY.w};--h:${DISPLAY.h}`;
  fragment.append(knob, display);
  for (const dot of INDICATORS) {
    const node = create("i", "indicator");
    node.style.cssText = `--x:${dot.x};--y:${dot.y}`;
    fragment.append(node);
  }
  for (const node of fragment.querySelectorAll(
    ".knob, .display, .indicator, .case, .plate, .spill",
  ))
    node.setAttribute("aria-hidden", "true");
  stage.replaceChildren(fragment);
}

function navigate(event: KeyboardEvent, slot: number) {
  const step =
    event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (event.key === "Escape") {
    select(null);
    return;
  }
  const target =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? SLOTS - 1
        : step
          ? slot + step
          : -1;
  if (target < 0 || target >= SLOTS) return;
  event.preventDefault();
  keyEls[target]?.focus();
}

// Agent rows -------------------------------------------------------------

function buildRows() {
  const list = $("agents");
  STATUS_KEYS.forEach((key, slot) => {
    const row = create("div", "agent-row");
    row.setAttribute("role", "listitem");
    row.dataset.slot = String(slot);
    row.hidden = true;
    const chip = create("span", "status-chip");
    chip.append(create("i", "dot"), create("span", "label"));
    const main = create("div", "agent-main");
    main.append(create("span", "agent-title"), create("span", "project"));
    const release = create("button", "release", "Release");
    release.type = "button";
    release.onclick = () => void releaseSlot(slot);
    row.append(
      create("kbd", "row-key", keyTitle(key.name)),
      main,
      chip,
      release,
    );
    row.addEventListener("pointerenter", () => hot(slot));
    row.addEventListener("pointerleave", () => hot(null));
    row.addEventListener("focusin", () => hot(slot));
    row.addEventListener("focusout", () => hot(null));
    rowEls[slot] = row;
    list.append(row);
  });
}

function hot(slot: number | null) {
  keyEls.forEach((el, i) => el.classList.toggle("hot", i === slot));
  rowEls.forEach((el, i) => el.classList.toggle("hot", i === slot));
}

async function releaseSlot(slot: number) {
  await act("/api/release", { index: slot });
  keyEls[slot]?.focus({ preventScroll: true });
}

// Selection and inspector ---------------------------------------------------

function select(slot: number | null) {
  if (slot === selected) return;
  selected = slot;
  keyEls.forEach((el, i) => {
    el.classList.toggle("selected", i === slot);
    el.setAttribute("aria-pressed", String(i === slot));
  });
  const inspector = $("inspector");
  inspector.classList.remove("swap");
  void inspector.offsetWidth;
  inspector.classList.add("swap");
  if (current) renderInspector(current);
  paintLights();
}

function openHint(slot: Slot, demo: boolean) {
  const shortcut =
    slot.key === "Esc" ? "Super+backtick" : `Super+${keyTitle(slot.key)}`;
  if (demo) return `Example agent. ${shortcut} does not open simulation keys.`;
  if (slot.agent?.id.startsWith("draft:"))
    return `Unsent draft. ${shortcut} opens it once sent.`;
  return `${shortcut} opens this thread.`;
}

function renderInspector(s: State) {
  const slot = selected === null ? null : s.slots[selected];
  const inspector = $("inspector");
  const chip = $("inspect-status");
  const release = $("inspect-release");
  inspector.dataset.status = slot?.status ?? "unassigned";
  inspector.style.setProperty(
    "--c",
    (selected !== null && painted[selected]) || "0 0 0",
  );
  inspector.classList.toggle("empty", !slot);
  if (!slot) {
    setText($("inspect-key"), "·");
    setText($("inspect-title"), "Select a key on the top row");
    setText(
      $("inspect-detail"),
      "Lit keys carry an agent. Dark keys are free.",
    );
    chip.hidden = true;
    release.hidden = true;
    return;
  }
  setText($("inspect-key"), keyTitle(slot.key));
  if (slot.agent) {
    setText($("inspect-title"), slot.agent.title);
    setText(
      $("inspect-detail"),
      `${slot.agent.project} · ${openHint(slot, s.demo)}`,
    );
    setText($("inspect-status-label"), STATUS_LABELS[slot.status]);
    chip.hidden = false;
    release.hidden = false;
    release.setAttribute("aria-label", `Release ${keyTitle(slot.key)}`);
    release.onclick = () => void releaseSlot(selected!);
  } else {
    setText($("inspect-title"), `${keyTitle(slot.key)} is free`);
    setText(
      $("inspect-detail"),
      "The next agent to start takes the first free key.",
    );
    chip.hidden = true;
    release.hidden = true;
  }
}

// Live light animation ----------------------------------------------------

let frameId = 0;
let lastFrame = 0;
const FRAME_MS = 1000 / 30;

/** Paint the body keys. Skips the work when a still effect has not changed. */
function paintBody(reduced: boolean) {
  const effect = panel.effect();
  const animated = effectAnimated(effect) && !reduced;
  const signature = `${JSON.stringify(effect)}|${brightness}|${reduced}`;
  if (!animated && signature === bodySignature) return false;
  bodySignature = animated ? "" : signature;
  const colors = bodyColors(effect, Date.now(), brightness, reduced);
  colors.forEach((rgb, i) => {
    const color = rgbString(rgb);
    if (color === bodyPainted[i]) return;
    bodyPainted[i] = color;
    bodyEls[i]?.style.setProperty("--c", color);
  });
  const average = rgbString(averageColor(colors));
  if (average !== bodyAverage) {
    bodyAverage = average;
    stage.style.setProperty("--body", average);
  }
  return animated;
}

/** Paint every light once and report whether anything keeps moving. */
function paintLights(now = performance.now()) {
  const reduced = motion.matches;
  let moving = paintBody(reduced);
  lights.forEach((light, slot) => {
    const color = rgbString(light.update(now, brightness, reduced));
    if (color !== painted[slot]) {
      painted[slot] = color;
      keyEls[slot]?.style.setProperty("--c", color);
      rowEls[slot]?.style.setProperty("--c", color);
      if (slot === selected) $("inspector").style.setProperty("--c", color);
    }
    if (!reduced && (isAnimated(light.status) || light.fading(now)))
      moving = true;
  });
  return moving;
}

function loop(now: number) {
  frameId = 0;
  if (document.hidden) return;
  if (now - lastFrame >= FRAME_MS - 2) {
    lastFrame = now;
    if (!paintLights(now)) return;
  }
  frameId = requestAnimationFrame(loop);
}

function kick() {
  if (frameId || document.hidden) return;
  if (paintLights()) frameId = requestAnimationFrame(loop);
}

function applyBrightness(value: number) {
  brightness = value;
  kick();
}

document.addEventListener("visibilitychange", kick);
motion.addEventListener("change", () => {
  lights.forEach((light) => light.setStatus(light.status, 0, true));
  panel.setContext({ reduced: motion.matches });
  kick();
});

// Rendering ---------------------------------------------------------------

function notice(message: string | null, tone: "error" | "info" = "error") {
  const node = $("notice");
  node.hidden = !message;
  node.dataset.tone = tone;
  node.textContent = message;
}

const SUMMARY: [string, (s: SlotStatus) => boolean, string, string][] = [
  ["working", (s) => s === "working" || s === "drafting", "working", "working"],
  ["waiting", (s) => s === "waiting", "needs input", "need input"],
  ["done", (s) => s === "done", "finished", "finished"],
  ["error", (s) => s === "error", "error", "errors"],
  ["merged", (s) => s === "merged", "merged", "merged"],
  ["idle", (s) => s === "idle", "idle", "idle"],
];
let summaryKey = "";

function renderSummary(s: State, assigned: Slot[]) {
  const parts = SUMMARY.flatMap(([status, test, one, many]) => {
    const count = assigned.filter((slot) => test(slot.status)).length;
    return count
      ? [{ status, text: `${count} ${count === 1 ? one : many}` }]
      : [];
  });
  const key = JSON.stringify([s.demo, parts]);
  if (key === summaryKey) return;
  summaryKey = key;
  const summary = $("summary");
  summary.replaceChildren();
  if (s.demo) summary.append(create("span", "tag", "Simulation"));
  if (!parts.length)
    summary.append(create("span", "", "No agents on the keyboard"));
  for (const part of parts) {
    const item = create("span", "stat");
    item.dataset.status = part.status;
    item.append(create("i", "dot"), part.text);
    summary.append(item);
  }
}

function connectionText(s: State) {
  if (s.demo) return "Simulation, keyboard untouched";
  if (!s.source.connected) return "T3 status unavailable, lighting paused";
  if (s.keyboard.streaming) return "Sending lighting frames";
  if (s.keyboard.connected) return "Device connected, lighting stopped";
  return s.keyboard.perKeyVerified
    ? "Lighting stopped"
    : "Per-key lighting not verified";
}

function startHint(s: State) {
  if (s.demo) return "Simulation never writes to the keyboard.";
  if (!s.source.connected) return "Waiting for T3 Code status.";
  if (!s.keyboard.perKeyVerified)
    return "Per-key hardware control is not verified yet.";
  return "";
}

function renderKeys(s: State, now: number) {
  s.slots.forEach((slot, i) => {
    const el = keyEls[i];
    if (!el) return;
    const assigned = !!slot.agent;
    el.classList.toggle("free", !assigned);
    el.dataset.status = slot.status;
    const label = assigned
      ? `${keyTitle(slot.key)}, ${slot.agent!.title}, ${STATUS_LABELS[slot.status]}`
      : `${keyTitle(slot.key)}, free key`;
    if (el.getAttribute("aria-label") !== label) {
      el.setAttribute("aria-label", label);
      el.title = label;
    }
    lights[i]!.setStatus(slot.status as SlotStatus, now, motion.matches);

    const row = rowEls[i]!;
    row.hidden = !assigned;
    row.dataset.status = slot.status;
    if (slot.agent) {
      const title = row.querySelector(".agent-title")!;
      setText(title, slot.agent.title);
      (title as HTMLElement).title = slot.agent.title;
      setText(row.querySelector(".project")!, slot.agent.project);
      setText(row.querySelector(".label")!, STATUS_LABELS[slot.status]);
      row
        .querySelector(".release")!
        .setAttribute("aria-label", `Release ${keyTitle(slot.key)}`);
    }
  });
}

function render(s: State, fetchedAt = panel.revision()) {
  current = s;
  const now = performance.now();
  stage.dataset.stale = "false";
  ($("demo") as HTMLInputElement).checked = s.demo;
  panel.setContext({ demo: s.demo, streaming: s.keyboard.streaming });
  panel.sync(s.bodyEffect, fetchedAt);
  $("start").hidden = s.keyboard.streaming;
  $("stop").hidden = !s.keyboard.streaming;
  ($("start") as HTMLButtonElement).disabled =
    s.demo || !s.source.connected || !s.keyboard.perKeyVerified || pending;
  $("start").title = s.keyboard.perKeyVerified
    ? "Start agent status lighting"
    : "Per-key hardware control is not verified yet";
  const hint = startHint(s);
  setText($("start-hint"), hint);
  $("start-hint").hidden = !hint;
  const connection = $("connection");
  setText(connection, connectionText(s));
  const dot = $("connection-dot");
  dot.classList.toggle("on", s.keyboard.streaming);
  dot.classList.toggle("sim", s.demo);
  dot.classList.toggle("warn", !s.demo && !s.source.connected);

  const assigned = s.slots.filter((slot) => slot.agent);
  setText($("capacity"), `${assigned.length} of ${SLOTS} keys`);
  const overflow = $("overflow");
  setText(
    overflow,
    s.overflow
      ? `${s.overflow} ${s.overflow === 1 ? "agent is" : "agents are"} waiting for a key. Release a key to make room.`
      : "",
  );
  overflow.hidden = !s.overflow;
  $("empty").hidden = assigned.length > 0;
  renderSummary(s, assigned);
  renderKeys(s, now);
  renderInspector(s);

  if (!editingBrightness) {
    ($("brightness") as HTMLInputElement).value = String(
      Math.round(s.brightness * 100),
    );
    setText($("brightness-value"), `${Math.round(s.brightness * 100)}%`);
    if (s.brightness !== brightness) applyBrightness(s.brightness);
  }
  setText(
    $("source-status"),
    s.demo
      ? "Example agents · live monitoring paused"
      : s.source.connected
        ? "T3 Code connected · updates every 0.75s"
        : "T3 Code disconnected",
  );
  setText(
    $("bridge-status"),
    s.bridge.connected ? "Draft bridge connected" : "Draft bridge disconnected",
  );
  $("bridge-status").classList.toggle("on", s.bridge.connected);
  $("draft-test").hidden = !s.demo;
  $("send-test").hidden = !s.demo;
  const error = s.source.error ?? s.keyboard.error;
  if (error) {
    statusNotice = error;
    notice(error);
  } else if (statusNotice) {
    if ($("notice").textContent === statusNotice) notice(null);
    statusNotice = null;
  }
  kick();
}

// Actions -------------------------------------------------------------------

async function sessionToken() {
  const response = await fetch("/api/session", {
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error("T3 Board is reconnecting.");
  token = (await response.json()).token;
}

async function post(path: string, body: unknown = {}) {
  if (!token) await sessionToken();
  const send = () =>
    fetch(path, {
      method: "POST",
      signal: AbortSignal.timeout(6000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  let response = await send();
  // A service restart rotates the token. A rejected request has no side
  // effects, so refresh the session and retry that action once.
  if (response.status === 401) {
    await sessionToken();
    response = await send();
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error ?? `Request failed (${response.status}).`);
  return data;
}

async function act(path: string, body: unknown = {}) {
  if (pending) return;
  pending = true;
  notice(null);
  const fetchedAt = panel.revision();
  try {
    render(await post(path, body), fetchedAt);
  } catch (e) {
    notice(e instanceof Error ? e.message : "Action failed");
  } finally {
    pending = false;
  }
}

// Body lighting saves run beside act(), never through it, so a save during a
// brightness change or a poll is queued by the panel instead of dropped.
const panel = initBodyPanel({
  post,
  notice,
  changed: kick,
  saved: (state, fetchedAt) => render(state as State, fetchedAt),
});
panel.setContext({ reduced: motion.matches });

$("demo").onchange = () =>
  void act("/api/demo", { enabled: ($("demo") as HTMLInputElement).checked });
$("start").onclick = () => void act("/api/start");
$("stop").onclick = () => void act("/api/stop");
$("brightness").oninput = () => {
  editingBrightness = true;
  const value = Number(($("brightness") as HTMLInputElement).value);
  setText($("brightness-value"), `${value}%`);
  applyBrightness(value / 100);
};
$("brightness").onchange = async () => {
  await act("/api/brightness", {
    value: Number(($("brightness") as HTMLInputElement).value) / 100,
  });
  editingBrightness = false;
};
$("draft-test").onclick = () => void act("/api/draft-demo");
$("send-test").onclick = () => void act("/api/submit-demo");
$("bridge").onclick = async () => {
  try {
    const script = await (await fetch("/api/bridge-script")).text();
    await navigator.clipboard.writeText(script);
    notice(
      "Draft bridge copied. Run it in the T3 Code developer console.",
      "info",
    );
  } catch {
    notice(
      "Clipboard unavailable. Open /api/bridge-script to copy the bridge.",
    );
  }
};

async function poll() {
  if (!pending) {
    try {
      const fetchedAt = panel.revision();
      const response = await fetch("/api/state", {
        signal: AbortSignal.timeout(6000),
      });
      if (!response.ok) throw new Error();
      if (disconnected || !token) await sessionToken();
      if (disconnected) notice(null);
      disconnected = false;
      render(await response.json(), fetchedAt);
    } catch {
      disconnected = true;
      notice("T3 Board disconnected. Reconnecting…");
      stage.dataset.stale = "true";
      setText($("connection"), "Reconnecting…");
      $("connection-dot").className = "warn";
      if (current) ($("start") as HTMLButtonElement).disabled = true;
    }
  }
  setTimeout(() => void poll(), document.hidden ? 1000 : 250);
}

buildStage();
buildRows();
applyBrightness(brightness);
void poll();
