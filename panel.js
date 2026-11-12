/* Edit-22 side panel */
(() => {
  'use strict';
  const { DocsDriver, IS_MAC, MOD, sleep, markFirsts } = self.Edit22Driver;
  const Engine = self.Edit22Engine;
  const Rich = self.Edit22Rich;
  const Clip = self.Edit22Clip;
  const $ = (id) => document.getElementById(id);

  const DEFAULTS = { wpm: 60, pauseSec: 0.5, autoLocate: true, matchFormat: true };
  const MAX_PASSES = 6;
  let S = { ...DEFAULTS };
  let savedKeyMs = 8;
  // Live view of the settings, so moving a slider mid-run takes effect right away.
  const live = { get wpm() { return S.wpm; }, get pauseMs() { return S.pauseSec * 1000; } };

  let grab = null;       // { F, fmt, range, mode, tabId }
  let result = null;     // engine output for the current paste
  let desiredFmt = null; // formats wanted for result.full (-1 = leave alone)
  let fmtNote = null;
  let driver = null;
  let busy = false;

  // ---------- small UI helpers ----------
  function pill(text, kind) { const p = $('pill'); p.textContent = text; p.className = 'pill' + (kind ? ' ' + kind : ''); }
  function message(text, kind) {
    const m = $('msg');
    if (!text) { m.classList.add('hidden'); return; }
    m.textContent = text; m.className = 'msg' + (kind ? ' ' + kind : '');
  }
  function setBusy(b) {
    busy = b;
    for (const id of ['grabSel', 'grabAll', 'apply', 'clear']) $(id).disabled = b;
    $('stop').classList.toggle('hidden', !b);
    $('edited').contentEditable = b ? 'false' : 'true';
    if (!b) $('apply').disabled = !(result && result.ok && result.stats.edits + (formatRunsEstimate() ? 1 : 0) > 0);
  }
  function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return `${m} min ${String(r).padStart(2, '0')} s`;
    return `${Math.floor(m / 60)} h ${m % 60} min`;
  }
  function setEta(text, sub = '', kind = '') {
    $('etaText').textContent = text;
    $('etaSub').textContent = sub;
    $('etaBar').className = 'eta' + (kind ? ' ' + kind : '');
  }

  // ---------- settings ----------
  function showSettings() {
    $('wpm').value = S.wpm; $('wpmVal').textContent = `${S.wpm} WPM`;
    $('pause').value = S.pauseSec; $('pauseVal').textContent = `${S.pauseSec} s`;
    $('autoLocate').checked = S.autoLocate; $('matchFormat').checked = S.matchFormat;
  }
  function saveSettings() { chrome.storage.local.set({ settings2: S }); }
  $('wpm').addEventListener('input', (e) => { S.wpm = Number(e.target.value); showSettings(); saveSettings(); if (!busy) updateEta(); });
  $('pause').addEventListener('input', (e) => { S.pauseSec = Number(e.target.value); showSettings(); saveSettings(); if (!busy) updateEta(); });
  $('autoLocate').addEventListener('change', (e) => { S.autoLocate = e.target.checked; saveSettings(); recompute(); });
  $('matchFormat').addEventListener('change', (e) => { S.matchFormat = e.target.checked; saveSettings(); recompute(); });

  // ---------- paste box (keeps bold / italic / underline) ----------
  const box = $('edited');
  box.addEventListener('paste', (e) => {
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const plain = e.clipboardData.getData('text/plain');
    let model = html ? Rich.parseHTML(html, { plainSpaces: true }) : Rich.parseMarkdown(plain);
    if (html && (!model.text.trim() || (!Rich.hasFormatting(model) && /\*\*|__/.test(plain)))) model = Rich.parseMarkdown(plain);
    document.execCommand('insertHTML', false, Rich.render(model));
    onBoxChange();
  });
  box.addEventListener('input', onBoxChange);
  $('clear').addEventListener('click', () => { box.innerHTML = ''; onBoxChange(); box.focus(); });
  function readBox() { return Rich.parseHTML(box.innerHTML, { plainSpaces: true }); }
  let boxTimer;
  function onBoxChange() {
    clearTimeout(boxTimer);
    boxTimer = setTimeout(() => { chrome.storage.local.set({ draftHtml: box.innerHTML }); recompute(); }, 250);
  }

  // ---------- doc access ----------
  async function getDocsTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/docs\.google\.com\/document\//.test(tab.url || '')) {
      throw new Error('Open your Google Doc in this tab first.');
    }
    return tab;
  }
  async function startDriver(tabId) {
    driver = new DocsDriver(tabId, live);
    driver.keyTimes = { n: 0, ms: 0 };
    await driver.attach();
    return driver;
  }
  async function stopDriver() {
    if (driver) {
      if (driver.keyTimes.n > 50) { savedKeyMs = driver.keyMs; chrome.storage.local.set({ keyMs: savedKeyMs }); }
      await driver.detach();
    }
    driver = null;
  }

  // Ctrl+A, copy, then Left: returns the whole doc's text (+ formatting) and
  // leaves the cursor at the very start of the doc.
  async function snapshot() {
    const r = await Clip.capture(async () => { await driver.selectAll(); await sleep(150); await driver.copy(); });
    if (!r) return null;
    await driver.collapseLeft();
    await sleep(80);
    const text = Engine.normalizeOriginal(r.text);
    let fmt = null;
    if (r.html) {
      try {
        const m = Rich.parseHTML(r.html);
        const a = Engine.alignFormats(m.text, m.fmt, text);
        let known = 0, need = 0;
        for (let i = 0; i < text.length; i++) if (text[i] !== '\n') { need++; if (a[i] >= 0) known++; }
        if (known >= need * 0.9) fmt = a;
      } catch (_) { /* formatting unknown */ }
    }
    return { text, fmt };
  }

  function findStart(F, S0, B) {
    const LF = Engine.loosen(F), LB = Engine.loosen(B || '');
    for (const cand of [S0, S0.replace(/\n+$/, ''), S0.replace(/^\n+/, '')]) {
      if (!cand) continue;
      const LS = Engine.loosen(cand);
      const off = S0.indexOf(cand);
      if (LF.startsWith(LB) && LF.startsWith(LS, LB.length)) return { start: LB.length, len: cand.length };
      const hits = [];
      let i = LF.indexOf(LS);
      while (i >= 0 && hits.length < 50) { hits.push(i); i = LF.indexOf(LS, i + 1); }
      if (hits.length === 1) return { start: hits[0], len: cand.length };
      if (hits.length > 1 && B) {
        const target = LB.length + off;
        hits.sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
        return { start: hits[0], len: cand.length };
      }
    }
    return null;
  }

  // ---------- preview ----------
  function shown(text) {
    const frag = document.createDocumentFragment();
    text.split('\n').forEach((p, i) => {
      if (i > 0) { const s = document.createElement('span'); s.className = 'nl'; s.textContent = '¶\n'; frag.appendChild(s); }
      if (p) frag.appendChild(document.createTextNode(p));
    });
    return frag;
  }
  function note(text, kind) { const d = document.createElement('div'); d.className = 'note ' + kind; d.textContent = text; $('notes').appendChild(d); }

  function formatRunsEstimate() {
    if (!result || !result.ok || !desiredFmt || !grab || !grab.fmt) return 0;
    const approx = Engine.alignFormats(grab.F, grab.fmt, result.full);
    return Engine.formatPlan(result.full, approx, desiredFmt).runs;
  }

  function renderPreview() {
    const diff = $('diff'), sum = $('summary');
    diff.textContent = ''; $('notes').textContent = '';
    if (!grab) { $('previewBox').classList.add('hidden'); return; }
    $('previewBox').classList.remove('hidden');
    if (!result || !result.ok) {
      sum.textContent = '';
      if (result) message(result.error, 'bad');
      $('apply').disabled = true;
      return;
    }
    message('');
    const { stats, located } = result;
    const fRuns = formatRunsEstimate();
    if (!stats.edits && !fRuns) sum.innerHTML = 'No differences. <small>This section already matches what you pasted.</small>';
    else if (!stats.edits) sum.innerHTML = `Text already matches <small>· ${fRuns} formatting fix${fRuns === 1 ? '' : 'es'}</small>`;
    else sum.innerHTML = `${stats.edits} edit${stats.edits === 1 ? '' : 's'} <small>· ${stats.delWords} word${stats.delWords === 1 ? '' : 's'} out, ${stats.insWords} in${fRuns ? ` · ${fRuns} formatting fix${fRuns === 1 ? '' : 'es'}` : ''}</small>`;
    if (located) {
      note(located.paraFrom === located.paraTo
        ? `Your paste matches paragraph ${located.paraFrom} of the grabbed text. Nothing else will be touched.`
        : `Your paste matches paragraphs ${located.paraFrom}–${located.paraTo} of the grabbed text. Nothing else will be touched.`, 'info');
    }
    for (const t of result.warnings) note(t, 'warn');
    if (fmtNote) note(fmtNote.text, fmtNote.kind);

    const segs = result.segments;
    segs.forEach((s, i) => {
      if (s.type === 'eq') {
        const t = s.text, first = i === 0, last = i === segs.length - 1, keep = 60;
        if (t.length > keep * 2 + 20 || (first && t.length > keep) || (last && t.length > keep)) {
          if (!first) diff.appendChild(shown(t.slice(0, keep)));
          const g = document.createElement('span'); g.className = 'gap'; g.textContent = ' … '; diff.appendChild(g);
          if (!last) diff.appendChild(shown(t.slice(-keep)));
        } else diff.appendChild(shown(t));
      } else {
        if (s.del) { const d = document.createElement('del'); d.appendChild(shown(s.del)); diff.appendChild(d); }
        if (s.ins) { const n = document.createElement('ins'); n.appendChild(shown(s.ins)); diff.appendChild(n); }
      }
    });
    $('apply').disabled = busy || (!stats.edits && !fRuns);
  }

  function recompute() {
    desiredFmt = null; fmtNote = null; result = null;
    const pasted = readBox();
    if (grab && pasted.text.trim()) {
      result = Engine.compute(grab.F, pasted.text, { range: grab.range, autoLocate: S.autoLocate });
      if (result.ok) {
        markFirsts(result.plan);
        if (S.matchFormat && Rich.hasFormatting(pasted)) {
          if (grab.fmt) {
            const region = Engine.alignFormats(pasted.text, pasted.fmt, result.edited);
            desiredFmt = new Array(result.targetStart).fill(-1).concat(region,
              new Array(result.full.length - result.targetStart - result.edited.length).fill(-1));
            fmtNote = { text: 'Bold / italic / underline will match your paste.', kind: 'info' };
          } else {
            fmtNote = { text: "Couldn't read the doc's formatting, so only the words will change.", kind: 'warn' };
          }
        } else if (!Rich.hasFormatting(pasted)) {
          fmtNote = { text: 'Your paste has no bold/italic/underline, so the doc\'s formatting is left as is.', kind: 'info' };
        }
      }
    }
    renderPreview();
    updateEta();
  }

  // ---------- time to done ----------
  function estimator() {
    const d = new DocsDriver(null, live);
    d.keyTimes = { n: 1000, ms: savedKeyMs * 1000 };
    return d;
  }
  function updateEta() {
    if (busy) return;
    if (!result || !result.ok) { setEta('Time to done: –', `${S.wpm} WPM`); return; }
    const d = estimator();
    let ms = d.estimate(result.plan) + 3000;
    const fRuns = formatRunsEstimate();
    if (fRuns) ms += fRuns * 400 + 2500;
    if (!result.stats.edits && !fRuns) { setEta('Nothing to change', ''); return; }
    setEta(`Time to done: ≈ ${fmtDur(ms)}`, `${S.wpm} WPM · ${S.pauseSec} s pause`);
  }

  // ---------- actions ----------
  async function doGrab(mode) {
    if (busy) return;
    message('');
    if (!readBox().text.trim()) { message('Paste the edited text into step 1 first.', 'bad'); return; }
    setBusy(true); pill('Reading doc…', 'busy');
    try {
      const tab = await getDocsTab();
      await startDriver(tab.id);
      let sel = null, before = '';
      if (mode === 'selection') {
        const s = await Clip.capture(() => driver.copy());
        if (!s || !s.text) throw new Error('Nothing is highlighted in the doc. Highlight the part you want to edit (or click "Whole doc").');
        sel = Engine.normalizeOriginal(s.text);
        await driver.collapseLeft(); await sleep(80);
        const b = await Clip.capture(async () => { await driver.selectToDocStart(); await sleep(80); await driver.copy(); }, 900);
        before = b ? Engine.normalizeOriginal(b.text) : '';
      }
      const snap = await snapshot();
      if (!snap || !snap.text) throw new Error("Couldn't copy from the doc. Click once inside the doc's text and try again.");
      let range = { start: 0, end: snap.text.length };
      if (mode === 'selection') {
        const f = findStart(snap.text, sel, before);
        if (!f) throw new Error("Couldn't pin down where your highlight is. Try highlighting whole paragraphs.");
        range = { start: f.start, end: f.start + f.len };
      }
      grab = { F: snap.text, fmt: snap.fmt, range, mode, tabId: tab.id };
      const words = (snap.text.slice(range.start, range.end).match(/[\p{L}\p{N}]+/gu) || []).length;
      $('grabInfo').textContent = `✓ Grabbed ${mode === 'all' ? 'the whole doc' : 'your highlight'} (${words} words). You can click away; Edit-22 remembers the spot.`;
      $('grabInfo').classList.remove('hidden');
      recompute();
      pill('Preview ready');
    } catch (e) {
      message(e.message || String(e), 'bad'); pill('Ready');
    } finally {
      await stopDriver();
      setBusy(false);
      updateEta();
    }
  }

  // Can we jump paragraph-by-paragraph? Test it once at the top of the doc.
  async function calibrate(T) {
    const k = T.indexOf('\n');
    if (k < 4) return;
    const e2 = T.indexOf('\n', k + 1);
    const p2 = T.slice(k + 1, e2 < 0 ? T.length : e2);
    if (p2.trim().length < 4) return;
    const want = Array.from(p2).slice(0, 10).join('');
    const n = Engine.glen(want);
    for (const mods of IS_MAC ? [MOD.alt, MOD.ctrl] : [MOD.ctrl]) {
      await driver.pressMany('ArrowRight', 2);
      await driver.press('ArrowDown', mods);
      await sleep(60);
      const r = await Clip.capture(async () => { await driver.selectRight(n); await driver.copy(); }, 900);
      await driver.selectAll(); await sleep(120); await driver.collapseLeft(); await sleep(80);
      if (r && Engine.sameText(r.text, want)) { driver.jumpMods = mods; return; }
    }
  }

  async function runWithProgress(plan, label) {
    const total = plan.reduce((m, p) => Math.max(m, p.edit || 0), 0);
    let remain = driver.estimate(plan) + 2000, base = Date.now(), cur = 0;
    const tick = () => {
      const left = remain - (Date.now() - base);
      setEta(`≈ ${fmtDur(left)} left`, `${label}${total && cur ? ` · edit ${cur} of ${total}` : ''}`);
    };
    tick();
    const timer = setInterval(tick, 400);
    const bar = $('progressBar');
    try {
      await driver.run(plan, (i, step) => {
        remain = driver.estimate(plan.slice(i)) + 2000; base = Date.now();
        if (step.edit && step.edit !== cur) {
          cur = step.edit;
          pill(`${label} ${cur}/${total}`, 'busy');
          bar.style.width = Math.round(((cur - 1) / Math.max(1, total)) * 100) + '%';
        }
      });
      bar.style.width = '100%';
    } finally { clearInterval(timer); }
  }

  const totalBreaks = (plan) => plan.reduce((s, p) => s + (p.op === 'move' ? p.breaks : 0), 0);

  async function doApply() {
    if (busy || !result || !result.ok) return;
    message('');
    setBusy(true); pill('Starting…', 'busy');
    $('progressWrap').classList.remove('hidden'); $('progressBar').style.width = '0%';
    const expected = result.full;
    const t0 = Date.now();
    let lastSnap = null, verified = false, fmtLeft = 0, fmtPasses = 0, stuck = false;
    try {
      const tab = await getDocsTab();
      if (tab.id !== grab.tabId) throw new Error('This is a different tab than the one you grabbed from. Switch back to it.');
      await startDriver(tab.id);
      for (let pass = 1; pass <= MAX_PASSES; pass++) {
        setEta(pass === 1 ? 'Getting ready…' : 'Double-checking the doc…', pass > 1 ? `check ${pass - 1}` : '');
        const snap = await snapshot();
        if (!snap) throw new Error("Couldn't read the doc. Click inside the doc's text once and try again.");
        if (pass === 1 && !Engine.sameText(snap.text, grab.F)) {
          throw new Error('The doc changed since you grabbed it. Click Grab again.');
        }
        if (!Engine.sameText(snap.text, expected)) {
          if (lastSnap !== null && Engine.sameText(snap.text, lastSnap.text)) { stuck = true; lastSnap = snap; break; }
          if (pass > 1) driver.jumpMods = null; // fix passes go letter by letter
          const r = Engine.compute(snap.text, expected, { raw: true });
          markFirsts(r.plan);
          if (pass === 1 && totalBreaks(r.plan) >= 6) await calibrate(snap.text);
          lastSnap = snap;
          await runWithProgress(r.plan, pass === 1 ? 'Editing' : 'Fixing');
          continue;
        }
        lastSnap = snap;
        if (desiredFmt && snap.fmt) {
          const des = desiredFmt.length === snap.text.length ? desiredFmt : Engine.alignFormats(expected, desiredFmt, snap.text);
          const fp = Engine.formatPlan(snap.text, snap.fmt, des);
          if (fp.runs > 0 && fmtPasses < 3) { fmtPasses++; await runWithProgress(fp.plan, 'Formatting'); continue; }
          fmtLeft = fp.runs;
        }
        verified = true;
        break;
      }
      const took = fmtDur(Date.now() - t0);
      if (verified && !fmtLeft) {
        pill('Done', 'good');
        setEta('✓ Done and checked', `took ${took}`, 'done');
        message('Done. Edit-22 re-read the doc and the section now matches what you pasted exactly.', 'good');
        grab = null; result = null; desiredFmt = null;
        $('grabInfo').classList.add('hidden');
        renderPreview();
      } else if (verified) {
        pill('Done', 'good');
        setEta('✓ Words match', `${fmtLeft} formatting spot(s) left`, 'done');
        message(`The words match exactly. ${fmtLeft} bit(s) of bold/italic/underline couldn't be fixed. Check those by hand.`, 'bad');
      } else {
        const left = lastSnap ? Engine.countDiffs(lastSnap.text, expected) : '?';
        pill('Needs a look', 'bad');
        setEta(`${left} spot(s) don't match`, `after ${took}`, 'bad');
        message(`${left} spot(s) still don't match${stuck ? ' (Docs kept changing them back)' : ''}. This is usually Docs' autocorrect (Tools → Preferences → Substitutions / Automatic capitalization). Click Grab again to see what's left and re-apply.`, 'bad');
      }
    } catch (e) {
      if (e.stopped) { pill('Stopped', 'bad'); setEta('Stopped', '', 'bad'); message('Stopped. Edits made so far stay in the doc (Ctrl/⌘+Z undoes them).', 'bad'); }
      else { pill('Error', 'bad'); setEta('Error', '', 'bad'); message(e.message || String(e), 'bad'); }
    } finally {
      await stopDriver();
      setTimeout(() => $('progressWrap').classList.add('hidden'), 1500);
      setBusy(false);
    }
  }

  $('grabSel').addEventListener('click', () => doGrab('selection'));
  $('grabAll').addEventListener('click', () => doGrab('all'));
  $('apply').addEventListener('click', doApply);
  $('stop').addEventListener('click', () => { if (driver) driver.stopped = true; });

  (async () => {
    const st = await chrome.storage.local.get(['settings2', 'draftHtml', 'keyMs']);
    S = { ...DEFAULTS, ...(st.settings2 || {}) };
    if (st.keyMs) savedKeyMs = st.keyMs;
    if (st.draftHtml) box.innerHTML = st.draftHtml;
    showSettings();
    setBusy(false);
    updateEta();
  })();
})();
