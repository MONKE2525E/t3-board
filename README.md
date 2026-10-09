# T3 Board

A local companion that maps T3 Code agents to the AK820 Pro's Esc, F1–F12, and Delete lights.

This is a personal project by MONKE2525E. It is independent of T3 Code and AJAZZ and is not an official product or integration from either team.

Per-key colors and animations have been physically verified on the connected AK820 Pro. The app reads live T3 statuses and refreshes the keyboard ten times per second, including steady colors. The keyboard returns to its saved palette when realtime updates stop.

## Run

Requires Node 24 or newer and a wired AK820 Pro. Tested on Linux with Node 26 and T3 Code 0.0.46 nightly.

```sh
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:47831> and select **Start lighting**. Enable Simulation to try example agents without changing the keyboard. Release a finished agent's key to make space. Its next run can reclaim a key.

Live monitoring reads T3's local SQLite database in read-only mode every 750 milliseconds. By default, keys represent top-level T3 threads. Hidden delegated subagents do not take keys or inflate finished counts. Empty, settled, archived, and deleted threads are omitted, along with their subagent descendants. A cancelled queued message does not mask a turn that is still running. Fourteen assignments remain stable while the app runs. Extra agents wait for an available key.

Set `T3_BOARD_INCLUDE_SUBAGENTS=1` to include delegated agents too. In that mode, app-owned children count as separate threads and provider-native subagents from the current parent run count separately, without duplicating app-owned children.

A parent stays yellow while delegated background work or a monitor is pending, even after its chat turn finishes. Hidden children contribute to their parent's status without taking additional keys. Ordinary background commands and persistent tool registrations do not keep a finished agent yellow.

T3's built-in `watch_pull_request` also keeps the thread yellow between agent turns. Linking a PR alone does not. When T3 ends the watch, the key returns to its normal finished or merged status. Errors stay red, and pending input stays blue.

## Omarchy installation

Run `npm run build` and `npm run install:omarchy` from this checkout. The installer copies the app to `~/.local/share/t3-board`, installs its launcher, and enables `t3-board.service` at login. The installed service does not depend on the development worktree.

The keyboard icon in the top bar shows the number of working agents. Left-click opens the controls; right-click pauses or resumes lighting. Its tooltip includes finished agents, errors, key assignments, and connection status. Pausing is remembered across service restarts. When lighting is enabled, the app retries a disconnected keyboard every five seconds.

Use `t3-boardctl status`, `t3-boardctl start`, or `t3-boardctl stop` from a terminal. To stop automatic startup, run `systemctl --user disable --now t3-board.service`. The native bar widget remains visible and reports that the service is unavailable.

| Status               | Lighting                               |
| -------------------- | -------------------------------------- |
| Working              | Yellow, 3.2-second breath              |
| Drafting / just sent | Yellow, 0.32-second blink              |
| Finished             | Green, 1.1-second blink                |
| Error                | Red                                    |
| Linked PR merged     | Purple                                 |
| Needs input          | Deep blue                              |
| Idle agent           | Dim white                              |
| Unassigned agent key | Off                                    |
| Other keys           | Selected body effect, white by default |

Purple uses the merge state and timestamp in T3's linked PR snapshot. T3 must refresh that snapshot to notice an external merge. An older merge does not override a newer run. Failed runs remain red. Pending questions and approvals take priority over working or merged status and show deep blue until answered or cancelled.

## Body lighting

Choose the lighting for the keys below the agent row. Solid uses one custom color. Gradient blends two custom colors across the physical key positions. Wave moves that blend across the board, and Breathe slowly dims and brightens a two-color gradient. Rainbow moves a full spectrum across the board. Spectrum Cycle changes every body key's hue together. Chase sweeps a bright band through your color pair. Choose a horizontal, vertical, or diagonal direction for spatial effects. Rainbow and Spectrum Cycle use their own spectrum and hide the color controls. Animated effects have a speed from 0.25x to 3x, with an eight-second cycle at 1x.

Gradients hold each chosen color across a wider region, with a smooth transition through the middle. Blended colors retain their intensity. Wave adds a dark gap between its moving bands so similar colors still show clear motion. Breathe dims to 2.5% between peaks. The preview and keyboard use the same animation clock.

Effects respect the global brightness setting and persist across service restarts. White remains the default. The fourteen agent keys keep their status colors, and unassigned agent keys stay off. Body effects use the same realtime reports as agent animations and require lighting to be running. Stopping lighting restores the saved white-body baseline.

## Draft integration

The installed desktop integration tracks drafts automatically after T3 Code is quit and reopened through its normal launcher. It reads the current route and whether the visible composer contains unsent text, including new-thread drafts. Moving focus away from the composer keeps the reservation. Clearing the composer or switching threads releases it.

The bridge sends only the thread ID and draft presence events. Prompt text stays inside T3. It renews a four-second reservation every half second and reconnects after the board service restarts. Run status changes provide the fast yellow pulse when a message starts a new run. The manual **Copy draft bridge** remains available for a browser-based T3 session.

## Device access

`scripts/70-t3-board-ak820.rules` grants the active desktop user access to the two vendor HID interfaces for USB `0c45:8009`. It leaves keyboard input interfaces alone. On a system with udev and logind, install it in `/etc/udev/rules.d/`, reload udev rules, and reconnect the keyboard. Access was installed on the target machine during development.

Starting lighting selects custom mode and saves one baseline palette with the body white and the top row off. Status animations use realtime frames rather than repeatedly saving palettes. Stopping restores the baseline after the keyboard's realtime timeout. The baseline brightness is captured when connecting; reconnect to update its brightness. No firmware flashing, key remapping, or macro writes are used.

## Configuration and limits

- `T3_BOARD_PORT`: loopback HTTP port, default `47831`.
- `T3_BOARD_DB`: alternate T3 database path; default `~/.t3/userdata/statev2.sqlite`.
- `T3_BOARD_STATE`: private settings directory; default `~/.local/state/t3-board`.
- `T3_BOARD_DEMO=1`: start with simulation enabled.
- `T3_BOARD_INCLUDE_SUBAGENTS=1`: include hidden delegated agents; off by default.

The server binds to loopback. Device controls and composer events require a per-session token. Composer events accept T3's `t3code://app` and `t3code-dev://app` origins and loopback web previews. Cross-origin status reads and device controls are blocked. Brightness is saved locally. Key assignments currently reset on restart.

