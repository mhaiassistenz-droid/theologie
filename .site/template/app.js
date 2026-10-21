(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const tree = JSON.parse($('tree-data').textContent);
  const SITE_TITLE = document.body.dataset.title;
  const HOME_TITLE = 'Knowledge'; // Überschrift der Startseite
  const mobile = matchMedia('(max-width: 800px)');

  const treeEl = $('tree');
  const contentEl = $('content');
  const crumbEl = $('breadcrumb');
  const sidebar = $('sidebar');
  const backdrop = $('backdrop');
  const menuBtn = $('menu-btn');

  const CHEVRON = '<svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ------------------------------------------------------------ Index

  const notes = new Map(); // slug -> { name, slug, parents: [ordnernamen] }
  const order = [];
  (function index(nodes, parents) {
    for (const n of nodes) {
      if (n.c) index(n.c, [...parents, n.n]);
      else {
        const info = { name: n.n, slug: n.s, parents, empty: !!n.e };
        notes.set(n.s, info);
        order.push(info);
      }
    }
  })(tree, []);

  // ------------------------------------------------------------ Ordnerbaum

  const STORE = 'vault-reader:open-folders';
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(STORE)); } catch (_) { /* privater Modus */ }
  const openFolders = new Set(Array.isArray(stored) ? stored : tree.filter((n) => n.c).map((n) => n.n));
  const saveOpen = () => {
    try { localStorage.setItem(STORE, JSON.stringify([...openFolders])); } catch (_) { /* egal */ }
  };

  const folderEls = new Map(); // pfad -> { wrap, btn }
  const noteEls = new Map(); // slug -> <a>

  function setFolder(pathKey, open) {
    const f = folderEls.get(pathKey);
    if (!f) return;
    f.wrap.classList.toggle('is-collapsed', !open);
    f.btn.setAttribute('aria-expanded', String(open));
    if (open) openFolders.add(pathKey);
    else openFolders.delete(pathKey);
  }

  // Liegt im Vault nur ein einziger Ordner, direkt dessen Inhalt zeigen (Titel steht schon oben).
  const single = tree.length === 1 && tree[0].c;

  (function build(nodes, parentKey, container) {
    for (const n of nodes) {
      if (n.c) {
        const key = parentKey ? `${parentKey}/${n.n}` : n.n;
        const wrap = el('div', 'tree-folder');
        const btn = el('button', 'tree-item folder-title');
        btn.type = 'button';
        btn.innerHTML = CHEVRON;
        btn.title = n.n;
        btn.append(el('span', null, n.n));
        btn.addEventListener('click', () => {
          setFolder(key, wrap.classList.contains('is-collapsed'));
          saveOpen();
        });
        const kids = el('div', 'tree-children');
        kids.setAttribute('role', 'group');
        wrap.append(btn, kids);
        container.append(wrap);
        folderEls.set(key, { wrap, btn });
        setFolder(key, openFolders.has(key));
        build(n.c, key, kids);
      } else {
        const a = el('a', 'tree-item note-title', n.n);
        a.href = `#/${n.s}`;
        a.title = n.n;
        container.append(a);
        noteEls.set(n.s, a);
      }
    }
  })(single ? tree[0].c : tree, single ? tree[0].n : '', treeEl);

  $('collapse-all').addEventListener('click', () => {
    for (const key of folderEls.keys()) setFolder(key, false);
    saveOpen();
  });

  function reveal(info) {
    let key = '';
    for (const p of info.parents) {
      key = key ? `${key}/${p}` : p;
      setFolder(key, true);
    }
    saveOpen();
  }

  function setActive(slug) {
    for (const a of treeEl.querySelectorAll('.is-active')) {
      a.classList.remove('is-active');
      a.removeAttribute('aria-current');
    }
    const a = noteEls.get(slug);
    if (!a) return;
    a.classList.add('is-active');
    a.setAttribute('aria-current', 'page');
    const r = a.getBoundingClientRect();
    const s = sidebar.getBoundingClientRect();
    if (r.top < s.top + 48 || r.bottom > s.bottom) sidebar.scrollTop += r.top - s.top - s.height / 2;
  }

  // ------------------------------------------------------------ Drawer (Handy)

  const isOpen = () => document.body.classList.contains('drawer-open');

  function setDrawer(open) {
    document.body.classList.toggle('drawer-open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
    sidebar.inert = mobile.matches && !open;
  }

  menuBtn.addEventListener('click', () => setDrawer(!isOpen()));
  $('close-btn').addEventListener('click', () => setDrawer(false));
  backdrop.addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) setDrawer(false);
  });
  mobile.addEventListener('change', () => setDrawer(false));
  treeEl.addEventListener('click', (e) => {
    if (mobile.matches && e.target.closest('a')) setDrawer(false);
  });

  // Wischen: rechts = Verzeichnis einfliegen lassen, links = wegwischen.
  let g = null;

  function scrollsSideways(node) {
    for (; node && node !== document.body; node = node.parentElement) {
      if (node.scrollWidth > node.clientWidth + 1) {
        const ox = getComputedStyle(node).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
      }
    }
    return false;
  }

  document.addEventListener('touchstart', (e) => {
    if (!mobile.matches || e.touches.length !== 1) return;
    const open = isOpen();
    if (!open && (!e.target.closest('#main') || scrollsSideways(e.target))) return;
    const t = e.touches[0];
    g = { x0: t.clientX, y0: t.clientY, open, lock: null, x: 0, w: sidebar.offsetWidth, samples: [] };
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!g) return;
    const t = e.touches[0];
    const dx = t.clientX - g.x0;
    const dy = t.clientY - g.y0;
    if (!g.lock) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      const sideways = Math.abs(dx) > Math.abs(dy) * 1.2;
      if (!sideways || (!g.open && dx < 0) || (g.open && dx > 0 && !e.target.closest('#backdrop, #sidebar'))) {
        g = null;
        return;
      }
      g.lock = 'x';
      g.x0 = t.clientX; // ohne Sprung starten
      document.body.classList.add('dragging');
    }
    e.preventDefault();
    const d = t.clientX - g.x0;
    g.x = Math.max(-g.w, Math.min(0, g.open ? d : -g.w + d));
    g.samples.push([performance.now(), g.x]);
    if (g.samples.length > 5) g.samples.shift();
    sidebar.style.transform = `translateX(${g.x}px)`;
    backdrop.style.opacity = String(1 + g.x / g.w);
  }, { passive: false });

  function endDrag() {
    if (!g) return;
    const drag = g;
    g = null;
    if (drag.lock !== 'x') return;
    const [first, last] = [drag.samples[0], drag.samples[drag.samples.length - 1]];
    const v = first && last && last[0] > first[0] ? (last[1] - first[1]) / (last[0] - first[0]) : 0;
    const open = v > 0.35 ? true : v < -0.35 ? false : 1 + drag.x / drag.w > 0.5;
    document.body.classList.remove('dragging');
    void sidebar.offsetWidth; // Transition wieder scharf schalten, dann animiert loslassen
    sidebar.style.transform = '';
    backdrop.style.opacity = '';
    setDrawer(open);
  }
  document.addEventListener('touchend', endDrag);
  document.addEventListener('touchcancel', endDrag);

  // ------------------------------------------------------------ Seiten

  function setCrumbs(parts) {
    crumbEl.replaceChildren();
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      const cls = last ? 'current' : i === parts.length - 2 ? 'parent' : 'anc';
      if (i > 0) crumbEl.append(el('span', `sep${i < parts.length - 1 ? ' anc' : ''}`, '/'));
      crumbEl.append(el('span', cls, p));
    });
  }

  function page(title, bodyNodes) {
    const h = el('h1', 'inline-title', title);
    contentEl.replaceChildren(h, ...bodyNodes);
  }

  function showHome() {
    document.title = SITE_TITLE;
    setActive(null);
    setCrumbs([HOME_TITLE]);
    const lead = el('p', 'home-lead', `${order.length} Notizen. Wähle eine Notiz aus dem Verzeichnis.`);
    const fig = el('figure', 'home-figure');
    const img = el('img');
    img.src = 'img/startbild.jpg';
    img.alt = 'Thomas Cole: The Course of Empire – Destruction (1836)';
    img.width = 1830;
    img.height = 1118;
    img.decoding = 'async';
    fig.append(img);
    const btn = el('button', 'home-open', 'Verzeichnis öffnen');
    btn.type = 'button';
    btn.addEventListener('click', () => setDrawer(true));
    page(HOME_TITLE, [lead, fig, btn]);
    window.scrollTo(0, 0);
  }

  function showMessage(title, text) {
    page(title, [el('p', 'home-lead', text)]);
  }

  const cache = new Map();
  let current = null;

  async function route() {
    const slug = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    if (!slug) return showHome();

    const info = notes.get(slug);
    if (!info) {
      setActive(null);
      setCrumbs([SITE_TITLE]);
      return showMessage('Nicht gefunden', 'Diese Notiz gibt es nicht (mehr). Wähle eine aus dem Verzeichnis.');
    }

    current = slug;
    document.title = `${info.name} · ${SITE_TITLE}`;
    reveal(info);
    setActive(slug);
    setCrumbs([...info.parents, info.name]);

    if (info.empty) {
      page(info.name, [el('p', 'empty-note', 'Noch kein Inhalt.')]);
      window.scrollTo(0, 0);
      return;
    }

    let html = cache.get(slug);
    if (html == null) {
      contentEl.setAttribute('aria-busy', 'true');
      try {
        const res = await fetch(`n/${slug}.html`, { cache: 'no-cache' });
        if (!res.ok) throw new Error(res.status);
        html = await res.text();
        cache.set(slug, html);
      } catch (_) {
        if (current === slug) showMessage('Konnte nicht geladen werden', 'Bitte Verbindung prüfen und die Seite neu laden.');
        return;
      } finally {
        contentEl.removeAttribute('aria-busy');
      }
    }
    if (current !== slug) return;

    const body = el('div', 'markdown');
    body.innerHTML = html;
    page(info.name, [body]);
    const y = history.state && typeof history.state.y === 'number' ? history.state.y : 0;
    window.scrollTo(0, y);
  }

  // Scroll-Position je Verlaufseintrag merken, damit "Zurück" an die alte Stelle springt.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  let scrollTimer = 0;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      try { history.replaceState({ y: window.scrollY }, ''); } catch (_) { /* Limit erreicht */ }
    }, 250);
  }, { passive: true });

  $('back-btn').addEventListener('click', () => history.back());
  $('fwd-btn').addEventListener('click', () => history.forward());

  window.addEventListener('hashchange', route);
  setDrawer(false);
  route();
  if (mobile.matches && !location.hash) setDrawer(true);
})();
