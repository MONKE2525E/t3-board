// Physical layout of the AJAZZ AK820 Pro (ANSI, 81 keys) for the preview.
// Measured from the manufacturer's top-down product photo. Units are key
// pitches (1u) from the case's top-left corner. LED addresses match
// src/model.ts LAYOUT, which also lists an "End" LED (122) that has no cap on
// this board, so it is not drawn here.

export interface KeyGeometry {
  /** Matches the label in src/model.ts LAYOUT, which is also the API key name. */
  name: string;
  /** Printed legend, top to bottom. */
  legend: readonly string[];
  led: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Index into the 14 agent slots when this key carries a status. */
  slot: number | null;
  tier: "alpha" | "mod" | "arrow";
}

export const CASE = { w: 17.13, h: 7.1 } as const;
// Position of the first key (Esc) inside the case.
const ORIGIN = { x: 0.33, y: 0.35 } as const;
export const ROW_Y = [0, 1.25, 2.25, 3.25, 4.25, 5.25] as const;
// The right-hand column (Home, PgUp, PgDn, display) sits past the main block.
const SIDE_X = 15.45;
// Arrows sit a quarter key lower than their rows and are inset from the edge.
const ARROW_DROP = 0.25;

export const KNOB = {
  x: ORIGIN.x + 15.95,
  y: ORIGIN.y + 0.34,
  r: 0.6,
} as const;
export const DISPLAY = {
  x: ORIGIN.x + SIDE_X,
  y: ORIGIN.y + 4.4,
  w: 1,
  h: 1,
} as const;
export const INDICATORS = [1.95, 2.6, 3.25].map((y) => ({
  x: ORIGIN.x + 15.22,
  y: ORIGIN.y + y,
}));

type Spec = readonly [name: string, legend: string, w?: number];
const STATUS_NAMES = [
  "Esc",
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  "Del",
];

const keys: KeyGeometry[] = [];
function place(
  led: number,
  [name, legend, w = 1]: Spec,
  x: number,
  y: number,
  tier: KeyGeometry["tier"] = "alpha",
) {
  const slot = STATUS_NAMES.indexOf(name);
  keys.push({
    name,
    legend: legend.split("\n"),
    led,
    x: ORIGIN.x + x,
    y: ORIGIN.y + y,
    w,
    h: 1,
    slot: slot < 0 ? null : slot,
    tier,
  });
}
// Lay out a run of keys left to right and return the x after the last one.
function run(
  leds: readonly number[],
  specs: readonly Spec[],
  x: number,
  y: number,
  tier: (spec: Spec) => KeyGeometry["tier"],
) {
  specs.forEach((spec, i) => {
    place(leds[i]!, spec, x, y, tier(spec));
    x += spec[2] ?? 1;
  });
  return x;
}
const range = (start: number, count: number) =>
  Array.from({ length: count }, (_, i) => start + i);
const wide = (spec: Spec) => ((spec[2] ?? 1) === 1 ? "alpha" : "mod");
const single = (c: string): Spec => [c, c];

// Function row: Esc, F1-F4, F5-F8, F9-F12 and Delete, grouped by quarter-key gaps.
place(1, ["Esc", "Esc"], 0, ROW_Y[0], "mod");
[
  [1.25, 2],
  [5.5, 6],
  [9.75, 10],
].forEach(([x, led], group) =>
  run(
    range(led!, 4),
    range(group * 4 + 1, 4).map((n): Spec => [`F${n}`, `F${n}`]),
    x!,
    ROW_Y[0],
    () => "alpha",
  ),
);
place(119, ["Del", "Delete"], 14, ROW_Y[0], "mod");

// Number row.
run(
  [...range(19, 13), 103],
  [
    ["`", "~\n`"],
    ["1", "!\n1"],
    ["2", "@\n2"],
    ["3", "#\n3"],
    ["4", "$\n4"],
    ["5", "%\n5"],
    ["6", "^\n6"],
    ["7", "&\n7"],
    ["8", "*\n8"],
    ["9", "(\n9"],
    ["0", ")\n0"],
    ["−", "_\n-"],
    ["=", "+\n="],
    ["Back", "Backspace", 2],
  ],
  0,
  ROW_Y[1],
  wide,
);
place(117, ["Home", "Home"], SIDE_X, ROW_Y[1], "mod");

// Tab row.
run(
  [...range(37, 13), 67],
  [
    ["Tab", "Tab", 1.5],
    ...[..."QWERTYUIOP"].map(single),
    ["[", "{\n["],
    ["]", "}\n]"],
    ["\\", "|\n\\", 1.5],
  ],
  0,
  ROW_Y[2],
  wide,
);
place(118, ["PgUp", "PgUp"], SIDE_X, ROW_Y[2], "mod");

// Home row.
run(
  [...range(55, 12), 85],
  [
    ["Caps", "Caps Lock", 1.75],
    ...[..."ASDFGHJKL"].map(single),
    [";", ":\n;"],
    ["'", "\"\n'"],
    ["Enter", "Enter", 2.25],
  ],
  0,
  ROW_Y[3],
  wide,
);
place(121, ["PgDn", "PgDn"], SIDE_X, ROW_Y[3], "mod");

// Shift row.
run(
  [...range(73, 12)],
  [
    ["Shift", "Shift", 2.25],
    ...[..."ZXCVBNM"].map(single),
    [",", "<\n,"],
    [".", ">\n."],
    ["/", "?\n/"],
    ["Shift", "Shift", 1.75],
  ],
  0,
  ROW_Y[4],
  wide,
);
place(101, ["↑", "↑"], 14.2, ROW_Y[4] + ARROW_DROP, "arrow");

// Bottom row. The space bar is 6.25u.
run(
  [91, 92, 93, 94, 95, 96, 98],
  [
    ["Ctrl", "Ctrl", 1.25],
    ["Win", "Win", 1.25],
    ["Alt", "Alt", 1.25],
    ["Space", "", 6.25],
    ["Alt", "Alt"],
    ["Fn", "Fn"],
    ["Ctrl", "Ctrl"],
  ],
  0,
  ROW_Y[5],
  () => "mod",
);
[
  [99, "←", 13.2],
  [100, "↓", 14.2],
  [102, "→", 15.2],
].forEach(([led, glyph, x]) =>
  place(
    led as number,
    [glyph as string, glyph as string],
    x as number,
    ROW_Y[5] + ARROW_DROP,
    "arrow",
  ),
);

export const KEYS: readonly KeyGeometry[] = keys;
export const STATUS_KEYS = KEYS.filter((key) => key.slot !== null).sort(
  (a, b) => a.slot! - b.slot!,
);

export const STATUS_KEY_LABELS: Record<string, string> = { Del: "Delete" };
/** Key name as a person would say it. */
export const keyTitle = (name: string) => STATUS_KEY_LABELS[name] ?? name;
