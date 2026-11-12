/* Edit-22 driver: sends real (trusted) key presses to the Google Docs tab via
 * chrome.debugger. Every key is sent one at a time and waited on, so Docs
 * never gets flooded. Text is always typed key by key, never pasted. */
(function (root) {
  'use strict';

  const IS_MAC = /Mac/i.test(navigator.userAgentData?.platform || navigator.platform || '');
  const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
  const CMD = IS_MAC ? MOD.meta : MOD.ctrl;

  const KEYS = {
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
    Home: { key: 'Home', code: 'Home', vk: 36 },
    Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
    Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
    Tab: { key: 'Tab', code: 'Tab', vk: 9, text: '\t' },
    KeyA: { key: 'a', code: 'KeyA', vk: 65 },
    KeyB: { key: 'b', code: 'KeyB', vk: 66 },
    KeyC: { key: 'c', code: 'KeyC', vk: 67 },
    KeyI: { key: 'i', code: 'KeyI', vk: 73 },
    KeyU: { key: 'u', code: 'KeyU', vk: 85 }
  };
  const TOGGLE_KEY = { 1: 'KeyB', 2: 'KeyI', 4: 'KeyU' };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  class StoppedError extends Error { constructor() { super('Stopped'); this.stopped = true; } }

  function charKey(ch) {
    const up = ch.toUpperCase();
    if (/^[A-Z]$/.test(up)) return { code: 'Key' + up, vk: up.charCodeAt(0) };
    if (/^[0-9]$/.test(ch)) return { code: 'Digit' + ch, vk: ch.charCodeAt(0) };
    if (ch === ' ') return { code: 'Space', vk: 32 };
    return { code: '', vk: 0 };
  }

  class DocsDriver {
    constructor(tabId, settings) {
      this.tabId = tabId;
      this.s = settings;
      this.stopped = false;
      this.attached = false;
      this.jumpMods = null; // set by calibration if paragraph jumping works
      this.keyTimes = { n: 0, ms: 0 };
      this._onDetach = (src) => { if (src.tabId === this.tabId) { this.attached = false; this.stopped = true; } };
    }

    get keyMs() { return this.keyTimes.n > 20 ? this.keyTimes.ms / this.keyTimes.n : 8; }
    get charDelay() { return 60000 / (Math.max(5, this.s.wpm) * 5); }
    get backspaceDelay() { return Math.max(25, this.charDelay * 0.5); }

    async attach() {
      try {
        await chrome.debugger.attach({ tabId: this.tabId }, '1.3');
      } catch (e) {
        if (/already attached/i.test(String(e))) {
          throw new Error('Another extension (maybe Type-22) or DevTools is controlling this tab. Stop it, then try again.');
        }
        throw e;
      }
      this.attached = true;
      chrome.debugger.onDetach.addListener(this._onDetach);
      await this.send('Page.bringToFront').catch(() => {});
      // Docs keeps acting focused even while you click in the side panel.
      await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    }

    async detach() {
      chrome.debugger.onDetach.removeListener(this._onDetach);
      if (this.attached) {
        this.attached = false;
        await this.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
        await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
      }
    }

    send(method, params) { return chrome.debugger.sendCommand({ tabId: this.tabId }, method, params || {}); }
    check() { if (this.stopped) throw new StoppedError(); }

    async press(name, modifiers = 0, commands) {
      this.check();
      const k = KEYS[name];
      const t0 = performance.now();
      const down = { type: k.text ? 'keyDown' : 'rawKeyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers };
      if (k.text && !(modifiers & (MOD.ctrl | MOD.meta))) { down.text = k.text; down.unmodifiedText = k.text; }
      if (commands) down.commands = commands;
      await this.send('Input.dispatchKeyEvent', down);
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers });
      this.keyTimes.n++; this.keyTimes.ms += performance.now() - t0;
    }

    async pressMany(name, count, modifiers = 0) {
      for (let i = 0; i < count; i++) {
        await this.press(name, modifiers);
        if (i % 40 === 39) await sleep(8); // let Docs breathe on long moves
      }
    }

    async typeChar(ch) {
      this.check();
      if (ch === '\n') { await this.press('Enter'); await sleep(40); return; }
      if (ch === '\t') { await this.press('Tab'); return; }
      const { code, vk } = charKey(ch);
      const base = { key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, ...base });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    }

    // --- building blocks ---
    copy() { return this.press('KeyC', CMD, ['copy']); }
    selectAll() { return this.press('KeyA', CMD, ['selectAll']); }
    collapseLeft() { return this.press('ArrowLeft'); }
    collapseRight() { return this.press('ArrowRight'); }
    selectToDocStart() { return IS_MAC ? this.press('ArrowUp', MOD.meta | MOD.shift) : this.press('Home', MOD.ctrl | MOD.shift); }
    selectRight(n) { return this.pressMany('ArrowRight', n, MOD.shift); }
    toggle(bit) { return this.press(TOGGLE_KEY[bit], CMD); }

    async moveRight(step) {
      if (this.jumpMods !== null && step.breaks > 0) {
        await this.pressMany('ArrowDown', step.breaks, this.jumpMods);
        await this.pressMany('ArrowRight', step.tail);
      } else {
        await this.pressMany('ArrowRight', step.n);
      }
    }

    async backspace(n) {
      for (let i = 0; i < n; i++) {
        await this.press('Backspace');
        await sleep(this.backspaceDelay);
      }
    }

    async type(text) {
      for (const ch of text) { // by code point; emoji are typed whole
        const t0 = performance.now();
        await this.typeChar(ch);
        const wait = this.charDelay - (performance.now() - t0);
        if (wait > 0) await sleep(wait);
      }
    }

    // Rough time a plan will take, in ms.
    estimate(plan) {
      let ms = 0;
      const k = this.keyMs;
      for (const p of plan) {
        if (p.op === 'move') ms += (this.jumpMods !== null && p.breaks ? p.breaks + p.tail : p.n) * k;
        else if (p.op === 'left' || p.op === 'select') ms += p.n * k;
        else if (p.op === 'toggle' || p.op === 'collapseRight') ms += 2 * k + 40;
        else if (p.op === 'backspace') ms += p.n * (this.backspaceDelay + k);
        else if (p.op === 'type') ms += p.n * Math.max(this.charDelay, k) + (p.text.split('\n').length - 1) * 40;
        if (p.edit && p.first) ms += this.s.pauseMs;
      }
      return ms;
    }

    async run(plan, onStep) {
      let lastEdit = 0;
      for (let i = 0; i < plan.length; i++) {
        const step = plan[i];
        this.check();
        onStep && onStep(i, step);
        if (step.edit && step.edit !== lastEdit) {
          lastEdit = step.edit;
          if (this.s.pauseMs > 0) await sleep(this.s.pauseMs);
        }
        if (step.op === 'move') await this.moveRight(step);
        else if (step.op === 'left') await this.pressMany('ArrowLeft', step.n);
        else if (step.op === 'backspace') await this.backspace(step.n);
        else if (step.op === 'type') await this.type(step.text);
        else if (step.op === 'select') { await this.selectRight(step.n); await sleep(30); }
        else if (step.op === 'toggle') { await this.toggle(step.bit); await sleep(60); }
        else if (step.op === 'collapseRight') { await this.collapseRight(); await sleep(20); }
      }
    }
  }

  // mark the first step of each edit (for pause timing in estimates)
  function markFirsts(plan) {
    let last = 0;
    for (const p of plan) { if (p.edit && p.edit !== last) { p.first = true; last = p.edit; } }
    return plan;
  }

  root.Edit22Driver = { DocsDriver, IS_MAC, MOD, sleep, markFirsts };
})(self);
