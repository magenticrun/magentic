let selectedTabId;
const refs = new Map();
const DEFAULT_GATEWAY = "http://127.0.0.1:17321/plugins/browser";

const gateway = async () =>
  (await chrome.storage.local.get("gatewayUrl")).gatewayUrl ?? DEFAULT_GATEWAY;
const target = () => {
  if (selectedTabId === undefined) throw new Error("select a tab first");
  return { tabId: selectedTabId };
};
const command = (method, params = {}) => chrome.debugger.sendCommand(target(), method, params);

const selectTab = async (tabId) => {
  await chrome.tabs.get(tabId);
  if (selectedTabId !== tabId) {
    if (selectedTabId !== undefined)
      await chrome.debugger.detach({ tabId: selectedTabId }).catch(() => {});
    await chrome.debugger.attach({ tabId }, "1.3");
    selectedTabId = tabId;
    refs.clear();
    await command("Accessibility.enable");
    await command("DOM.enable");
    await command("Page.enable");
  }
  return { selectedTabId };
};

const snapshot = async (full) => {
  const tree = await command("Accessibility.getFullAXTree");
  refs.clear();
  const lines = [];
  for (const node of tree.nodes) {
    const role = node.role?.value;
    if (!role || role === "none" || role === "generic") continue;
    const name = node.name?.value ?? "";
    const ref = `@e${node.nodeId}`;
    if (node.backendDOMNodeId !== undefined) refs.set(ref, node.backendDOMNodeId);
    if (full || name !== "" || node.backendDOMNodeId !== undefined)
      lines.push(`${ref} ${role}${name === "" ? "" : `: ${name}`}`);
  }
  return { tabId: selectedTabId, snapshot: lines.join("\n"), refs: refs.size };
};

const pointFor = async (ref) => {
  const backendNodeId = refs.get(ref);
  if (backendNodeId === undefined)
    throw new Error(`unknown ref ${ref}; call browser_snapshot again`);
  const box = await command("DOM.getBoxModel", { backendNodeId });
  const quad = box.model.content;
  return {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
  };
};

const click = async (ref) => {
  const { x, y } = await pointFor(ref);
  await command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  return { clicked: ref };
};

const press = async (key) => {
  await command("Input.dispatchKeyEvent", { type: "keyDown", key });
  await command("Input.dispatchKeyEvent", { type: "keyUp", key });
  return { pressed: key };
};

const run = async ({ method, params }) => {
  switch (method) {
    case "tabs":
      return (
        await chrome.tabs.query(params.windowId === undefined ? {} : { windowId: params.windowId })
      ).map(({ id, title, url, active, windowId }) => ({
        id,
        title,
        url,
        active,
        windowId,
      }));
    case "selectTab":
      return selectTab(params.tabId);
    case "snapshot":
      return snapshot(params.full === true);
    case "navigate":
      return command("Page.navigate", { url: params.url });
    case "click":
      return click(params.ref);
    case "type":
      await click(params.ref);
      await command("Input.insertText", { text: params.text });
      return { typed: params.ref };
    case "press":
      return press(params.key);
    case "scroll":
      await command("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 0,
        y: 0,
        deltaX: 0,
        deltaY: params.direction === "up" ? -640 : 640,
      });
      return { scrolled: params.direction };
    case "evaluate": {
      const result = await command("Runtime.evaluate", {
        expression: params.expression,
        returnByValue: true,
        awaitPromise: true,
      });
      return result.exceptionDetails === undefined
        ? (result.result.value ?? result.result.description ?? null)
        : { error: result.exceptionDetails.text };
    }
    default:
      throw new Error(`unknown command ${method}`);
  }
};

const IDLE_DELAY = 250;
const MAX_DELAY = 30_000;

let polling = false;
let delay = IDLE_DELAY;
const poll = async () => {
  if (polling) return;
  polling = true;
  const base = await gateway();
  const started = Date.now();
  try {
    const response = await fetch(`${base}/next`, { method: "POST" });
    if (!response.ok) throw new Error(`gateway said ${response.status}`);
    // The gateway holds an empty request open, so an answer that took a while
    // means we can go straight back and wait again. One that came back at once
    // is a gateway that does not hold, and wants pacing.
    delay = Date.now() - started < IDLE_DELAY ? IDLE_DELAY : 0;
    if (response.status !== 204) {
      const request = await response.json();
      let result;
      try {
        result = await run(request);
      } catch (error) {
        result = { error: error instanceof Error ? error.message : String(error) };
      }
      await fetch(`${base}/result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: request.id, result }),
      });
    }
  } catch {
    // The gateway is optional, and may be down or serving no browser plugin at
    // all. Back off to a knock every 30s rather than four a second, so its log
    // stays readable and ours stays quiet.
    delay = Math.min(Math.max(delay, IDLE_DELAY) * 2, MAX_DELAY);
  }
  polling = false;
  schedule(delay);
};

// One chain, however many times a listener asks for one: installing, starting,
// and every press of Connect share the same timer.
let timer;
const schedule = (after) => {
  clearTimeout(timer);
  timer = setTimeout(poll, after);
};

const connect = () => {
  delay = IDLE_DELAY;
  schedule(0);
};

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "connect") connect();
});
chrome.debugger.onDetach.addListener(({ tabId }) => {
  if (tabId === selectedTabId) {
    selectedTabId = undefined;
    refs.clear();
  }
});
