// Sidebar renderer. The host sends a finished view model; this file only
// paints it. No fetch, no token, no navigation state — the host owns all three.

(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  const GLYPH = {
    success: '\u2713',
    failure: '\u2715',
    running: '\u25CF',
    pending: '\u25CB',
    muted: '\u00B7',
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, label, act, title) {
    const node = el('button', className, label);
    node.type = 'button';
    node.dataset.act = act;
    if (title) node.title = title;
    return node;
  }

  function renderRow(row) {
    // Log lines are text, not an affordance: no button, no hover, selectable.
    if (row.kind === 'log') {
      const line = el('div', 'log-line', row.title);
      line.style.paddingLeft = 6 + row.depth * 12 + 'px';
      return line;
    }

    const node = el('button', row.kind === 'section' ? 'row section' : 'row');
    node.type = 'button';
    node.dataset.id = row.id;
    node.dataset.tone = row.tone;
    node.title = row.tip || row.title;
    node.style.paddingLeft = 6 + row.depth * 12 + 'px';
    if (row.expanded !== undefined) node.setAttribute('aria-expanded', String(row.expanded));

    if (row.kind === 'section' || row.kind === 'group') {
      node.append(el('span', 'chev', row.expanded ? '\u25BE' : '\u25B8'));
    } else {
      const dot = el('span', 'dot', GLYPH[row.tone] || GLYPH.muted);
      dot.dataset.tone = row.tone;
      node.append(dot);
    }

    node.append(el('span', 'label', row.title));
    if (row.meta) node.append(el('span', 'meta', row.meta));
    return node;
  }

  function render(view) {
    app.textContent = '';

    const head = el('div', 'head');
    if (view.canGoBack) {
      head.append(button('icon', '\u2190', 'back', 'Back'));
    }
    // The aggregate state the status-bar item used to show.
    const status = el('span', 'dot', GLYPH[view.status] || GLYPH.muted);
    status.dataset.tone = view.status;
    if (view.statusTip) status.title = view.statusTip;
    head.append(status, el('span', 'title', view.title));
    head.append(el('span', 'spacer'));
    if (view.busy) head.append(el('span', 'busy', '\u2026'));
    head.append(button('icon', '\u21BB', 'refresh', 'Refresh'));
    app.append(head);

    // A 2px indeterminate bar: the cheapest "something is happening" there is.
    if (view.busy) {
      const bar = el('div', 'progress');
      bar.append(el('i'));
      app.append(bar);
    }

    if (view.subtitle) app.append(el('div', 'sub', view.subtitle));

    // A network load (jobs, or a step log) can take a second or two: say so,
    // and make the rows unclickable so a second click cannot queue another.
    app.setAttribute('aria-busy', String(view.busy));

    if (view.error) app.append(el('p', 'error', view.error));

    // The session check is silent and usually instant, but until it answers we
    // must not show a sign-in button that would then vanish.
    if (view.authPending) {
      app.append(el('p', 'note', 'Checking your GitHub session…'));
      return;
    }

    if (!view.signedIn) {
      const card = el('div', 'signin');
      card.append(
        el(
          'p',
          'note',
          'Reading Actions on a private repository needs a GitHub session. VS Code holds the token.',
        ),
      );
      card.append(button('primary', 'Sign in with GitHub', 'signin'));
      app.append(card);
      return;
    }

    if (view.rows.length === 0) {
      app.append(el('p', 'note', view.hint || 'Nothing to show yet.'));
      return;
    }

    const list = el('div', view.busy ? 'list is-loading' : 'list');
    for (const row of view.rows) {
      list.append(renderRow(row));
      // Skeleton lines under the row that is being fetched, so the wait is
      // attached to what was clicked instead of floating at the bottom.
      if (view.busyKey === row.id) {
        for (let i = 0; i < 3; i += 1) list.append(el('div', 'skeleton'));
      }
    }
    app.append(list);

    if (view.footer) app.append(el('p', 'foot', view.footer));
  }

  app.addEventListener('click', (event) => {
    const target =
      event.target instanceof Element ? event.target.closest('[data-act],[data-id]') : null;
    if (!target) return;

    if (target.dataset.id) {
      vscode.postMessage({ type: 'select', id: target.dataset.id });
      return;
    }
    const act = target.dataset.act;
    if (act === 'refresh' || act === 'signin' || act === 'back') {
      vscode.postMessage({ type: act });
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message && message.type === 'view') render(message.view);
  });

  vscode.postMessage({ type: 'ready' });
})();
