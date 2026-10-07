# Third-party components and source references

Muse for Linux is an unofficial client. Muse names, artwork and the hosted service belong to their respective owners. This project does not grant rights to those assets or imply affiliation.

The computer-use rewrite contains original CommonJS and C implementations using public CDP, Wayland and AT-SPI APIs. Source research informed the design. It does not incorporate the private Codex computer-use runtime or legacy Open Interpreter AGPL code.

| Design reference | Inspected revision | License | Pattern used |
| --- | --- | --- | --- |
| OpenHands SDK | `608a102c637d8d8a999f49d7b04846524bd8bd1c` | MIT | Causal action/observation records and resource ownership |
| browser-use | `914c59bdd4acd50e9628a97a96a3919313aebc85` | MIT | Evidence separation and navigation guards |
| Stagehand | `fdd179582b6b1f9e43c3d18ad27917cf2e66631e` | MIT | Shared deadlines and bounded progress |
| Playwright | `d469960fdfc461e2d5795a3fa48a58a52a91ecaf` | Apache-2.0 | Live actionability checks, direct filling and frame targeting |
| Chrome DevTools MCP | `5ddb0a3110c5059f8e5513e566196cce2a35c6d1` | Apache-2.0 | Consent-based connection to a running Chrome session |
| Codex | `5a3140176e668a2f72f3c098490eb7f7052d9d85` | Apache-2.0 | Separate tool results, evidence and diagnostic logs |

These are idea and API references, not copied implementations. Any later code copy must retain its source license, copyright, applicable NOTICE and modification notices.

Electron and its included Chromium/Node dependencies retain their upstream licenses and notices in the distribution. The existing whisper.cpp and Wayland protocol components retain their license files beside the native resources. The native accessibility worker dynamically links the system AT-SPI and GLib libraries, which retain their own LGPL terms. System libraries are not relicensed by this project's MIT license.

The Chrome connection uses `ws` 8.22.0 under the MIT license. Its copyright and license are included in `node_modules/ws/LICENSE` in the packaged application. The Node WebSocket client omits the browser Origin header and keeps Chrome's own connection approval in force.

The optional headless runtime uses Cage, wlroots and libliftoff under their MIT licenses. When their binaries are included, their unmodified license files and a package provenance manifest accompany them under `native/isolation/`. The runtime also requires compatible system libraries, Bubblewrap, D-Bus, the AT-SPI registry and grim. Bubblewrap is an external LGPL component. An independent compositor isolates input, focus and clipboard; it does not by itself establish filesystem confidentiality.

The browser adapter does not copy cookies or profiles. Chrome and any browser installed by the user remain separate products with their own terms. Connecting to an authenticated tab preserves shared browser and website state; it does not create an isolated account session.
