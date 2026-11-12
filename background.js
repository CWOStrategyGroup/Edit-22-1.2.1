// Clicking the toolbar icon opens the side panel (it stays open while you work in the doc).
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// Clipboard fallback: if the side panel can't read/write the clipboard itself,
// it asks us, and we do it through an offscreen document.
async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Read the text copied from the Google Doc'
    });
  } catch (e) {
    if (!String(e).includes('single offscreen')) throw e;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'bg') return;
  (async () => {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ target: 'offscreen', cmd: msg.cmd, text: msg.text });
    sendResponse(res);
  })().catch((e) => sendResponse({ error: String(e) }));
  return true;
});
