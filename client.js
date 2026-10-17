// dsh-literature-agents — browser half.
//
// One compact switch in the composer tool row: whether the literature tools and
// their standing guide are available in THIS conversation. The Host half that
// owns the state and the gate is `index.js` in this same package, which serves
// the two routes this button reads and flips under /plugins/dsh-literature-agents.
//
// The button is deliberately the only control for this choice: turning the
// feature off decides what the model can see, so the agent must not be able to
// flip it on its own. There is no tool for that, by design.

window.__ModuleLoader__.load({
  // Must equal the package name: the Host composes this module into the Web
  // boot graph under the package that declares `dsh.client`.
  id: 'dsh-literature-agents',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Host routes served by dsh-literature-agents. */
    const ROUTE = '/plugins/dsh-literature-agents';
    /** Compact controls at the left of the composer tool row. */
    const SLOT = 'conversation.input.left';
    /** This entry's id inside that slot. */
    const ENTRY_ID = 'literature-toggle';

    // Host theme tokens only: the switch must read as part of the composer in
    // both light and dark themes.
    const CSS = [
      '.dslt-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px;',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;',
      'color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;',
      'cursor:pointer;white-space:nowrap;opacity:.72;',
      'transition:opacity .15s,color .15s,border-color .15s}',
      '.dslt-btn:hover:not(:disabled){opacity:1}',
      '.dslt-btn[data-on="1"]{opacity:1;color:var(--dsw-alias-brand-primary);',
      'border-color:var(--dsw-alias-brand-primary)}',
      '.dslt-btn[data-failed="1"]{color:var(--dsw-alias-state-warn-primary)}',
      '.dslt-btn:disabled{cursor:progress}',
      '.dslt-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dslt-icon{flex:none;width:14px;height:14px;display:block}',
      '.dslt-label{flex:none}',
      '.dslt-dot{flex:none;width:6px;height:6px;border-radius:50%;',
      'background:var(--dsw-alias-state-idle-primary)}',
      '.dslt-btn[data-on="1"] .dslt-dot{background:var(--dsw-alias-brand-primary)}',
    ].join('');

    /** The book glyph, drawn inline so the button needs no asset request. */
    function BookIcon() {
      return h(
        'svg',
        {
          className: 'dslt-icon',
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M4 5.5h6.2c1.1 0 1.8.7 1.8 1.7V20c0-.9-.7-1.6-1.6-1.6H4z' }),
        h('path', { d: 'M20 5.5h-6.2c-1.1 0-1.8.7-1.8 1.7V20c0-.9.7-1.6 1.6-1.6H20z' }),
        h('path', { d: 'M7 9h3M7 12.5h3M15 9h2.5M15 12.5h2.5' }),
      );
    }

    /** @param {string} sessionId */
    function readState(sessionId) {
      return fetch(ROUTE + '/state?session=' + encodeURIComponent(sessionId), {
        cache: 'no-store',
      }).then(function (response) {
        return response.ok ? response.json() : null;
      });
    }

    /** @param {string} sessionId */
    function flipState(sessionId) {
      return fetch(ROUTE + '/toggle', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId }),
      }).then(function (response) {
        return response.ok ? response.json() : null;
      });
    }

    /**
     * The switch. `enabled === null` means the Host has not answered yet, so the
     * button shows a muted reading state and a click retries instead of guessing.
     */
    function LiteratureToggle(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
      const [enabled, setEnabled] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [failed, setFailed] = React.useState(false);

      React.useEffect(
        function () {
          if (sessionId === '') return undefined;
          let live = true;
          setEnabled(null);
          setFailed(false);
          readState(sessionId)
            .then(function (answer) {
              if (!live) return;
              if (answer !== null && typeof answer.enabled === 'boolean') {
                setEnabled(answer.enabled);
              } else {
                setFailed(true);
              }
            })
            .catch(function () {
              if (live) setFailed(true);
            });
          return function () {
            live = false;
          };
        },
        [sessionId],
      );

      const toggle = function () {
        if (busy || sessionId === '') return;
        setBusy(true);
        setFailed(false);
        const request = enabled === null ? readState(sessionId) : flipState(sessionId);
        request
          .then(function (answer) {
            if (answer !== null && typeof answer.enabled === 'boolean') {
              setEnabled(answer.enabled);
            } else {
              setFailed(true);
            }
          })
          .catch(function () {
            setFailed(true);
          })
          .finally(function () {
            setBusy(false);
          });
      };

      const on = enabled === true;
      const title = failed
        ? '古籍插件状态读取失败：点击重试'
        : on
          ? '古籍插件已开启（本对话）：点击关闭，下一轮生效'
          : enabled === false
            ? '古籍插件已关闭（本对话）：点击开启'
            : '正在读取古籍插件状态…';

      const button = h(
        'button',
        {
          type: 'button',
          className: 'dslt-btn',
          role: 'switch',
          'aria-checked': on,
          'aria-label': title,
          title: title,
          'data-on': on ? '1' : '0',
          'data-failed': failed ? '1' : '0',
          disabled: busy,
          onClick: toggle,
        },
        BookIcon(),
        h('span', { className: 'dslt-label' }, '古籍'),
        h('span', { className: 'dslt-dot' }),
      );

      return h(React.Fragment, null, h('style', null, CSS), button);
    }

    return {
      inject: ['slots'],
      apply: function (ctx) {
        ctx.slots.inject(SLOT, function () {
          return ctx.slots.register(
            { name: SLOT, id: ENTRY_ID, order: 20 },
            LiteratureToggle,
          );
        });
      },
    };
  },
});
