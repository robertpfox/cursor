import api from './api.js';
import { $, h, icon, mount, relTime } from './dom.js';
import store from './store.js';
import { toast } from './ui.js';
import { currentPath, matchRoute, navigate, onRoute, startRouter } from './router.js';
import { renderAuth } from './views/auth.js';
import { renderDashboard, watchDashboard } from './views/dashboard.js';
import { renderBot, watchBot } from './views/bot.js';
import { renderRun, watchRun } from './views/run.js';
import { renderApprovals, watchApprovals } from './views/approvals.js';
import { renderActivity, watchActivity } from './views/activity.js';
import { renderSettings } from './views/settings.js';

const NAV = [
  { path: '/', label: 'Dashboard', icon: 'home' },
  { path: '/approvals', label: 'Approvals', icon: 'shield', counter: 'approvals' },
  { path: '/activity', label: 'Activity', icon: 'chart' },
  { path: '/settings', label: 'Settings', icon: 'gear' },
];

const ROUTES = [
  { pattern: '/', title: 'Dashboard', render: (view) => renderDashboard(view), watch: watchDashboard },
  { pattern: '/approvals', title: 'Approvals', render: (view) => renderApprovals(view), watch: watchApprovals },
  { pattern: '/activity', title: 'Activity', render: (view) => renderActivity(view), watch: watchActivity },
  { pattern: '/settings', title: 'Settings', render: (view) => renderSettings(view) },
  {
    pattern: '/bots/:id',
    title: 'Teammate',
    render: (view, params) => renderBot(view, params.id),
    watch: (view, params) => watchBot(view, params.id),
  },
  {
    pattern: '/runs/:id',
    title: 'Run',
    render: (view, params) => renderRun(view, params.id),
    watch: (view, params) => watchRun(view, params.id),
  },
];

let disposeWatcher = null;

function renderNav() {
  const nav = $('#nav');
  const path = currentPath();
  mount(
    nav,
    ...NAV.map((entry) => {
      const active = entry.path === '/' ? path === '/' : path.startsWith(entry.path);
      const count = entry.counter ? store.counts[entry.counter] : 0;
      return h(
        'button',
        {
          type: 'button',
          class: `navlink${active ? ' is-active' : ''}`,
          onclick: () => {
            navigate(entry.path);
            $('#sidebar').classList.remove('is-open');
          },
        },
        icon(entry.icon),
        h('span', entry.label),
        count ? h('span', { class: 'count is-hot' }, String(count)) : null,
      );
    }),
  );
}

async function openDrawer() {
  const drawer = $('#drawer');
  const scrim = $('#scrim');
  drawer.hidden = false;
  scrim.hidden = false;

  const payload = await api.get('/api/notifications?limit=60').catch(() => ({ items: [] }));
  mount(
    $('#drawerBody'),
    ...(payload.items.length
      ? payload.items.map((item) =>
          h(
            'div',
            { class: `note note--${item.level}${item.readAt ? '' : ' is-unread'}` },
            h('div', { class: 'note__title' }, item.title),
            item.body ? h('div', { class: 'note__body' }, item.body) : null,
            h(
              'div',
              { class: 'row tiny muted', style: { marginTop: '5px' } },
              h('span', relTime(item.createdAt)),
              item.runId
                ? h(
                    'button',
                    {
                      class: 'btn btn--ghost btn--sm',
                      type: 'button',
                      onclick: () => {
                        closeDrawer();
                        navigate(`/runs/${item.runId}`);
                      },
                    },
                    'Open run',
                  )
                : null,
            ),
          ),
        )
      : [h('p', { class: 'muted small', style: { padding: '14px' } }, 'Nothing yet.')]),
  );
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#scrim').hidden = true;
}

function updateBadges() {
  const badge = $('#bellBadge');
  const count = store.counts.notifications;
  badge.hidden = !count;
  badge.textContent = count > 99 ? '99+' : String(count);
  renderNav();
}

async function renderRoute() {
  const view = $('#view');
  const path = currentPath();

  disposeWatcher?.();
  disposeWatcher = null;

  for (const route of ROUTES) {
    const params = matchRoute(path, route.pattern);
    if (!params) continue;
    $('#pageTitle').textContent = route.title;
    try {
      await route.render(view, params);
      disposeWatcher = route.watch?.(view, params) ?? null;
    } catch (error) {
      if (error.status === 401) {
        boot();
        return;
      }
      mount(
        view,
        h(
          'div',
          { class: 'view__inner' },
          h(
            'div',
            { class: 'empty' },
            h('h3', 'Could not load this page'),
            h('p', { class: 'small' }, error.message),
            h('button', { class: 'btn btn--sm', type: 'button', onclick: () => renderRoute() }, 'Try again'),
          ),
        ),
      );
    }
    return;
  }

  $('#pageTitle').textContent = 'Not found';
  mount(
    view,
    h(
      'div',
      { class: 'view__inner' },
      h(
        'div',
        { class: 'empty' },
        h('h3', 'No such page'),
        h('button', { class: 'btn btn--sm', type: 'button', onclick: () => navigate('/') }, 'Back to dashboard'),
      ),
    ),
  );
}

function wireShell() {
  $('#menuToggle').addEventListener('click', () => $('#sidebar').classList.toggle('is-open'));
  $('#scrim').addEventListener('click', () => {
    closeDrawer();
    $('#sidebar').classList.remove('is-open');
  });
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#bellBtn').addEventListener('click', () => {
    if ($('#drawer').hidden) openDrawer();
    else closeDrawer();
  });
  $('#markRead').addEventListener('click', async () => {
    await api.post('/api/notifications/read', {});
    store.counts = { ...store.counts, notifications: 0 };
    updateBadges();
    openDrawer();
  });
  $('#signOut').addEventListener('click', async () => {
    await api.post('/api/logout');
    store.disconnect();
    location.reload();
  });

  store.on('counts', updateBadges);
  store.on('connection', (connected) => {
    const node = $('#connState');
    node.classList.toggle('is-down', !connected);
    node.lastChild.textContent = connected ? 'live' : 'offline';
  });
  store.on('approval.created', (payload) => {
    toast(`${payload.approval.kind === 'question' ? 'A teammate has a question' : 'A teammate needs approval'}`, 'error');
  });

  onRoute(() => {
    renderNav();
    renderRoute();
  });
}

async function boot() {
  const session = await store.loadSession();

  if (!session.authenticated) {
    $('#boot').hidden = true;
    $('#app').hidden = true;
    let authRoot = document.getElementById('authRoot');
    if (!authRoot) {
      authRoot = h('div', { id: 'authRoot' });
      document.body.append(authRoot);
    }
    renderAuth(authRoot, {
      needsSetup: session.needsSetup,
      setupAllowed: session.setupAllowed,
      onSuccess: () => location.reload(),
    });
    return;
  }

  document.getElementById('authRoot')?.remove();
  $('#boot').hidden = true;
  $('#app').hidden = false;
  $('#hostName').textContent = session.user?.displayName || session.user?.username || 'self-hosted';

  wireShell();
  store.connect();
  await store.refreshCounts().catch(() => {});
  updateBadges();
  startRouter();

  api
    .get('/api/settings')
    .then((settings) => {
      $('#hostName').textContent = settings.host.hostname;
      $('#hostChip').title = `GrotFoxy v${settings.host.version} on ${settings.host.hostname} — no subscription, no cloud`;
    })
    .catch(() => {});
}

boot().catch((error) => {
  mount(
    $('#boot'),
    h('div', { class: 'boot__mark' }),
    h('p', `Could not reach GrotFoxy: ${error.message}`),
  );
});
