import {
  DEFAULT_BODY_EFFECT,
  effectAnimated,
  effectSpectrum,
  validateBodyEffect,
  type BodyEffect,
} from "../src/effects.ts";
import {
  DIRECTIONS,
  LatestSaver,
  MODES,
  PRESETS,
  clampSpeed,
  normalizeHex,
  sameEffect,
  speedText,
} from "./body-effect.ts";

export interface BodyPanelDeps {
  /** Authorized POST that returns the new state. */
  post(path: string, body: unknown): Promise<{ bodyEffect?: unknown }>;
  notice(message: string | null): void;
  /** The preview needs a repaint. */
  changed(): void;
  /** A save returned a fresh state. */
  saved(state: { bodyEffect?: unknown }, fetchedAt: number): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

/** Ignore server state this long after the last local edit. */
const EDIT_QUIET_MS = 1500;

function read(value: unknown): BodyEffect | null {
  try {
    return validateBodyEffect(value);
  } catch {
    return null;
  }
}

/**
 * Body lighting controls. The local effect is the source of truth for the
 * preview and updates on every input. Saves go through a latest-value queue,
 * and server state never overwrites the controls while an edit is pending.
 */
export function initBodyPanel(deps: BodyPanelDeps) {
  let effect: BodyEffect = { ...DEFAULT_BODY_EFFECT };
  let confirmed: BodyEffect = { ...DEFAULT_BODY_EFFECT };
  let revision = 0;
  let lastEdit = Number.NEGATIVE_INFINITY;
  let ready = false;
  let stateTimer: ReturnType<typeof setTimeout> | undefined;
  let errorNotice: string | null = null;
  let context = { demo: false, streaming: false, reduced: false };

  const group = $<HTMLFieldSetElement>("body-controls");
  const colorInputs = [
    $<HTMLInputElement>("color-a"),
    $<HTMLInputElement>("color-b"),
  ];
  const hexInputs = [
    $<HTMLInputElement>("hex-a"),
    $<HTMLInputElement>("hex-b"),
  ];
  const speed = $<HTMLInputElement>("body-speed");
  const presetButtons: HTMLButtonElement[] = [];

  const saver = new LatestSaver<BodyEffect, { bodyEffect?: unknown }>({
    send: (value) => deps.post("/api/body-effect", value),
    onSaved(state, sent, newer) {
      confirmed = read(state.bodyEffect) ?? sent;
      revision++;
      // A save that works makes the earlier failure message stale.
      if (
        errorNotice &&
        document.getElementById("notice")?.textContent === errorNotice
      )
        deps.notice(null);
      errorNotice = null;
      if (!newer) setState("saved");
      deps.saved(state, revision);
    },
    onError(error) {
      effect = confirmed;
      revision++;
      renderControls();
      deps.changed();
      setState("error");
      const reason =
        error instanceof TypeError
          ? "T3 Board did not respond."
          : error instanceof Error
            ? error.message
            : "The request failed.";
      errorNotice = `Body lighting was not saved. ${reason} Showing the last saved lighting.`;
      deps.notice(errorNotice);
    },
  });

  // Build static pieces ---------------------------------------------------

  const segment = (
    name: string,
    value: string,
    content: (Node | string)[],
    onPick: () => void,
  ) => {
    const label = document.createElement("label");
    label.className = "seg";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = value;
    input.addEventListener("change", () => input.checked && onPick());
    const text = document.createElement("span");
    text.className = "seg-face";
    text.append(...content);
    label.append(input, text);
    return { label, input };
  };
  const modeInputs = MODES.map((mode) => {
    const { label, input } = segment("body-mode", mode.id, [mode.label], () =>
      edit({ mode: mode.id }, true),
    );
    $("body-mode").append(label);
    return input;
  });
  const ARROW =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg>';
  const directionInputs = DIRECTIONS.map((direction) => {
    const icon = document.createElement("span");
    icon.className = "arrow";
    icon.innerHTML = ARROW;
    icon.style.rotate = `${direction.angle}deg`;
    const { label, input } = segment(
      "body-direction",
      direction.id,
      [icon, direction.label],
      () => edit({ direction: direction.id }, true),
    );
    $("body-direction").append(label);
    return input;
  });

  for (const preset of PRESETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "preset";
    button.style.setProperty("--a", preset.a);
    button.style.setProperty("--b", preset.b);
    button.dataset.a = preset.a;
    button.dataset.b = preset.b;
    const swatch = document.createElement("i");
    swatch.setAttribute("aria-hidden", "true");
    button.append(swatch, preset.name);
    button.setAttribute(
      "aria-label",
      `${preset.name}, ${preset.a} to ${preset.b}`,
    );
    button.addEventListener("click", () =>
      edit(
        {
          colorA: preset.a,
          colorB: preset.b,
          mode: effect.mode === "solid" ? "gradient" : effect.mode,
        },
        true,
      ),
    );
    presetButtons.push(button);
  }
  $("body-presets").replaceChildren(...presetButtons);

  // Editing -----------------------------------------------------------------

  function edit(patch: Partial<BodyEffect>, immediate: boolean) {
    const next = { ...effect, ...patch };
    if (sameEffect(next, effect)) {
      // A drag that ends where it started still needs its queued save sent.
      if (immediate && saver.busy) void saver.flushNow();
      return;
    }
    effect = next;
    revision++;
    lastEdit = performance.now();
    renderControls();
    deps.changed();
    setState("saving");
    saver.push(effect, immediate);
  }

  const colorPatch = (i: number, color: string): Partial<BodyEffect> =>
    i === 0 ? { colorA: color } : { colorB: color };
  colorInputs.forEach((input, i) => {
    input.addEventListener("input", () =>
      edit(colorPatch(i, input.value), false),
    );
    input.addEventListener("change", () =>
      edit(colorPatch(i, input.value), true),
    );
  });
  hexInputs.forEach((input, i) => {
    const key = i === 0 ? "colorA" : "colorB";
    input.addEventListener("input", () => {
      const hex = normalizeHex(input.value);
      input.setAttribute("aria-invalid", String(hex === null));
      if (hex) edit(colorPatch(i, hex), true);
    });
    // Leaving the field with a partial value puts the real one back.
    input.addEventListener("blur", () => {
      input.setAttribute("aria-invalid", "false");
      input.value = effect[key];
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
    });
  });
  speed.addEventListener("input", () =>
    edit({ speed: clampSpeed(Number(speed.value)) }, false),
  );
  speed.addEventListener("change", () =>
    edit({ speed: clampSpeed(Number(speed.value)) }, true),
  );
  $("body-swap").addEventListener("click", () =>
    edit({ colorA: effect.colorB, colorB: effect.colorA }, true),
  );
  $("body-reset").addEventListener("click", () =>
    edit({ ...DEFAULT_BODY_EFFECT }, true),
  );
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && saver.busy) void saver.flushNow();
  });

  // Rendering ---------------------------------------------------------------

  function setState(kind: "saving" | "saved" | "error" | "") {
    clearTimeout(stateTimer);
    const node = $("body-state");
    node.dataset.kind = kind;
    node.textContent =
      kind === "saving"
        ? "Saving…"
        : kind === "saved"
          ? "Saved"
          : kind === "error"
            ? "Not saved"
            : "";
    $("body-live").textContent =
      kind === "saved"
        ? "Body lighting saved"
        : kind === "error"
          ? "Body lighting not saved"
          : "";
    if (kind === "saved")
      stateTimer = setTimeout(() => {
        if (node.dataset.kind === "saved") setState("");
      }, 1600);
  }

  const setValue = (input: HTMLInputElement, value: string) => {
    if (input.value !== value) input.value = value;
  };

  function renderControls() {
    const solid = effect.mode === "solid";
    const animated = effectAnimated(effect);
    const spectrum = effectSpectrum(effect);
    for (const input of modeInputs) input.checked = input.value === effect.mode;
    setText(
      $("mode-note"),
      MODES.find((mode) => mode.id === effect.mode)?.note ?? "",
    );
    for (const input of directionInputs)
      input.checked = input.value === effect.direction;
    $("field-direction").hidden = solid || effect.mode === "spectrum";
    $("field-speed").hidden = !animated;
    $("body-colors").hidden = spectrum;
    $("color-b-field").hidden = solid;
    $("body-swap").hidden = solid;
    setText($("color-a-name"), solid ? "Color" : "First color");
    $("body-presets-note").hidden = !solid;

    const colors = [effect.colorA, effect.colorB];
    colorInputs.forEach((input, i) => setValue(input, colors[i]!));
    // Never rewrite a hex field while someone is typing in it.
    hexInputs.forEach((input, i) => {
      if (document.activeElement !== input) setValue(input, colors[i]!);
    });
    setValue(speed, String(effect.speed));
    setText($("body-speed-value"), speedText(effect.speed));
    for (const button of presetButtons) {
      const on =
        !solid &&
        button.dataset.a === effect.colorA &&
        button.dataset.b === effect.colorB;
      button.setAttribute("aria-pressed", String(on));
    }
    $("body-summary").style.setProperty("--a", effect.colorA);
    $("body-summary").classList.toggle("spectrum", spectrum);
    $("body-summary").style.setProperty(
      "--b",
      solid ? effect.colorA : effect.colorB,
    );
    renderNote();
  }

  function renderNote() {
    const parts: string[] = [];
    if (context.reduced && effectAnimated(effect))
      parts.push(
        "Reduced motion holds this preview still. The keyboard still animates.",
      );
    if (context.demo) parts.push("Simulation never writes to the keyboard.");
    else if (!context.streaming)
      parts.push("Shown on the keyboard once lighting starts.");
    setText($("body-hint"), parts.join(" "));
  }

  function setText(node: Element, text: string) {
    if (node.textContent !== text) node.textContent = text;
  }

  renderControls();

  return {
    effect: () => effect,
    revision: () => revision,
    setContext(next: Partial<typeof context>) {
      context = { ...context, ...next };
      renderNote();
    },
    /**
     * Take the server's effect unless the user is editing or the response is
     * older than a local change.
     */
    sync(value: unknown, fetchedAt: number) {
      const server = read(value);
      if (!ready) {
        ready = true;
        group.disabled = false;
        if (server) {
          confirmed = server;
          effect = server;
          renderControls();
          deps.changed();
        }
        return;
      }
      if (
        !server ||
        fetchedAt !== revision ||
        saver.busy ||
        performance.now() - lastEdit < EDIT_QUIET_MS
      )
        return;
      confirmed = server;
      if (sameEffect(server, effect)) return;
      effect = server;
      renderControls();
      deps.changed();
    },
  };
}
