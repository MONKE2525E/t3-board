// The main process reads only route and draft presence. Composer text stays in T3.
function composerSnapshot() {
  const pathname =
    window.__TSR_ROUTER__?.state.location.pathname ??
    (location.hash.startsWith("#/")
      ? location.hash.slice(1)
      : location.pathname);
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const threadId = decodeURIComponent(parts[1]);
  if (!/^(?=.{1,160}$)(?:(?:thread|mcp):)?[a-zA-Z0-9_-]+$/.test(threadId))
    return null;
  const field = document.querySelector('[data-testid="composer-editor"]');
  if (!field) return null;
  return {
    id: parts[0] === "draft" ? `draft:${threadId}` : threadId,
    hasDraft: !!field.textContent?.trim(),
  };
}

function trackComposer(window, origin) {
  let token;
  let previous;
  let busy = false;
  let stopped = false;
  async function post(type, id) {
    if (!token) {
      const response = await fetch(`${origin}/api/session`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) throw new Error("T3 Board is unavailable.");
      token = (await response.json()).token;
    }
    const response = await fetch(`${origin}/api/bridge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ type, id }),
      signal: AbortSignal.timeout(2000),
    });
    if (response.status === 401) token = undefined;
    if (!response.ok) throw new Error("T3 Board rejected the composer event.");
  }
  async function tick() {
    if (busy || stopped || window.isDestroyed()) return;
    if (!window.webContents.getURL().startsWith("t3code://app/")) return;
    busy = true;
    try {
      const current = await window.webContents.executeJavaScript(
        `(${composerSnapshot.toString()})()`,
      );
      if (stopped) return;
      if (previous && (!current?.hasDraft || previous !== current.id)) {
        await post("clear", previous);
        previous = undefined;
      }
      if (current?.hasDraft) {
        await post("draft", current.id);
        previous = current.id;
      } else {
        await post("heartbeat", current?.id ?? "draft:new");
      }
    } catch {
      // T3 Board can restart independently. Retry without interrupting T3.
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(() => void tick(), 500);
  timer.unref();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
    if (previous) void post("clear", previous).catch(() => {});
  };
}
module.exports = { composerSnapshot, trackComposer };
