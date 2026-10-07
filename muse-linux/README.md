# Muse for Linux

An unofficial desktop client and Linux device companion for the official [Muse web app](https://muse.ai). Sign-in, chat, cloud tasks and account settings use Muse's web session. An eligible Muse account and an internet connection are required.

This is a Linux implementation of desktop features, not the macOS executable. Muse 6.0 for Mac is an ARM64 Swift/AppKit application with Apple frameworks and native authentication. Its bundled frontend cannot run independently of that host. No Mac executable, bundled frontend or credentials are included here.

## Run

```sh
chmod +x Muse-for-Linux-0.6.0-x86_64.AppImage
./Muse-for-Linux-0.6.0-x86_64.AppImage
```

Use `APPIMAGE_EXTRACT_AND_RUN=1` if FUSE is unavailable. The Debian package is an alternative where its runtime dependencies are available. After building, `npm run install:local` installs the AppImage and application launcher without root access.

The persistent profile is `$XDG_CONFIG_HOME/muse-linux`, normally `~/.config/muse-linux`. Updating the app preserves it. The client does not import credentials from another browser. Remote pages use Chromium sandboxing, context isolation and no Node integration.

Chat and desktop settings share one window. Open desktop settings with Ctrl+, or Settings in the application menu. Back to chat returns to the same conversation and draft without reloading it. The menu is available with Alt or F10. Configure each local capability as Ask every time, Always allow or Always deny. Stop ends owned local tasks and changes remembered Always allow policies back to Ask every time.

## Desktop features

Version 0.6 adds a direct browser and persistent accessibility execution layer. In desktop settings, connect Chrome through its local debugging permission and select one tab to use the existing signed-in session. Browser operations navigate directly, fill complete Unicode text, find DOM controls, handle frames and explicitly accept or dismiss dialogs. File selection requires the local filesystem grant. Connecting a tab shares that browser's website state, but does not move the host pointer or type into unrelated windows. Chrome connection permission applies to the current browser instance and may need enabling again after Chrome restarts.

Choose Separate desktop for a headless Cage session with private app profiles, accessibility buses, input and clipboard. Available apps depend on the installed files app and terminal. This mode does not copy authenticated profiles, expose a viewer or provide desktop workspaces. It requires compatible compositor libraries, Bubblewrap, D-Bus, AT-SPI and grim. The included compositor binaries were tested on Arch/Omarchy; separate-desktop compatibility on other distributions remains unverified. The host filesystem remains readable, so this is input isolation rather than a filesystem sandbox.

Every new browser or semantic action returns a durable receipt with dispatch, effect, method, latency and failures. An acknowledged click or launched process does not prove its goal succeeded. Text edits use independent full-value verification. Structured run results retain rejected actions, failed plan steps and the skipped suffix, with links to deeper trace detail. `computer.diagnose` performs a bounded read-only refresh and identifies stale or contradictory sources without retrying input. Uncertain same-intent actions cannot be repeated under a new invocation ID. Local Pause cancels pending input; Resume stays user-only.

The rewrite has owned Chrome and private Cage end-to-end tests. These fixture results do not establish that a real signed-in Amazon task succeeded. Local vision grounding, workflow replay, generic rich-text editing, connected Chrome pixel capture and a separate-desktop viewer remain unavailable.

- Computer use in Muse's own browser includes observations, clicking, typing, keys, scrolling, navigation, screenshots and approved file uploads. The browser has a separate persistent profile and refuses privileged URLs and device permissions. Sessions expire after ten minutes.
- Native application control uses AT-SPI accessibility, compositor keyboard input and a real Wayland pointer on Hyprland. Approved desktop sessions show Muse blue borders and an animated Muse pill on every monitor. The genuine logo sits beside the real cursor, with click feedback; it does not draw a second pointer. Move the physical mouse, press a key, or click Pause to take over. Pause releases owned input, invalidates observations, and reports an interruption to Muse. Only the user can Resume; no partial input is replayed. Stop ends access. If a disconnect or helper failure ends a paused session, remembered approvals return to Ask every time; fresh local approval is required before control can restart. Physical input detection requires readable Linux input devices; unavailable detection leaves control paused. Screenshots hide all owned indicators and wait for compositor presentation before capture. Coordinate input supports movement, clicks, double clicks, dragging and scrolling inside the freshly observed visible window. Stop, expiry, disconnect and quit remove the indicators and release input. Apps may be blocked in settings. Accessibility coverage depends on the toolkit. Whole-string typing also works in the focused field of a visible selected window without an accessible element number, using an owned Wayland virtual keyboard. This path focuses the selected window and rechecks its address and PID between text chunks; it does not use the clipboard. The native keyboard path refuses emoji and other supplementary Unicode before sending input because Chromium truncates them; accessible editable controls and Muse Local Browser support those characters. Keyboard aliases and chords are case-insensitive, including Enter/Return, Tab, Ctrl+Shift+P and Meta/Super/Win. The key action uses standard evdev positions, so configured compositor shortcuts run rather than being delivered only to the app. Shortcut effects must still be verified; an unconfigured Alt+F4 or Super+Q is not invented. desktop_context, list_workspaces and list_keybindings expose current monitor/workspace/focus state and configured bindings without shell arguments. close_window requests graceful compositor closing and reports whether the window remains, including possible unsaved-work prompts. Screenshots require the selected window to be visible and unobscured on an active monitor. Other compositors retain the companion browser.
- File access uses a chosen folder or an explicit filesystem grant. Text operations are limited to 256 KiB and binary transfers to 8 MiB. Symlinks and credential paths are refused. Writes use a separate policy; Trash is recoverable. Folder access can be remembered or expire on quit.
- Code execution supports one-shot executable argument arrays and persistent PTY terminals. Bash scripts, long-running jobs and interactive command-line tools run as the logged-in Linux user. The working directory grant is not a process sandbox. Code-execution permission therefore authorizes the process's normal user capabilities. Stop kills owned process groups.
- Claude Code sessions launch the installed `claude` CLI with its existing local login. Muse can read output, send input, interrupt and close its own sessions. Claude's normal tool permission prompts remain. This client does not sign in, disable Claude permissions or take over unrelated sessions.
- Dictation uses local whisper.cpp and a separately downloaded, hash-checked tiny model. Enable it, download the model, then start recording with the dictation button, settings or configured shortcut. Finish inserts text in the active Muse composer. Automatic sending is optional. Audio is processed locally and temporary recordings are removed.
- General settings include appearance, start at login and keeping the display awake during computer use. Keyboard shortcuts provide quick access and dictation toggle. Shortcut availability depends on desktop portal support and existing bindings.

Apple Mail, Notes, Messages, Calendar, Photos and other Apple connectors are unavailable. Ambient avatar, Apple's voice pipeline, background window capture and hold-to-talk event taps are not reproduced. Cloud integrations remain controlled by Muse.

Desktop features use the device protocol discovered in the supplied installer and the web frontend's internal connection. They are unofficial and can break when Meta changes that connection. Unsupported command IDs are omitted if the gateway rejects them. A brief connection interruption permits reconnection. A connection loss lasting 30 seconds, a rejected device registration or a renderer crash stops owned computer and code tasks. Web features update through Muse; desktop updates require a new package. The Mac Sparkle updater and Apple signing identity are not used.

The icon comes from the supplied Muse 6.0 installer and belongs to Meta. Muse is a Meta product. This project is not affiliated with Meta. MIT covers the new client code; whisper.cpp retains its bundled MIT license.

Computer input can use `computer.batch` (or `computer.control` with `action=batch`) for 1–16 ordered actions against one selected window. It returns one final observation and stops on the first error, target change, deadline, physical takeover, Pause or Stop. Completed input may already have taken effect: inspect the final observation rather than replaying a partial batch. Every ordinary action also returns a fresh observation ID, which can be used directly for the next action. Accessible buttons may be addressed by an exact unique label or numbered control. Native `list_apps` and `open_app` launch exact installed desktop entries through GIO. `open_app` brings an existing matching window to the current workspace or an explicit `workspace`; new launches wait briefly for a matching window and correct its placement. Check `workspace_verified` on launch receipts. A slow or unrecognized window remains unverified. `move_window` moves the freshly observed window to a workspace, with optional `follow="true"`. Standalone Super/Meta/Win, Ctrl, Shift and Alt taps are supported. Select the actual visible window before input. Tool wire fields use strings: encode arrays such as `argv`, `actions` and coordinates as JSON inside those strings.

## Build and verify

Use a recent Node.js version with `fs.globSync`, a Linux C compiler, pkg-config, AT-SPI, GLib, Wayland, Cairo, xkbcommon and JSON-GLib development packages, plus wayland-scanner. Building whisper.cpp also requires CMake, Ninja and a C++ compiler. Runtime native control requires Hyprland, `hyprctl`, `grim` and an accessible AT-SPI bus. Dictation requires PipeWire's `pw-record`. Claude Code is a separate installation.

```sh
npm ci
node node_modules/electron/install.js
npm run build:helpers
npm run check
npm run lint
npm test
npm run build
```

`dist/` contains the AppImage and Debian package. Helpers built on a newer distribution may require a newer glibc than older Debian releases; build on the oldest supported distribution for portable packages. The Whisper build uses an x86-64 CPU baseline with AVX2, FMA and F16C. The model is not embedded in the package.

Unset `ELECTRON_RUN_AS_NODE` before launching Electron. For isolated browser verification, use a separate `--user-data-dir=/tmp/muse-test-profile` and a loopback `--remote-debugging-port=PORT`, then:

```sh
node scripts/verify.cjs http://127.0.0.1:PORT /tmp/muse-verification
```

That script checks loading, absence of Node in the web page and a screenshot. It does not prove authenticated chat or local control. Verify actual chat replies, registered-device requests, file changes, terminal output and process exit status in disposable fixtures. Test the packaged executable after source tests. Never publish profiles, recordings, credentials or private chat screenshots. Normal installed launches should have no debugging port.

Pause blocks new local mutations and desktop input until the user resumes. It does not suspend cloud reasoning or already-running terminal/command jobs. Interruption is reported through the in-flight or next local tool response; there is no verified gateway API for freezing the remote Muse conversation.

Observations default to `detail="compact"`, capped at 12 KiB of JSON excluding image data. `detail="full"` is capped at 32 KiB. Original element numbers remain stable within the underlying observation. `more`, `next_offset`, `controls_total`, `returned` and `truncated` describe paging and omissions. Supply string `control_offset` and optional `control_limit` to read another page; each call observes again, so changes in the UI can change that page. Internal action lookup retains the full tree.

Image observations and `screen.snap` now compare freshly captured decoded pixels. Identical content within the same session and target returns `unchanged: true` and the previous `screenshot_id`, with no new image bytes. First, changed or forced captures return `unchanged: false` and a new image. `force_image="true"` always transfers pixels; use it after context compaction or a missing image reference. `computer.control` with `action="wait", view="image"` uses the same comparison. Fresh observation IDs and controls are still returned. This saves image transfers and model input, not capture work. Animated or blinking content counts as a change.

Plain numbered native left clicks prefer named AT-SPI `click`, `press` or `toggle` actions, without moving the pointer. Explicit coordinates, right clicks and double clicks remain physical. Pointer fallback is allowed only when no semantic action was attempted, with fresh target and accessibility bounds checks. Failed or uncertain actions are never repeated through the pointer. `perform_action` accepts an exact `action_name` from the observed control `actions` list. Entry `activate` or slider `jump` must be explicitly requested. Semantic actions do not require unobscured screen pixels. Blocked apps, identity, enabled/defunct control, Pause and Stop checks still apply. Physical input and pointer fallback retain obstruction checks. Results report `dispatch_path`, `route` and the actual `action_name`.

These patterns follow [computer-use-linux semantic actions](https://github.com/agent-sh/computer-use-linux) and [agent-browser screenshot reuse](https://github.com/vercel-labs/agent-browser/blob/main/skill-data/core/references/commands.md). The implementations here are original. Tree diffing, scoped reference invalidation, local vision grounding and workflow replay are later increments.

Covered windows still support named AT-SPI actions. An image request for a covered or off-workspace window returns fresh AX controls with `capture_status="unavailable"`, `unchanged=null` and `image_current=false`. Any `previous_image` is explicitly stale evidence, not a statement that hidden content is unchanged.

`computer.control action="compositor_key", key="Super+Shift+comma"` dispatches an actual configured Hyprland binding without selecting or focusing a window. The ordinary key action also uses this route for configured bindings. Unknown shortcuts and ordinary app keys require a fresh window observation. Blocked focused apps, permission, Pause and Stop still apply.

For notification cards and other foreign layer surfaces, use `list_layers`, then `computer.observe` or `screen.snap` with `surface="layer"`, exact `layer_namespace` and `monitor`. Layer screenshots show the visible output and redact blocked windows. The layer bounds can cover transparent space; locate the card visually before input. Right-click uses `computer.control` with `surface="layer"`, a fresh `observation_id`, `action="click"`, `button="right"`, and `coordinate="[x,y]"`. Coordinates are normalized 0–1000 inside the selected layer bounds, not raw screen pixels. `x`, `y`, `position` and `coordinates` are not supported. Results report `dispatch_path="coordinate"`, `route="layer_pointer"` and whether the layer remains; inspect a fresh screenshot to verify the particular card disappeared. A notification service may keep its full-screen surface after dismissing a card.
