// Run once in T3 Code's developer console. No prompt text is sent or stored.
(() => {
  window.__t3BoardStop?.();
  const endpoint = "__BOARD_ORIGIN__/api/bridge";
  const token = "__BOARD_TOKEN__";
  let previous = "";
  let typed = false;
  let suppressedUntil = 0;
  const id = () => {
    const pathname =
      window.__TSR_ROUTER__?.state.location.pathname ??
      (location.hash.startsWith("#/")
        ? location.hash.slice(1)
        : location.pathname);
    const parts = pathname.split("/").filter(Boolean);
    return parts[0] === "draft"
      ? `draft:${parts[1] ?? "new"}`
      : parts.length === 2
        ? decodeURIComponent(parts[1])
        : "draft:new";
  };
  const post = (type, thread = id()) =>
    fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ type, id: thread }),
    }).catch(() => {});
  const editor = () =>
    document.querySelector('[data-testid="composer-editor"]');
  const send = () => {
    if (!typed) return;
    post("submitted");
    typed = false;
    suppressedUntil = Date.now() + 1500;
  };
  const onKey = (e) => {
    if (
      e.target.closest?.('[data-testid="composer-editor"]') &&
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.isComposing
    )
      send();
  };
  const onClick = (e) => {
    const b = e.target.closest?.("button");
    if (
      b &&
      !b.disabled &&
      ((b.type === "submit" &&
        b.closest("form")?.querySelector('[data-testid="composer-editor"]')) ||
        /^(send|submit|queue|steer)( message)?$/i.test(
          b.getAttribute("aria-label") ?? b.title ?? "",
        ))
    )
      send();
  };
  const timer = setInterval(() => {
    const thread = id();
    if (previous && previous !== thread) {
      post("clear", previous);
      typed = false;
    }
    previous = thread;
    // Examine draft presence only; never serialize the composer's text.
    const field = editor();
    const hasDraft = !!field?.textContent?.trim();
    if (hasDraft && Date.now() > suppressedUntil) {
      typed = true;
      post("draft", thread);
    } else {
      if (typed) {
        post("clear", thread);
        typed = false;
      }
      post("heartbeat", thread);
    }
  }, 1000);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("click", onClick, true);
  window.__t3BoardStop = () => {
    clearInterval(timer);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("click", onClick, true);
    post("clear");
    delete window.__t3BoardStop;
  };
  console.info(
    "T3 Board draft bridge connected. Run window.__t3BoardStop() to disconnect.",
  );
})();
