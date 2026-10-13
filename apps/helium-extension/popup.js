const input = document.querySelector("#gateway");
const save = document.querySelector("#save");
const fallback = "http://127.0.0.1:4321/plugins/browser";

input.value = (await chrome.storage.local.get("gatewayUrl")).gatewayUrl ?? fallback;
save.addEventListener("click", async () => {
  await chrome.storage.local.set({ gatewayUrl: input.value.replace(/\/$/, "") });
  await chrome.runtime.sendMessage({ type: "connect" });
  window.close();
});
