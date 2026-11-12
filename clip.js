/* Edit-22 clipboard helpers (side panel). Reads plain text AND html. */
(function (root) {
  'use strict';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function writeLocal(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
  function readLocal() {
    const el = document.createElement('div');
    el.contentEditable = 'true';
    el.style.cssText = 'position:fixed;opacity:0;left:-9999px';
    document.body.appendChild(el);
    let got = null;
    el.addEventListener('paste', (e) => {
      got = { text: e.clipboardData.getData('text/plain'), html: e.clipboardData.getData('text/html') };
      e.preventDefault();
    });
    const prev = document.activeElement;
    el.focus();
    try { document.execCommand('paste'); } catch (_) { /* ignore */ }
    el.remove();
    if (prev && prev.focus) prev.focus({ preventScroll: true });
    return got;
  }

  async function write(text) {
    try { if (writeLocal(text)) return; } catch (_) { /* fall back */ }
    await chrome.runtime.sendMessage({ target: 'bg', cmd: 'write', text });
  }
  async function read() {
    try { const r = readLocal(); if (r) return r; } catch (_) { /* fall back */ }
    const r = await chrome.runtime.sendMessage({ target: 'bg', cmd: 'read' });
    return r && !r.error ? r : { text: '', html: '' };
  }

  // Put a marker on the clipboard, run `action` (which should copy something in
  // the doc), and return what got copied, or null if nothing did.
  async function capture(action, timeout = 2000) {
    const sentinel = '⁣edit22-' + Math.random().toString(36).slice(2);
    await write(sentinel);
    await action();
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      await sleep(70);
      const r = await read();
      if (r && r.text !== sentinel) return { text: (r.text || '').replace(/\r\n?/g, '\n'), html: r.html || '' };
    }
    return null;
  }

  root.Edit22Clip = { write, read, capture };
})(self);
