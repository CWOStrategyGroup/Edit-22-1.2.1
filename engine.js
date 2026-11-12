/* Edit-22 engine: figures out the smallest set of edits that turns the text
 * currently in the doc into the edited text, and turns that into a list of
 * cursor operations (move / delete / type). No browser APIs in here, so it can
 * be unit-tested in Node. */
(function (root) {
  'use strict';

  // ---------- helpers ----------
  const segmenter =
    typeof Intl !== 'undefined' && Intl.Segmenter
      ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      : null;

  // Number of cursor steps (arrow presses) a piece of text takes up.
  function glen(s) {
    if (!s) return 0;
    if (!segmenter) return Array.from(s).length;
    let n = 0;
    for (const _ of segmenter.segment(s)) n++; // eslint-disable-line no-unused-vars
    return n;
  }

  // 1:1 character substitutions (same length), so offsets stay valid.
  const LOOSE_MAP = {
    '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'",
    '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"',
    ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' '
  };
  function loosen(s) {
    return s.replace(/[‘’‚‛′“”„‟″    ]/g, (c) => LOOSE_MAP[c]);
  }

  function normalizeOriginal(t) {
    return String(t || '').replace(/\r\n?/g, '\n').replace(/\u000b/g, '\n');
  }

  function stripMarkdown(t) {
    return t
      .split('\n')
      .filter((line) => !/^\s*```/.test(line))
      .map((line) =>
        line
          .replace(/^\s{0,3}#{1,6}\s+/, '')
          .replace(/\*\*(.+?)\*\*/g, '$1')
          .replace(/__(.+?)__/g, '$1')
      )
      .join('\n');
  }

  function prepareEdited(t, original, opts) {
    let e = String(t || '').replace(/\r\n?/g, '\n').replace(/[​﻿]/g, '');
    if (opts.stripMarkdown) e = stripMarkdown(e);
    // AI tools put a blank line between paragraphs; Docs copies paragraphs with a
    // single line break. If the doc has no blank lines, collapse them.
    if (opts.fixBlankLines && !/\n[ \t]*\n/.test(original)) {
      e = e.replace(/\n(?:[ \t]*\n)+/g, '\n');
    }
    return e;
  }

  // ---------- tokenizing ----------
  const WORD_RE = /\n|[^\S\n]+|[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*|[\s\S]/gu;

  function tokenize(cmp, mode) {
    const toks = [];
    if (mode === 'char') {
      let pos = 0;
      const parts = segmenter ? Array.from(segmenter.segment(cmp), (x) => x.segment) : Array.from(cmp);
      for (const p of parts) {
        toks.push({ s: p, start: pos, end: pos + p.length });
        pos += p.length;
      }
      return toks;
    }
    WORD_RE.lastIndex = 0;
    let m;
    while ((m = WORD_RE.exec(cmp))) {
      toks.push({ s: m[0], start: m.index, end: m.index + m[0].length });
    }
    return toks;
  }

  // ---------- Myers diff on token arrays ----------
  // returns ops in order: [0, i, j] equal, [-1, i] delete a[i], [1, j] insert b[j]
  function myers(a, b) {
    const N = a.length, M = b.length;
    if (N === 0) return b.map((_, j) => [1, -1, j]);
    if (M === 0) return a.map((_, i) => [-1, i, -1]);
    const MAX = N + M;
    const OFF = MAX + 1;
    const v = new Int32Array(2 * MAX + 3);
    v[OFF + 1] = 0;
    const trace = [];
    let D = -1;
    outer: for (let d = 0; d <= MAX; d++) {
      // snapshot of v for k in [-d-1, d+1] before this step
      trace.push(v.slice(OFF - d - 1, OFF + d + 2));
      for (let k = -d; k <= d; k += 2) {
        let x;
        if (k === -d || (k !== d && v[OFF + k - 1] < v[OFF + k + 1])) x = v[OFF + k + 1];
        else x = v[OFF + k - 1] + 1;
        let y = x - k;
        while (x < N && y < M && a[x] === b[y]) { x++; y++; }
        v[OFF + k] = x;
        if (x >= N && y >= M) { D = d; break outer; }
      }
    }
    const ops = [];
    let x = N, y = M;
    for (let d = D; d >= 0; d--) {
      const snap = trace[d];
      const get = (k) => snap[k + d + 1];
      const k = x - y;
      let prevK;
      if (k === -d || (k !== d && get(k - 1) < get(k + 1))) prevK = k + 1;
      else prevK = k - 1;
      const prevX = d === 0 ? 0 : get(prevK);
      const prevY = d === 0 ? 0 : prevX - prevK;
      while (x > prevX && y > prevY) { ops.push([0, x - 1, y - 1]); x--; y--; }
      if (d > 0) {
        if (x === prevX) { ops.push([1, -1, y - 1]); y--; }
        else { ops.push([-1, x - 1, -1]); x--; }
      }
    }
    return ops.reverse();
  }

  function diffTokens(a, b) {
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    const mid = myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf));
    const out = [];
    for (let i = 0; i < pre; i++) out.push([0, i, i]);
    for (const [t, i, j] of mid) out.push([t, i < 0 ? -1 : i + pre, j < 0 ? -1 : j + pre]);
    for (let k = 0; k < suf; k++) out.push([0, a.length - suf + k, b.length - suf + k]);
    return out;
  }

  // ---------- finding which part of the doc the pasted text belongs to ----------
  function wordBag(s) {
    const m = new Map();
    const words = loosen(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    for (const w of words) m.set(w, (m.get(w) || 0) + 1);
    return { m, n: words.length };
  }
  function dice(A, B) {
    if (!A.n || !B.n) return 0;
    let inter = 0;
    const [small, big] = A.m.size < B.m.size ? [A, B] : [B, A];
    for (const [w, c] of small.m) { const c2 = big.m.get(w); if (c2) inter += Math.min(c, c2); }
    return (2 * inter) / (A.n + B.n);
  }

  function paragraphs(text) {
    const out = [];
    let pos = 0;
    for (const line of text.split('\n')) {
      out.push({ start: pos, end: pos + line.length, text: line, blank: !line.trim() });
      pos += line.length + 1;
    }
    return out;
  }

  function locate(original, edited) {
    const paras = paragraphs(original);
    const real = paras.filter((p) => !p.blank).length;
    const editedParas = edited.split('\n').filter((l) => l.trim()).length || 1;
    // Only kick in when the pasted text is clearly a piece of what was grabbed.
    const fragment = editedParas * 2 <= real || edited.trim().length < original.trim().length * 0.5;
    if (!fragment || real < 2) return null;
    const B = wordBag(edited);
    let best = null;
    for (let i = 0; i < paras.length; i++) {
      if (paras[i].blank) continue;
      let count = 0;
      for (let j = i; j < paras.length; j++) {
        if (!paras[j].blank) count++;
        if (count > editedParas + 2) break;
        if (paras[j].blank || count < Math.max(1, editedParas - 2)) continue;
        const text = original.slice(paras[i].start, paras[j].end);
        const s = dice(wordBag(text), B);
        if (!best || s > best.score + 1e-9) best = { score: s, start: paras[i].start, end: paras[j].end, from: i, to: j };
      }
    }
    if (!best) return null;
    const nonBlankIndex = (idx) => paras.slice(0, idx + 1).filter((p) => !p.blank).length;
    best.paraFrom = nonBlankIndex(best.from);
    best.paraTo = nonBlankIndex(best.to);
    best.totalParas = real;
    return best;
  }

  // ---------- main ----------
  const DEFAULTS = {
    granularity: 'word',
    ignoreQuotes: true,
    fixBlankLines: true,
    stripMarkdown: true,
    autoLocate: true
  };

  // original = the whole doc text. range = the part the user highlighted.
  // opts.raw = compare exactly, no clean-up of the pasted text (used for re-checks).
  function compute(originalRaw, editedRaw, options) {
    const opts = Object.assign({}, DEFAULTS, options || {});
    const original = normalizeOriginal(originalRaw);
    const warnings = [];
    const rStart = opts.range ? opts.range.start : 0;
    const rEnd = opts.range ? opts.range.end : original.length;
    const base = original.slice(rStart, rEnd);
    if (!opts.raw && !base.trim()) return { ok: false, error: 'Nothing was grabbed from the doc. Highlight the part you want to edit first.' };
    let edited = opts.raw ? normalizeOriginal(editedRaw) : prepareEdited(editedRaw, base, opts);
    if (!opts.raw && !edited.trim()) return { ok: false, error: 'Paste the edited text into the box first.' };

    let start = rStart, end = rEnd, located = null;
    if (!opts.raw && opts.autoLocate) {
      located = locate(base, edited);
      if (located) {
        if (located.score < 0.35) {
          return { ok: false, error: "Couldn't tell which part of the doc the pasted text belongs to. Highlight just that section and try again." };
        }
        start = rStart + located.start; end = rStart + located.end;
      }
    }
    const target = original.slice(start, end);
    if (!opts.raw) {
      // Keep Tab/space paragraph indents the AI dropped.
      const tl = target.split('\n').filter((l) => l.trim());
      const indents = tl.map((l) => (l.match(/^[ \t]+/) || [''])[0]).filter(Boolean);
      const el = edited.split('\n').filter((l) => l.trim());
      if (tl.length && indents.length >= tl.length / 2 && el.every((l) => !/^[ \t]/.test(l))) {
        const counts = {};
        for (const w of indents) counts[w] = (counts[w] || 0) + 1;
        const W = Object.keys(counts).sort((x, y) => counts[y] - counts[x])[0];
        edited = edited.split('\n').map((l) => (l.trim() ? W + l : l)).join('\n');
      }
      const lead = (target.match(/^\s*/) || [''])[0];
      const trail = target.trim() ? (target.match(/\s*$/) || [''])[0] : '';
      edited = lead + edited.trim() + trail;
    }

    const segs = diffSegments(target, edited, opts);
    const plan = buildPlan(original.slice(0, start), segs);
    const stats = { edits: 0, delWords: 0, insWords: 0 };
    let delChars = 0;
    for (const s of segs) {
      if (s.type !== 'chg') continue;
      stats.edits++;
      delChars += s.del.length;
      stats.delWords += (s.del.match(/[\p{L}\p{N}]+/gu) || []).length;
      stats.insWords += (s.ins.match(/[\p{L}\p{N}]+/gu) || []).length;
    }
    if (!opts.raw) {
      const ratio = target.length ? delChars / target.length : 0;
      if (stats.edits && ratio > 0.4) {
        warnings.push(`This will delete about ${Math.round(ratio * 100)}% of the highlighted text. If you only pasted part of the essay, highlight just that part.`);
      }
      if (/(^|\n)\s*([-*•●]|\d+[.)])\s/.test(target)) {
        warnings.push('The highlighted text looks like it has a list. Bullets/numbers can throw off positions; Edit-22 will re-check and fix, but watch it.');
      }
    }
    const full = original.slice(0, start) + edited + original.slice(end);
    return {
      ok: true, warnings, original, edited, target, targetStart: start, targetEnd: end, full,
      located: located ? { paraFrom: located.paraFrom, paraTo: located.paraTo, totalParas: located.totalParas, score: located.score } : null,
      segments: segs, plan, stats
    };
  }

  function diffSegments(target, edited, opts) {
    const cmpA = opts.ignoreQuotes ? loosen(target) : target;
    const cmpB = opts.ignoreQuotes ? loosen(edited) : edited;
    const ta = tokenize(cmpA, opts.granularity);
    const tb = tokenize(cmpB, opts.granularity);
    const ops = diffTokens(ta.map((t) => t.s), tb.map((t) => t.s));
    let segs = [];
    for (const [t, i, j] of ops) {
      const last = segs[segs.length - 1];
      if (t === 0) {
        const text = target.slice(ta[i].start, ta[i].end);
        if (last && last.type === 'eq') last.text += text; else segs.push({ type: 'eq', text });
      } else {
        let chg = last && last.type === 'chg' ? last : null;
        if (!chg) { chg = { type: 'chg', del: '', ins: '' }; segs.push(chg); }
        if (t < 0) chg.del += target.slice(ta[i].start, ta[i].end);
        else chg.ins += edited.slice(tb[j].start, tb[j].end);
      }
    }
    // Glue changes separated only by a space/punctuation into one phrase
    // replacement ("the big dog" -> "a large cat" = 1 edit, not 3).
    let changed = true;
    while (changed) {
      changed = false;
      for (let k = 1; k < segs.length - 1; k++) {
        const s = segs[k];
        if (s.type !== 'eq' || segs[k - 1].type !== 'chg' || segs[k + 1].type !== 'chg') continue;
        if (s.text.includes('\n')) continue;
        if (!(s.text.length <= 2 || (s.text.length <= 4 && /^[\s\p{P}]+$/u.test(s.text)))) continue;
        const a = segs[k - 1], b = segs[k + 1];
        segs.splice(k - 1, 3, { type: 'chg', del: a.del + s.text + b.del, ins: a.ins + s.text + b.ins });
        changed = true;
        break;
      }
    }
    // A change that only deletes the end of a word and retypes it is nicer as
    // "delete the whole word, type the new one"; keep as is (already word-level).
    return segs.filter((s) => (s.type === 'eq' ? s.text : s.del || s.ins));
  }

  // Cursor plan starting at the very start of the doc:
  //  move  = press Right over this text (Turbo may jump paragraphs instead)
  //  backspace = press Backspace n times (cursor is at the END of the old words)
  //  type  = type this text one key at a time
  function buildPlan(prefix, segs) {
    const plan = [];
    const move = (text) => {
      if (!text) return;
      const last = plan[plan.length - 1];
      if (last && last.op === 'move') last.text += text; else plan.push({ op: 'move', text });
    };
    move(prefix);
    let editNo = 0;
    for (const s of segs) {
      if (s.type === 'eq') { move(s.text); continue; }
      editNo++;
      if (s.del) {
        move(s.del);
        plan.push({ op: 'backspace', text: s.del, edit: editNo });
      }
      if (s.ins) plan.push({ op: 'type', text: s.ins, edit: editNo });
    }
    while (plan.length && plan[plan.length - 1].op === 'move') plan.pop();
    finishPlan(plan);
    return plan;
  }

  function finishPlan(plan) {
    for (const p of plan) {
      if (p.text !== undefined) p.n = glen(p.text);
      if (p.op === 'move') {
        const lines = p.text.split('\n');
        p.breaks = lines.length - 1;
        p.tail = glen(lines[lines.length - 1]);
      }
    }
    return plan;
  }

  // ---------- formatting (bold=1, italic=2, underline=4, -1 = don't know/care) ----------
  const FMT_BITS = [1, 2, 4];

  // Carry formats from one version of a text over to another via a char diff.
  function alignFormats(srcText, srcFmt, dstText) {
    const out = new Array(dstText.length).fill(-1);
    if (!srcFmt) return out;
    const a = loosen(srcText).split('');
    const b = loosen(dstText).split('');
    for (const [t, i, j] of diffTokens(a, b)) if (t === 0) out[j] = srcFmt[i];
    return out;
  }

  // Plan to fix formatting, starting with the cursor at the start of the doc.
  // text: doc text (already equal to the target text). act/des: per-char formats.
  function formatPlan(text, act, des) {
    const care = (i) => text[i] !== '\n' && act[i] >= 0 && des[i] >= 0;
    const runs = [];
    for (const bit of FMT_BITS) {
      let i = 0;
      while (i < text.length) {
        if (!care(i) || (act[i] & bit) === (des[i] & bit)) { i++; continue; }
        const want = des[i] & bit;
        let j = i, last = i;
        while (j < text.length) {
          if (!care(j)) { j++; continue; }
          if ((act[j] & bit) !== (des[j] & bit) && (des[j] & bit) === want) { last = j; j++; continue; }
          break;
        }
        runs.push({ start: i, end: last + 1, bit, on: !!want });
        i = last + 1;
      }
    }
    runs.sort((x, y) => x.start - y.start || x.bit - y.bit);
    const plan = [];
    let cur = 0;
    for (const r of runs) {
      if (r.start >= cur) { if (r.start > cur) plan.push({ op: 'move', text: text.slice(cur, r.start) }); }
      else plan.push({ op: 'left', n: glen(text.slice(r.start, cur)) });
      plan.push({ op: 'select', text: text.slice(r.start, r.end) });
      plan.push({ op: 'toggle', bit: r.bit, on: r.on });
      plan.push({ op: 'collapseRight' });
      cur = r.end;
    }
    return { plan: finishPlan(plan), runs: runs.length };
  }

  function sameText(a, b) { return loosen(normalizeOriginal(a)) === loosen(normalizeOriginal(b)); }

  function countDiffs(a, b) {
    const segs = diffSegments(normalizeOriginal(a), normalizeOriginal(b), DEFAULTS);
    return segs.filter((s) => s.type === 'chg').length;
  }

  const api = { compute, glen, loosen, tokenize, diffTokens, locate, alignFormats, formatPlan, sameText, countDiffs, normalizeOriginal, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Edit22Engine = api;
})(typeof self !== 'undefined' ? self : this);
