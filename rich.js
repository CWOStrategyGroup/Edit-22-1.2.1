/* Edit-22 rich text helpers: turn pasted/copied HTML (or markdown) into
 * plain text + per-character formats (bold=1, italic=2, underline=4). */
(function (root) {
  'use strict';
  const BLOCK = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'TR', 'TABLE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'PRE', 'DL', 'DT', 'DD']);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'HEAD', 'META', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'LINK']);

  function fmtFor(el, f) {
    const tag = el.tagName;
    if (tag === 'B' || tag === 'STRONG' || /^H[1-6]$/.test(tag)) f |= 1;
    if (tag === 'I' || tag === 'EM') f |= 2;
    if (tag === 'U') f |= 4;
    const st = el.style;
    if (st) {
      const w = st.fontWeight;
      if (w) { if (/bold/.test(w) || parseInt(w, 10) >= 600) f |= 1; else f &= ~1; }
      const fs = st.fontStyle;
      if (fs) { if (/italic|oblique/.test(fs)) f |= 2; else if (fs === 'normal') f &= ~2; }
      const td = st.textDecorationLine || st.textDecoration;
      if (td) { if (/underline/.test(td)) f |= 4; else if (/none/.test(td)) f &= ~4; }
    }
    return f;
  }

  // -> { text, fmt } where fmt[i] is the format of text[i] (-1 for line breaks)
  function parseHTML(html, opts = {}) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const lines = [];
    let cur = [];
    const flush = () => { while (cur.length && cur[cur.length - 1].soft) cur.pop(); lines.push(cur); cur = []; };
    const walk = (node, f, pre) => {
      for (const ch of node.childNodes) {
        if (ch.nodeType === 3) {
          let t = ch.nodeValue;
          if (!pre) t = t.replace(/[\t\n\r ]+/g, ' ');
          for (let c of t) {
            if (opts.plainSpaces && c === ' ') c = ' ';
            if (!pre && c === ' ' && (!cur.length || cur[cur.length - 1].c === ' ')) continue;
            cur.push({ c, f, soft: !pre && c === ' ' });
          }
        } else if (ch.nodeType === 1) {
          const tag = ch.tagName;
          if (SKIP.has(tag)) continue;
          if (tag === 'BR') { flush(); continue; }
          const block = BLOCK.has(tag);
          if (block && cur.length) flush();
          const ws = (ch.style && ch.style.whiteSpace) || '';
          walk(ch, fmtFor(ch, f), pre || tag === 'PRE' || /pre/.test(ws));
          if (block && cur.length) flush();
        }
      }
    };
    walk(doc.body, 0, false);
    if (cur.length) flush();
    let text = '';
    const fmt = [];
    lines.forEach((line, i) => {
      if (i > 0) { text += '\n'; fmt.push(-1); }
      for (const x of line) { text += x.c; for (let k = 0; k < x.c.length; k++) fmt.push(x.f); }
    });
    return { text, fmt };
  }

  // Markdown from AI copy buttons: **bold**, __bold__, *italic*, _italic_, # headings
  const MD_RE = /\*\*(.+?)\*\*|__(.+?)__|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|(?<![\w])_(?!\s)(.+?)(?<!\s)_(?![\w])/g;
  function parseMarkdown(plain) {
    let text = '';
    const fmt = [];
    const lines = String(plain || '').replace(/\r\n?/g, '\n').split('\n').filter((l) => !/^\s*```/.test(l));
    lines.forEach((line, li) => {
      if (li > 0) { text += '\n'; fmt.push(-1); }
      let base = 0;
      const h = line.match(/^\s{0,3}#{1,6}\s+/);
      if (h) { line = line.slice(h[0].length); base = 1; }
      let last = 0;
      const add = (s, f) => { text += s; for (let k = 0; k < s.length; k++) fmt.push(f); };
      line.replace(MD_RE, (m, b1, b2, i1, i2, idx) => {
        add(line.slice(last, idx), base);
        if (b1 !== undefined || b2 !== undefined) add(b1 !== undefined ? b1 : b2, base | 1);
        else add(i1 !== undefined ? i1 : i2, base | 2);
        last = idx + m.length;
        return m;
      });
      add(line.slice(last), base);
    });
    return { text, fmt };
  }

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function render(model) {
    const out = [];
    const lines = model.text.split('\n');
    let pos = 0;
    for (const line of lines) {
      if (!line) { out.push('<div><br></div>'); pos += 1; continue; }
      let html = '', i = 0;
      while (i < line.length) {
        const f = Math.max(0, model.fmt[pos + i] || 0);
        let j = i + 1;
        while (j < line.length && Math.max(0, model.fmt[pos + j] || 0) === f) j++;
        let piece = esc(line.slice(i, j));
        if (f & 4) piece = `<u>${piece}</u>`;
        if (f & 2) piece = `<i>${piece}</i>`;
        if (f & 1) piece = `<b>${piece}</b>`;
        html += piece;
        i = j;
      }
      out.push(`<div>${html}</div>`);
      pos += line.length + 1;
    }
    return out.join('');
  }

  const hasFormatting = (model) => model.fmt.some((f) => f > 0);

  root.Edit22Rich = { parseHTML, parseMarkdown, render, hasFormatting };
})(self);