T3's database schema is an internal integration. A schema change pauses lighting and displays an error. Hardware transport currently targets the FF13 variant, not every keyboard sold as AK820 Pro. See [THIRD_PARTY.md](THIRD_PARTY.md) for protocol sources.

## Check

```sh
npm run check
npm run lint
npm test
npm run build
```

Tests cover assignment stability, overflow and release, draft expiry, new-run pulses, color timing, frame construction, SQLite lifecycle/PR interpretation, repeated steady frames, and rejection handling. Browser verification includes empty and populated previews, draft/send events, unauthorized API requests, and desktop/mobile layouts. Physical verification confirmed yellow breathing, both blink speeds, red, purple, unassigned top keys off, and the white body in a 60-second test using the app's driver.

## Open an assigned thread

Hold Super and press the key showing the agent's light. Super+F1 through
Super+F12 and Super+Delete open the assigned thread and focus T3 Code on its
desktop workspace. Super+backtick, the key directly below Esc, opens the Esc
agent. Super+Esc keeps Omarchy's system menu. An unassigned key does nothing.
Settled agents, simulation slots, and unsent new-agent placeholders cannot
open a thread.

After installation, quit T3 Code normally and reopen it through its launcher
once. The integration loads with the desktop app. It uses a private local
socket and the same thread IDs as the lights. The original packaged app is
loaded through a user-owned runtime; package files stay untouched. The runtime
refreshes its executable when the installed Nightly app updates. Navigation is
currently supported for `/opt/t3code-nightly-bin` on Omarchy.

Run `t3-boardctl jump F1` to exercise the same action from a terminal.

Desktop verification used an isolated Nightly instance with two synthetic
projects. Both socket requests opened their matching project and thread through
the app's router. The installed control was also checked against live light
assignments, including an unassigned-key no-op. Hyprland registered all fourteen
Super shortcuts without configuration errors. Physical shortcut input and the
desktop workspace focus transition require the normal app to be reopened and
were not exercised in the user's running instance.
