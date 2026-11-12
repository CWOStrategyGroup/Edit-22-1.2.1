chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.cmd === 'read') {
    const el = document.getElementById('r');
    let got = { text: '', html: '' };
    const h = (e) => { got = { text: e.clipboardData.getData('text/plain'), html: e.clipboardData.getData('text/html') }; e.preventDefault(); };
    el.addEventListener('paste', h, { once: true });
    el.focus();
    document.execCommand('paste');
    sendResponse(got);
  } else if (msg.cmd === 'write') {
    const t = document.getElementById('t');
    t.value = msg.text;
    t.select();
    document.execCommand('copy');
    sendResponse({ ok: true });
  }
});
