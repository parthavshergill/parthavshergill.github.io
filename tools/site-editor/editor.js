/* Local site editor. Loaded only by tools/site-editor/serve.py; published pages never reference it. */
(() => {
  'use strict';
  const metaEl = document.getElementById('__site-editor-meta');
  if (!metaEl) return;
  const meta = JSON.parse(metaEl.textContent);
  const UI = '__ed-ui';
  const KATEX = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/';
  const KATEX_LINK = `<link rel="stylesheet" href="${KATEX}katex.min.css">`;

  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  };
  const ui = (tag, attrs = {}, ...kids) => {
    const el = h(tag, attrs, ...kids);
    el.classList.add(UI);
    return el;
  };

  const unwrap = (el) => el.replaceWith(...el.childNodes);

  // ---------------------------------------------------------------- view mode
  if (meta.mode === 'view') {
    document.body.append(ui('a', { class: `${UI} ed-pill`, href: location.pathname + '?edit' }, 'Edit page'));
    return;
  }

  // ---------------------------------------------------------------- spans and regions
  // Every body element carries data-edit="os:is:ie:oe:textLen:isBlock" (code-point
  // offsets into the file). An element is "trusted" when its parsed text matches
  // the server's count; only trusted elements can be copied back from source.
  // A region is the outermost trusted block.
  const textLen = (s) => [...s.replace(/\s+/g, ' ').trim()].length;
  const SPAN = new WeakMap();
  for (const el of document.querySelectorAll('[data-edit]')) {
    const [os, is, ie, oe, n, block] = el.dataset.edit.split(':').map(Number);
    if (textLen(el.textContent) === n) SPAN.set(el, { os, is, ie, oe, block: block === 1 });
  }
  const regions = [];
  const regionSet = new Set();
  for (const el of document.querySelectorAll('[data-edit]')) {
    const span = SPAN.get(el);
    if (!span || !span.block) continue;
    let up = el.parentElement, covered = false;
    while (up) { if (regionSet.has(up)) { covered = true; break; } up = up.parentElement; }
    if (covered) continue;
    el.__span = [span.is, span.ie];
    regions.push(el);
    regionSet.add(el);
  }
  const regionOf = (node) => {
    let el = node && (node.nodeType === 1 ? node : node.parentElement);
    while (el) { if (regionSet.has(el)) return el; el = el.parentElement; }
    return null;
  };

  // The file as it was when this page loaded, for copying untouched markup back.
  let SOURCE = null;
  let toU16 = (i) => i;
  const sourceReady = fetch('/__edit/source?path=' + encodeURIComponent(meta.path))
    .then((r) => r.json())
    .then((body) => {
      if (body.hash !== meta.hash) throw new Error('changed');
      SOURCE = body.text;
      if (/[\uD800-\uDFFF]/.test(SOURCE)) {
        const map = []; let u = 0;
        for (const ch of SOURCE) { map.push(u); u += ch.length; }
        map.push(u);
        toU16 = (i) => map[i];
      }
    })
    .catch(() => { SOURCE = null; });
  const slice = (a, b) => SOURCE.slice(toU16(a), toU16(b));

  document.documentElement.classList.add('ed-editing');
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (_) {}
  try { document.execCommand('styleWithCSS', false, false); } catch (_) {}

  const lockTex = (root) => root.querySelectorAll('.tex').forEach((t) => { t.contentEditable = 'false'; });
  for (const r of regions) {
    r.contentEditable = 'true';
    r.spellcheck = true;
    r.setAttribute('data-ed-region', '');
    lockTex(r);
  }

  // Track which elements the user changed. Scripts are off in edit mode, so
  // every mutation from here on comes from editing.
  const changed = new WeakSet();
  const attrsChanged = new WeakSet();
  const editorAttr = (n) => n === 'contenteditable' || n === 'spellcheck' || n === 'data-edit' || n.startsWith('data-ed-');
  const markUp = (el) => { while (el && !changed.has(el)) { changed.add(el); el = el.parentElement; } };
  const onMutations = (records) => {
    for (const r of records) {
      if (r.type === 'attributes') {
        if (editorAttr(r.attributeName)) continue;
        attrsChanged.add(r.target); markUp(r.target);
      } else markUp(r.target.nodeType === 1 ? r.target : r.target.parentElement);
    }
  };
  const observer = new MutationObserver(onMutations);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: false });

  // ---------------------------------------------------------------- state
  const dirty = new Set();
  const siteStyleEl = () => document.getElementById('site-style');
  let settings = {};
  try { settings = JSON.parse(siteStyleEl()?.dataset.settings || '{}'); } catch (_) { settings = {}; }
  let styleDirty = false;
  let needKatexCss = false;
  const markDirty = (r) => { if (r) { dirty.add(r); refresh(); } };
  for (const r of regions) r.addEventListener('input', () => markDirty(r));

  // ---------------------------------------------------------------- fonts
  const FONTS = {
    'system-sans': ['System sans (GitHub)', '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif'],
    'helvetica': ['Helvetica / Arial', '"Helvetica Neue", Helvetica, Arial, sans-serif'],
    'georgia': ['Georgia', 'Georgia, "Times New Roman", serif'],
    'book-serif': ['Book serif (Charter)', 'Charter, "Bitstream Charter", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif'],
    'system-mono': ['System mono', 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'],
    'source-serif': ['Source Serif 4', '"Source Serif 4", Georgia, serif', 'Source+Serif+4:ital,wght@0,400;0,600;0,700;1,400'],
    'source-sans': ['Source Sans 3', '"Source Sans 3", -apple-system, "Segoe UI", sans-serif', 'Source+Sans+3:ital,wght@0,400;0,600;0,700;1,400'],
    'plex-sans': ['IBM Plex Sans', '"IBM Plex Sans", -apple-system, "Segoe UI", sans-serif', 'IBM+Plex+Sans:ital,wght@0,400;0,600;0,700;1,400'],
    'plex-serif': ['IBM Plex Serif', '"IBM Plex Serif", Georgia, serif', 'IBM+Plex+Serif:ital,wght@0,400;0,600;0,700;1,400'],
    'newsreader': ['Newsreader', 'Newsreader, Georgia, serif', 'Newsreader:ital,wght@0,400;0,600;0,700;1,400'],
    'eb-garamond': ['EB Garamond', '"EB Garamond", Garamond, Georgia, serif', 'EB+Garamond:ital,wght@0,400;0,600;0,700;1,400'],
    'lora': ['Lora', 'Lora, Georgia, serif', 'Lora:ital,wght@0,400;0,600;0,700;1,400'],
    'plex-mono': ['IBM Plex Mono', '"IBM Plex Mono", ui-monospace, Menlo, monospace', 'IBM+Plex+Mono:ital,wght@0,400;0,600;1,400'],
    'jetbrains-mono': ['JetBrains Mono', '"JetBrains Mono", ui-monospace, Menlo, monospace', 'JetBrains+Mono:ital,wght@0,400;0,600;1,400'],
  };
  const fontStack = (key) => {
    if (!key) return null;
    if (key.startsWith('g:')) return `"${key.slice(2).replace(/"/g, '')}", system-ui, sans-serif`;
    return FONTS[key]?.[1] || null;
  };
  const fontImport = (key) => {
    if (!key) return null;
    if (key.startsWith('g:')) return key.slice(2).trim().replace(/\s+/g, '+');
    return FONTS[key]?.[2] || null;
  };
  const fontLabel = (key) => (key?.startsWith('g:') ? key.slice(2) : FONTS[key]?.[0] || key);

  const usedInlineFonts = () => {
    const keys = new Set();
    for (const r of regions) r.querySelectorAll('[data-font]').forEach((s) => keys.add(s.dataset.font));
    return keys;
  };

  const MONO_SKIP = 'code, code *, pre, pre *, kbd, samp, .tex, .tex *, svg, svg *';
  const UI_SKIP = ', .' + UI + ', .' + UI + ' *';
  const HEADS = 'h1, h2, h3, h4, h5, h6';
  const HEADS_DEEP = 'h1 *, h2 *, h3 *, h4 *, h5 *, h6 *';
  function styleCss(s, live = false) {
    const lines = [];
    const families = new Set([s.body, s.heading, s.code, ...usedInlineFonts()].map(fontImport).filter(Boolean));
    if (families.size) {
      lines.push(`@import url("https://fonts.googleapis.com/css2?${[...families].map((f) => 'family=' + f).join('&')}&display=swap");`);
    }
    if (s.body) lines.push(`body, body :not(${HEADS}, ${HEADS_DEEP}, ${MONO_SKIP}${live ? UI_SKIP : ''}, [data-font], [data-font] *) { font-family: ${fontStack(s.body)} !important; }`);
    if (s.heading) lines.push(`:is(${HEADS}), :is(${HEADS}) :not(code, .tex, .tex *, [data-font]) { font-family: ${fontStack(s.heading)} !important; }`);
    if (s.code) lines.push(`code, pre, pre *, kbd, samp { font-family: ${fontStack(s.code)} !important; }`);
    if (s.size) lines.push(`html, body { font-size: ${s.size}px !important; }`);
    if (s.lineHeight) lines.push(`body, body p, body li { line-height: ${s.lineHeight} !important; }`);
    if (s.text) lines.push(`:root { --ink: ${s.text} !important; } body { color: ${s.text} !important; }`);
    if (s.background) lines.push(`:root { --paper: ${s.background} !important; } html, body { background: ${s.background} !important; }`);
    return lines;
  }
  const escSq = (v) => v.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
  function styleTag(s) {
    const clean = Object.fromEntries(Object.entries(s).filter(([, v]) => v));
    const lines = styleCss(clean);
    if (!lines.length) return '';
    return `<style id="site-style" data-settings='${escSq(JSON.stringify(clean))}'>\n` +
      '    /* Page style set with tools/site-editor. */\n' +
      lines.map((l) => '    ' + l).join('\n') + '\n  </style>';
  }
  function applyLiveStyle() {
    let el = siteStyleEl();
    if (!el) { el = h('style', { id: 'site-style' }); document.head.append(el); }
    el.textContent = styleCss(settings, true).join('\n');
  }

  // ---------------------------------------------------------------- KaTeX
  let katexReady = null;
  function loadKatex() {
    if (window.katex) return Promise.resolve(window.katex);
    if (katexReady) return katexReady;
    if (!document.querySelector('link[href*="katex"]')) document.head.append(h('link', { rel: 'stylesheet', href: KATEX + 'katex.min.css' }));
    katexReady = new Promise((resolve, reject) => {
      const s = h('script', { src: KATEX + 'katex.min.js' });
      s.onload = () => resolve(window.katex);
      s.onerror = () => { katexReady = null; reject(new Error('Could not load KaTeX from cdn.jsdelivr.net.')); };
      document.head.append(s);
    });
    return katexReady;
  }
  if (document.querySelector('.tex')) loadKatex().catch(() => {});

  // ---------------------------------------------------------------- serialize
  // Untouched elements are copied byte-for-byte from the file; only what the
  // user changed is re-serialized from the DOM.
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const escText = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;');
  const escAttr = (v) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\u00a0/g, '&nbsp;');
  // Browsers type non-breaking spaces next to normal spaces and at line ends; keep deliberate ones (Fig.&nbsp;3).
  const tidySpaces = (t) => t.replace(/\u00a0(?= |$)|(?<=^| )\u00a0/g, ' ');
  const startTag = (el) => '<' + el.localName + [...el.attributes]
    .filter((a) => !editorAttr(a.name))
    .map((a) => ' ' + a.name + (a.value === '' && !['alt', 'value', 'href', 'src'].includes(a.name) ? '' : '="' + escAttr(a.value) + '"')).join('') + '>';

  function ser(node) {
    if (node.nodeType === 3) {
      const p = node.parentElement;
      if (p && (p.localName === 'script' || p.localName === 'style')) return node.data;
      return escText(p && p.closest('pre, code, .tex') ? node.data : tidySpaces(node.data));
    }
    if (node.nodeType === 8) return '<!--' + node.data + '-->';
    if (node.nodeType !== 1 || node.classList.contains(UI)) return '';
    const el = node;
    const span = SOURCE != null ? SPAN.get(el) : null;
    if (span && !changed.has(el)) return slice(span.os, span.oe);
    const inner = () => [...el.childNodes].map(ser).join('');
    if (!span) {
      // Leftovers from browser editing commands carry no meaning; keep their text only.
      if (el.localName === 'font') return inner();
      if (el.localName === 'span' && el.attributes.length === 1 && el.hasAttribute('style') && !el.closest('.tex')) return inner();
    }
    const keepTags = span && !attrsChanged.has(el);
    const open = keepTags ? slice(span.os, span.is) : startTag(el);
    if (VOID.has(el.localName)) return open;
    const close = keepTags ? slice(span.ie, span.oe) : '</' + el.localName + '>';
    return open + inner() + close;
  }
  const serialize = (region) => [...region.childNodes].map(ser).join('');

  // ---------------------------------------------------------------- save
  async function save() {
    onMutations(observer.takeRecords());
    await sourceReady;
    if (SOURCE == null) return status('This file changed on disk after the page loaded. Copy your unsaved text, then reload.', true);
    const edits = [];
    for (const r of dirty) edits.push({ start: r.__span[0], end: r.__span[1], html: serialize(r) });
    const usedFonts = [...usedInlineFonts()].filter(fontImport);
    if (usedFonts.length && !usedFonts.every((k) => (settings.inline || []).includes(k))) {
      settings.inline = [...new Set([...(settings.inline || []), ...usedFonts])];
      styleDirty = true;
    }
    const headParts = [];
    if (styleDirty) {
      const tag = styleTag(settings);
      if (meta.siteStyle) edits.push({ start: meta.siteStyle[0], end: meta.siteStyle[1], html: tag });
      else if (tag) headParts.push(tag);
    }
    if (needKatexCss && !meta.hasKatexCss) headParts.push(KATEX_LINK);
    if (headParts.length) {
      if (meta.headEnd == null) return status('This page has no </head>, so the style cannot be saved.', true);
      edits.push({ start: meta.headEnd, end: meta.headEnd, html: headParts.map((p) => '  ' + p + '\n').join('') });
    }
    if (!edits.length) return status('Nothing to save.');
    status('Saving…');
    let res, body;
    try {
      res = await fetch('/__edit/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Site-Editor': '1' },
        body: JSON.stringify({ path: meta.path, hash: meta.hash, edits }),
      });
      body = await res.json();
    } catch (err) {
      return status('Save failed: the local server is not responding. Is serve.py still running?', true);
    }
    if (!res.ok) return status('Save failed: ' + body.error, true);
    dirty.clear(); styleDirty = false; needKatexCss = false;
    try { sessionStorage.setItem('ed-scroll:' + meta.path, String(scrollY)); sessionStorage.setItem('ed-flash', 'Saved'); } catch (_) {}
    location.reload();
  }

  // ---------------------------------------------------------------- selection helpers
  let savedRange = null;
  const selRange = () => { const s = getSelection(); return s.rangeCount ? s.getRangeAt(0) : null; };
  const rememberRange = () => { const r = selRange(); if (r && regionOf(r.startContainer)) savedRange = r.cloneRange(); };
  document.addEventListener('selectionchange', rememberRange);
  const restoreRange = () => {
    if (!savedRange) return null;
    const s = getSelection(); s.removeAllRanges(); s.addRange(savedRange);
    return savedRange;
  };
  const caretAfter = (node) => {
    const r = document.createRange(); r.setStartAfter(node); r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  };
  const exec = (cmd, val = null) => {
    const r = selRange();
    if (!r || !regionOf(r.startContainer)) return status('Click into the text first.', true);
    document.execCommand(cmd, false, val);
    markDirty(regionOf(r.startContainer));
  };

  function toggleCode() {
    const r = selRange();
    const region = r && regionOf(r.startContainer);
    if (!region) return status('Select some text first.', true);
    const inCode = (r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement).closest('code');
    if (inCode && region.contains(inCode)) unwrap(inCode);
    else if (!r.collapsed) {
      const code = h('code');
      code.append(r.extractContents());
      r.insertNode(code);
      caretAfter(code);
    }
    markDirty(region);
  }

  function setInlineFont(key) {
    const r = selRange();
    const region = r && regionOf(r.startContainer);
    if (!region || r.collapsed) return status('Select the text to change its font.', true);
    const anc = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
    const existing = anc.closest('[data-font]');
    if (!key) { if (existing && region.contains(existing)) unwrap(existing); markDirty(region); return; }
    const span = h('span', { 'data-font': key, style: `font-family: ${fontStack(key)}` });
    span.append(r.extractContents());
    r.insertNode(span);
    caretAfter(span);
    applyLiveStyle(); // pulls in the Google font import for the preview
    markDirty(region);
  }

  // ---------------------------------------------------------------- popovers
  let popover = null;
  const closePopover = () => { popover?.remove(); popover = null; };
  function openPopover(anchor, content) {
    closePopover();
    popover = ui('div', { class: 'ed-pop', role: 'dialog' }, content);
    document.body.append(popover);
    const a = anchor.getBoundingClientRect();
    const p = popover.getBoundingClientRect();
    const top = a.bottom + 8 + p.height > innerHeight ? Math.max(8, a.top - p.height - 8) : a.bottom + 8;
    popover.style.top = top + 'px';
    popover.style.left = Math.max(8, Math.min(innerWidth - p.width - 8, a.left)) + 'px';
    popover.querySelector('input, textarea')?.focus();
  }
  const field = (label, input) => ui('label', { class: 'ed-field' }, ui('span', {}, label), input);
  const btn = (label, onclick, extra = {}) => ui('button', { type: 'button', onclick, ...extra }, label);

  function linkPopover(a) {
    const region = regionOf(a);
    const href = ui('input', { type: 'text', value: a.getAttribute('href') || '', placeholder: 'https://… or relative/path.html', id: 'ed-link-href' });
    const apply = () => { a.setAttribute('href', href.value.trim()); markDirty(region); closePopover(); };
    href.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
    openPopover(a, [
      field('Link', href),
      ui('div', { class: 'ed-row' },
        btn('Apply', apply, { class: 'ed-primary' }),
        btn('Open ↗', () => window.open(a.href, '_blank', 'noopener')),
        btn('Remove link', () => { unwrap(a); markDirty(region); closePopover(); })),
    ]);
  }

  function imagePopover(img) {
    const region = regionOf(img);
    const fig = img.closest('figure');
    const alt = ui('input', { type: 'text', value: img.getAttribute('alt') || '', placeholder: 'Describe the image', id: 'ed-img-alt' });
    const current = (img.style.width || '').replace('%', '');
    const width = ui('select', { id: 'ed-img-width' },
      ['', '25', '33', '50', '66', '75', '100'].map((w) => ui('option', { value: w, selected: w === current }, w ? w + '%' : 'Natural size')));
    const hasCap = !!fig?.querySelector('figcaption');
    const apply = () => {
      img.setAttribute('alt', alt.value);
      img.style.width = width.value ? width.value + '%' : '';
      img.style.maxWidth = '100%';
      markDirty(region); closePopover();
    };
    openPopover(img, [
      field('Alt text', alt), field('Width', width),
      ui('div', { class: 'ed-row' },
        btn('Apply', apply, { class: 'ed-primary' }),
        fig ? btn(hasCap ? 'Remove caption' : 'Add caption', () => {
          const cap = fig.querySelector('figcaption');
          if (cap) cap.remove(); else fig.append(h('figcaption', {}, 'Caption'));
          markDirty(region); closePopover();
        }) : null,
        btn('Delete image', () => {
          const target = fig && fig.querySelectorAll('img').length === 1 ? fig : img;
          target.remove(); markDirty(region); closePopover();
        }, { class: 'ed-danger' })),
    ]);
  }

  // ---------------------------------------------------------------- math
  async function mathPopover(existing) {
    let katex;
    try { katex = await loadKatex(); } catch (err) { return status(err.message, true); }
    const anchorRange = existing ? null : restoreRange();
    const region = existing ? regionOf(existing) : anchorRange && regionOf(anchorRange.startContainer);
    if (!region) return status('Click where the math should go, then press ∑.', true);
    const src = ui('textarea', { rows: '3', id: 'ed-tex', placeholder: 'e^{i\\pi} + 1 = 0', spellcheck: 'false' });
    src.value = existing?.dataset.tex || '';
    const display = ui('input', { type: 'checkbox', id: 'ed-tex-display', checked: existing ? existing.hasAttribute('data-display') : false });
    const preview = ui('div', { class: 'ed-tex-preview' });
    const render = () => {
      try { katex.render(src.value || '\\square', preview, { displayMode: display.checked, throwOnError: true }); preview.classList.remove('ed-err'); }
      catch (err) { preview.textContent = err.message.replace(/^KaTeX parse error: /, ''); preview.classList.add('ed-err'); }
    };
    src.addEventListener('input', render); display.addEventListener('change', render);
    const build = () => {
      const node = h('span', { class: 'tex', 'data-tex': src.value, 'data-display': display.checked || null });
      node.innerHTML = katex.renderToString(src.value, { displayMode: display.checked, throwOnError: false, output: 'htmlAndMathml' });
      node.contentEditable = 'false';
      return node;
    };
    const apply = () => {
      if (!src.value.trim()) return closePopover();
      const node = build();
      if (existing) existing.replaceWith(node);
      else { const r = anchorRange; r.deleteContents(); r.insertNode(node); caretAfter(node); }
      needKatexCss = true; markDirty(region); closePopover();
    };
    src.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); apply(); } });
    const anchorEl = existing || (anchorRange.getBoundingClientRect().width || anchorRange.getBoundingClientRect().height ? anchorRange : region);
    openPopover(anchorEl, [
      field('LaTeX', src),
      ui('label', { class: 'ed-check' }, display, ' Display (own line, centered)'),
      preview,
      ui('div', { class: 'ed-row' },
        btn(existing ? 'Update' : 'Insert', apply, { class: 'ed-primary', title: '⌘↵' }),
        existing ? btn('Delete', () => { existing.remove(); markDirty(region); closePopover(); }, { class: 'ed-danger' }) : null),
    ]);
    render();
  }

  // ---------------------------------------------------------------- images
  const filePicker = ui('input', { type: 'file', accept: 'image/*', hidden: true, id: 'ed-file' });
  document.body.append(filePicker);
  filePicker.addEventListener('change', () => { if (filePicker.files[0]) insertImage(filePicker.files[0], restoreRange()); filePicker.value = ''; });

  async function upload(file) {
    const res = await fetch(`/__edit/upload?page=${encodeURIComponent(meta.path)}&name=${encodeURIComponent(file.name || 'pasted.png')}`, {
      method: 'POST', headers: { 'X-Site-Editor': '1', 'Content-Type': file.type || 'application/octet-stream' }, body: file,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    return body.src;
  }
  const BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, figure, pre, div, section, header';
  async function insertImage(file, range) {
    const region = range && regionOf(range.startContainer);
    if (!region) return status('Click where the image should go first.', true);
    status('Uploading ' + (file.name || 'image') + '…');
    let src;
    try { src = await upload(file); } catch (err) { return status('Upload failed: ' + err.message, true); }
    const img = h('img', { src, alt: '', style: 'max-width: 100%' });
    const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const block = node.closest(BLOCKS);
    if (block && block !== region && region.contains(block) && block.tagName !== 'LI') {
      const fig = h('figure', {}, img, h('figcaption', {}, 'Caption'));
      if (block.tagName === 'P' && !block.textContent.trim() && !block.querySelector('img, .tex')) block.replaceWith(fig);
      else block.after(fig);
    } else {
      range.insertNode(img); caretAfter(img);
    }
    markDirty(region);
    status('Image added. Click it to set alt text or width.');
  }

  // ---------------------------------------------------------------- list item controls
  const itemBar = ui('div', { class: 'ed-items' });
  document.body.append(itemBar);
  let itemLi = null;
  const sibLi = (li, dir) => { let s = li[dir]; while (s && s.nodeName !== 'LI') s = s[dir]; return s; };
  function placeItemBar(li) {
    itemLi = li;
    const r = li.getBoundingClientRect();
    itemBar.replaceChildren(
      btn('↑', () => itemOp('up'), { title: 'Move up' }),
      btn('↓', () => itemOp('down'), { title: 'Move down' }),
      btn('⧉', () => itemOp('dup'), { title: 'Duplicate' }),
      li.querySelector('.blog-title') ? btn(li.querySelector('.chip-slop') ? 'unslop' : 'slop', () => itemOp('slop'), { title: 'Toggle slop chip' }) : null,
      btn('✕', () => itemOp('del'), { title: 'Delete item', class: 'ed-danger' }),
    );
    itemBar.style.display = 'flex';
    // Sit inside the item's own row, so reaching the bar never crosses a neighbour.
    itemBar.style.top = Math.max(4, r.top + (r.height - itemBar.offsetHeight) / 2) + 'px';
    itemBar.style.left = Math.max(4, r.right - itemBar.offsetWidth - 4) + 'px';
  }
  function itemOp(op) {
    const li = itemLi; if (!li) return;
    const region = regionOf(li);
    const gap = li.previousSibling?.nodeType === 3 ? li.previousSibling.data : '\n';
    if (op === 'up') { const p = sibLi(li, 'previousSibling'); if (p) p.before(li, document.createTextNode(gap)); }
    if (op === 'down') { const n = sibLi(li, 'nextSibling'); if (n) n.after(document.createTextNode(gap), li); }
    if (op === 'dup') {
      const c = li.cloneNode(true);
      // The copy has the same source as the original until someone edits it.
      const a = [li, ...li.querySelectorAll('*')], b = [c, ...c.querySelectorAll('*')];
      a.forEach((el, i) => { if (SPAN.has(el) && !changed.has(el)) SPAN.set(b[i], SPAN.get(el)); });
      li.after(document.createTextNode(gap), c);
    }
    if (op === 'del') { if (li.previousSibling?.nodeType === 3) li.previousSibling.remove(); li.remove(); itemBar.style.display = 'none'; }
    if (op === 'slop') {
      const chip = li.querySelector('.chip-slop');
      if (chip) chip.remove(); else li.querySelector('.blog-title').append(h('span', { class: 'chip chip-slop' }, 'slop'));
    }
    // Moving can leave doubled whitespace text nodes; collapse runs of them.
    li.parentElement && [...li.parentElement.childNodes].forEach((n) => {
      if (n.nodeType === 3 && !n.data.trim() && n.previousSibling?.nodeType === 3 && !n.previousSibling.data.trim()) n.remove();
    });
    markDirty(region);
    if (op !== 'del' && li.isConnected) placeItemBar(li);
  }
  document.addEventListener('mouseover', (e) => {
    if (e.target.closest?.('.' + UI)) return;
    const li = e.target.closest?.('li');
    if (li && regionOf(li)) placeItemBar(li);
    else if (!itemBar.matches(':hover')) itemBar.style.display = 'none';
  });
  addEventListener('scroll', () => { itemBar.style.display = 'none'; }, true);

  // ---------------------------------------------------------------- events inside regions
  document.addEventListener('click', (e) => {
    if (e.target.closest('.' + UI)) return;
    if (popover && !popover.contains(e.target)) closePopover();
    const region = regionOf(e.target);
    const a = e.target.closest('a');
    if (a && (region || a.closest('[data-edit]'))) e.preventDefault();
    if (!region) return;
    const tex = e.target.closest('.tex');
    if (tex) { e.preventDefault(); return mathPopover(tex); }
    if (e.target.tagName === 'IMG') return imagePopover(e.target);
    if (a && (e.metaKey || e.ctrlKey || e.altKey)) return linkPopover(a);
  }, true);
  document.addEventListener('dblclick', (e) => {
    const a = e.target.closest?.('a');
    if (a && regionOf(a)) { e.preventDefault(); linkPopover(a); }
  }, true);

  for (const r of regions) {
    r.addEventListener('paste', (e) => {
      const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
      e.preventDefault();
      if (file) return insertImage(file, selRange());
      const text = e.clipboardData.getData('text/plain');
      document.execCommand('insertText', false, text);
    });
    r.addEventListener('dragover', (e) => { if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) e.preventDefault(); });
    r.addEventListener('drop', (e) => {
      const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : selRange();
      insertImage(file, range);
    });
  }

  // ---------------------------------------------------------------- style panel
  function stylePanel(anchor) {
    const fontSelect = (key, id) => {
      const sel = ui('select', { id },
        ui('option', { value: '' }, 'Page default'),
        Object.entries(FONTS).map(([k, [label]]) => ui('option', { value: k, selected: settings[key] === k }, label)),
        settings[key]?.startsWith('g:') ? ui('option', { value: settings[key], selected: true }, fontLabel(settings[key])) : null,
        ui('option', { value: '__other' }, 'Other Google Font…'));
      sel.addEventListener('change', () => {
        let v = sel.value;
        if (v === '__other') {
          const name = prompt('Google Font family name (as on fonts.google.com):', '');
          if (!name) { sel.value = settings[key] || ''; return; }
          v = 'g:' + name.trim();
          sel.append(ui('option', { value: v, selected: true }, name.trim()));
        }
        settings[key] = v; styleDirty = true; applyLiveStyle(); refresh();
      });
      return sel;
    };
    const num = (key, id, attrs) => {
      const inp = ui('input', { type: 'number', id, value: settings[key] || '', placeholder: 'default', ...attrs });
      inp.addEventListener('input', () => { settings[key] = inp.value; styleDirty = true; applyLiveStyle(); refresh(); });
      return inp;
    };
    const color = (key, id) => {
      const on = ui('input', { type: 'checkbox', checked: !!settings[key], id: id + '-on' });
      const inp = ui('input', { type: 'color', id, value: settings[key] || (key === 'text' ? '#24231f' : '#f2f0e6') });
      const sync = () => { settings[key] = on.checked ? inp.value : ''; styleDirty = true; applyLiveStyle(); refresh(); };
      on.addEventListener('change', sync); inp.addEventListener('input', () => { on.checked = true; sync(); });
      return ui('span', { class: 'ed-inline' }, on, inp);
    };
    openPopover(anchor, [
      ui('div', { class: 'ed-pop-title' }, 'Page style · ' + meta.path),
      field('Body font', fontSelect('body', 'ed-font-body')),
      field('Heading font', fontSelect('heading', 'ed-font-heading')),
      field('Code font', fontSelect('code', 'ed-font-code')),
      field('Text size (px)', num('size', 'ed-size', { min: '10', max: '28', step: '1' })),
      field('Line height', num('lineHeight', 'ed-lh', { min: '1', max: '2.4', step: '0.05' })),
      field('Text color', color('text', 'ed-color-text')),
      field('Background', color('background', 'ed-color-bg')),
      ui('div', { class: 'ed-row' },
        btn('Reset to page default', () => { settings = {}; styleDirty = true; applyLiveStyle(); refresh(); closePopover(); }),
        btn('Done', closePopover, { class: 'ed-primary' })),
    ]);
  }

  // ---------------------------------------------------------------- toolbar
  const fontPick = ui('select', { id: 'ed-inline-font', title: 'Font for selected text' },
    ui('option', { value: '' }, 'Aa font'),
    ui('option', { value: '__clear' }, 'Remove font'),
    Object.entries(FONTS).map(([k, [label]]) => ui('option', { value: k }, label)));
  fontPick.addEventListener('mousedown', rememberRange);
  fontPick.addEventListener('change', () => {
    const v = fontPick.value; fontPick.value = '';
    restoreRange();
    if (v) setInlineFont(v === '__clear' ? '' : v);
  });
  const blockPick = ui('select', { id: 'ed-block', title: 'Paragraph style' },
    [['', '¶ style'], ['P', 'Paragraph'], ['H2', 'Heading 2'], ['H3', 'Heading 3'], ['H4', 'Heading 4'], ['BLOCKQUOTE', 'Quote'], ['PRE', 'Code block']]
      .map(([v, l]) => ui('option', { value: v }, l)));
  blockPick.addEventListener('mousedown', rememberRange);
  blockPick.addEventListener('change', () => { const v = blockPick.value; blockPick.value = ''; restoreRange(); if (v) exec('formatBlock', v); });

  const tb = (label, title, fn) => ui('button', { type: 'button', title, onmousedown: (e) => e.preventDefault(), onclick: fn }, label);
  const statusEl = ui('span', { class: 'ed-status', role: 'status' });
  const saveBtn = ui('button', { type: 'button', class: 'ed-primary', onclick: save, title: '⌘S' }, 'Save');
  const bar = ui('div', { class: 'ed-bar', role: 'toolbar', 'aria-label': 'Page editor' },
    ui('div', { class: 'ed-group' },
      blockPick,
      tb('B', 'Bold (⌘B)', () => exec('bold')),
      tb('I', 'Italic (⌘I)', () => exec('italic')),
      tb('U', 'Underline (⌘U)', () => exec('underline')),
      tb('S', 'Strikethrough', () => exec('strikeThrough')),
      tb('</>', 'Inline code', toggleCode),
      tb('🔗', 'Link (⌘K)', () => linkFromSelection()),
      tb('•', 'Bulleted list', () => exec('insertUnorderedList')),
      tb('1.', 'Numbered list', () => exec('insertOrderedList')),
      tb('∑', 'Math (LaTeX)', () => mathPopover()),
      tb('▣', 'Image', () => { rememberRange(); filePicker.click(); }),
      fontPick,
      tb('⌫', 'Clear formatting', () => exec('removeFormat'))),
    ui('div', { class: 'ed-group' },
      statusEl,
      ui('button', { type: 'button', onclick: (e) => stylePanel(e.currentTarget) }, 'Page style'),
      saveBtn,
      ui('button', { type: 'button', onclick: done }, 'Done')));
  document.body.append(bar);

  function linkFromSelection() {
    const r = selRange();
    const region = r && regionOf(r.startContainer);
    if (!region) return status('Select some text first.', true);
    const node = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    const existing = node.closest('a');
    if (existing) return linkPopover(existing);
    if (r.collapsed) return status('Select the text to turn into a link.', true);
    const a = h('a', { href: '' });
    a.append(r.extractContents()); r.insertNode(a);
    markDirty(region); linkPopover(a);
  }

  let flashTimer = null;
  function status(msg, isError = false) {
    clearTimeout(flashTimer);
    statusEl.textContent = msg;
    statusEl.classList.toggle('ed-err', isError);
    if (!isError && msg) flashTimer = setTimeout(refresh, 2500);
  }
  function refresh() {
    const n = dirty.size + (styleDirty ? 1 : 0);
    saveBtn.textContent = n ? `Save (${n})` : 'Save';
    saveBtn.disabled = !n;
    statusEl.classList.remove('ed-err');
    statusEl.textContent = n ? 'Unsaved changes' : (regions.length ? 'All changes saved' : 'No editable blocks on this page');
  }
  function done() {
    if ((dirty.size || styleDirty) && !confirm('Discard unsaved changes?')) return;
    dirty.clear(); styleDirty = false;
    location.href = location.pathname;
  }

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 's') { e.preventDefault(); save(); }
    else if (mod && e.key === 'k' && regionOf(selRange()?.startContainer)) { e.preventDefault(); linkFromSelection(); }
    else if (e.key === 'Escape') closePopover();
  });
  addEventListener('beforeunload', (e) => { if (dirty.size || styleDirty) { e.preventDefault(); e.returnValue = ''; } });

  refresh();
  try {
    const y = sessionStorage.getItem('ed-scroll:' + meta.path);
    if (y) { sessionStorage.removeItem('ed-scroll:' + meta.path); scrollTo(0, +y); }
    const flash = sessionStorage.getItem('ed-flash');
    if (flash) { sessionStorage.removeItem('ed-flash'); status(flash); }
  } catch (_) {}
})();
