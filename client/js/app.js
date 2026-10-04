const state = {
  user: null,
  view: 'dashboard',
  authMode: 'login',
  currentTicketId: null,
  tickets: [],
  departments: [],
  categories: [],
  ticketFilters: {},
};

const $app = document.getElementById('app');

function toast(msg, type = '') {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s.includes('T') || s.includes('Z') ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return s;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------- bootstrap
async function boot() {
  const t = API.token();
  if (!t) return renderAuth();
  try {
    const { user } = await API.get('/auth/me');
    state.user = user;
    await loadLookups();
    setDefaultView();
    render();
  } catch (e) {
    API.setToken(null);
    renderAuth();
  }
}

function setDefaultView() {
  state.view = 'home';
}

// --------------------------------------------------- custom <select> dropdowns
// Progressive enhancement: the real <select> stays in the DOM (so FormData and
// every existing .value / onchange read keeps working); we hide it and drive it
// from a styled button + a listbox that is portalled to <body> and fixed-
// positioned, so it never clips or bleeds through table / card overflow.
let ddOpen = null;
function enhanceSelects(root) {
  if (!root) return;
  root.querySelectorAll('select:not([data-dd])').forEach((sel) => {
    sel.dataset.dd = '1';
    const caret =
      '<svg class="dd-caret" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const wrap = document.createElement('div');
    wrap.className = 'dd';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dd-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    const menu = document.createElement('div');
    menu.className = 'dd-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;

    const paint = () => {
      const o = sel.options[sel.selectedIndex];
      btn.innerHTML = `<span class="dd-val">${esc(o ? o.text : '')}</span>${caret}`;
    };
    const items = [...sel.options].map((o, i) => {
      const it = document.createElement('button');
      it.type = 'button';
      it.className = 'dd-item';
      it.setAttribute('role', 'option');
      it.textContent = o.text;
      if (o.disabled) it.disabled = true;
      it.addEventListener('click', () => {
        sel.selectedIndex = i;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        close(true);
      });
      menu.appendChild(it);
      return it;
    });
    const mark = () => items.forEach((it, i) => it.setAttribute('aria-selected', i === sel.selectedIndex ? 'true' : 'false'));

    const place = () => {
      const r = btn.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      menu.style.minWidth = r.width + 'px';
      menu.style.left = Math.min(r.left, window.innerWidth - Math.max(r.width, 180) - 12) + 'px';
      menu.style.maxHeight = Math.max(140, Math.min(288, (below > 200 ? below : r.top) - 16)) + 'px';
      if (below < 200 && r.top > below) {
        menu.style.top = 'auto';
        menu.style.bottom = window.innerHeight - r.top + 6 + 'px';
      } else {
        menu.style.bottom = 'auto';
        menu.style.top = r.bottom + 6 + 'px';
      }
    };
    let onDoc = null;
    const open = () => {
      if (ddOpen && ddOpen !== close) ddOpen();
      ddOpen = close;
      document.body.appendChild(menu);
      menu.hidden = false;
      wrap.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      place();
      (items[sel.selectedIndex] || items.find((i) => !i.disabled) || btn).focus();
      onDoc = (e) => { if (!menu.contains(e.target) && e.target !== btn) close(); };
      setTimeout(() => document.addEventListener('click', onDoc, true), 0);
      window.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);
    };
    const close = (refocus) => {
      menu.hidden = true;
      wrap.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      if (menu.parentNode) menu.parentNode.removeChild(menu);
      if (onDoc) document.removeEventListener('click', onDoc, true);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      onDoc = null;
      if (ddOpen === close) ddOpen = null;
      if (refocus) btn.focus();
    };
    btn.addEventListener('click', () => (menu.hidden ? open() : close()));
    const onKey = (e) => {
      const live = items.filter((i) => !i.disabled);
      if (e.key === 'Escape' && !menu.hidden) { e.preventDefault(); close(true); }
      else if (menu.hidden && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') && document.activeElement === btn) {
        e.preventDefault(); open();
      } else if (!menu.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        let i = live.indexOf(document.activeElement);
        i = e.key === 'ArrowDown' ? Math.min(live.length - 1, i + 1) : Math.max(0, i - 1);
        live[i] && live[i].focus();
      }
    };
    btn.addEventListener('keydown', onKey);
    menu.addEventListener('keydown', onKey);

    sel.addEventListener('change', () => { paint(); mark(); });
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    wrap.appendChild(btn);
    paint();
    mark();
  });
}

async function loadLookups() {
  try {
    const [d, c] = await Promise.all([API.get('/departments'), API.get('/categories')]);
    state.departments = d.departments;
    state.categories = c.categories;
  } catch (e) {
    /* non-fatal */
  }
}

// -------------------------------------------------------------------- auth
function renderAuth() {
  const isLogin = state.authMode === 'login';
  $app.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-shell">
        <aside class="auth-aside">
          <div class="auth-aside-brand"><span class="mark"></span> Campus Helpdesk</div>
          <div class="auth-aside-copy">
            <h2>Support, triaged the moment it&rsquo;s reported.</h2>
            <p>Every ticket is auto-classified and routed to the right desk, and site visits are scheduled and tracked to completion.</p>
          </div>
          <div class="auth-aside-foot">Campus IT &amp; Facilities</div>
        </aside>
        <div class="auth-card">
          <h1 class="auth-title">${isLogin ? 'Sign in' : 'Create your account'}</h1>
          <p class="auth-sub">${isLogin ? 'Use your campus account to continue.' : 'Students can self-register here.'}</p>
          <div id="auth-error"></div>
          <form id="auth-form">
            ${!isLogin ? `<div class="field"><label>Full name</label><input name="name" required /></div>` : ''}
            <div class="field"><label>Email</label><input name="email" type="email" autocomplete="email" required /></div>
            <div class="field"><label>Password</label><input name="password" type="password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" required minlength="6" /></div>
            <button class="btn block" type="submit">${isLogin ? 'Sign in' : 'Create account'}</button>
          </form>
          <div class="auth-toggle">
            ${isLogin ? `New here? <a id="toggle-auth">Create a student account</a>` : `Already have an account? <a id="toggle-auth">Sign in</a>`}
          </div>
        </div>
      </div>
    </div>`;

  document.getElementById('toggle-auth').onclick = () => {
    state.authMode = isLogin ? 'register' : 'login';
    renderAuth();
  };

  document.getElementById('auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    const errBox = document.getElementById('auth-error');
    errBox.innerHTML = '';
    try {
      const { token, user } = isLogin
        ? await API.post('/auth/login', payload)
        : await API.post('/auth/register', payload);
      API.setToken(token);
      state.user = user;
      await loadLookups();
      setDefaultView();
      render();
    } catch (err) {
      errBox.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }
  };
}

function logout() {
  API.setToken(null);
  state.user = null;
  renderAuth();
}

// -------------------------------------------------------------------- shell
const NAV = {
  STUDENT: [['queue', 'My tickets'], ['newticket', 'New ticket']],
  STAFF: [['queue', 'Department queue']],
  LEAD: [['queue', 'Department queue']],
  ADMIN: [['queue', 'All tickets'], ['users', 'Users']],
  CUSTODIAN: [['queue', 'Department queue']],
};
// admin's Dashboard already shows the full system overview inline, so there is
// no separate "Overview" tab/tile.
const TILE_DESC = {
  queue: 'Browse, filter and open tickets',
  newticket: 'Report a new problem for auto-triage',
  users: 'Roles, departments and account status',
};
const HOME_SUB = {
  ADMIN: 'System health and the whole ticket queue at a glance.',
  STAFF: 'Everything open for your department.',
  LEAD: 'Everything open for your department.',
  CUSTODIAN: 'Hostel and facilities tickets that need attention.',
  STUDENT: 'Track your requests or report something new.',
};

function goto(view) {
  state.view = view;
  state.currentTicketId = null;
  render();
}

function render() {
  const role = state.user.role;
  const navItems = [['home', 'Dashboard'], ...(NAV[role] || [])];
  const activeKey = state.view === 'ticket' ? 'queue' : state.view;
  $app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <button class="brand-btn" id="home-btn">
          <span class="mark"></span><span class="brand-name">Campus Helpdesk</span>
        </button>
        <nav class="topnav">
          ${navItems
            .map(([key, label]) => `<button data-nav="${key}" class="${activeKey === key ? 'active' : ''}">${label}</button>`)
            .join('')}
        </nav>
        <div class="topbar-user">
          <span class="who"><b>${esc(state.user.name)}</b><span class="role-tag">${role}</span></span>
          <button class="logout-btn" id="logout-btn">Log out</button>
        </div>
      </header>
      <main class="content" id="content"></main>
    </div>`;

  document.getElementById('logout-btn').onclick = logout;
  document.getElementById('home-btn').onclick = () => goto('home');
  $app.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.onclick = () => goto(btn.dataset.nav);
  });

  renderView();
}

async function renderHome(content) {
  content.innerHTML = `<div class="empty">Loading…</div>`;
  const role = state.user.role;
  const first = esc((state.user.name || '').split(/[\s(]/)[0] || state.user.name);
  const tiles = (NAV[role] || [])
    .map(
      ([key, label]) => `<button class="tile" data-nav="${key}">
        <span class="tile-label">${label}</span>
        <span class="tile-desc">${TILE_DESC[key] || ''}</span>
        <span class="tile-go" aria-hidden="true">&rarr;</span>
      </button>`
    )
    .join('');

  let html = `
    <div class="home-hero">
      <h2>Welcome back, ${first}.</h2>
      <p>${HOME_SUB[role] || ''}</p>
    </div>
    <div class="tiles">${tiles}</div>`;

  if (role === 'ADMIN') {
    html += `<div class="section-title" style="margin-top:32px;">System overview</div>` + (await metricsInnerHTML());
  } else {
    try {
      const { tickets } = await API.get('/tickets');
      const open = tickets.filter((t) => !['RESOLVED', 'CLOSED'].includes(t.status)).length;
      html += `<div class="home-strip">
        <div><b>${tickets.length}</b><span>visible to you</span></div>
        <div><b>${open}</b><span>still open</span></div>
        <div><b>${tickets.filter((t) => t.priority === 'CRITICAL' || t.priority === 'HIGH').length}</b><span>high / critical</span></div>
      </div>`;
    } catch (e) {
      /* non-fatal */
    }
  }

  content.innerHTML = html;
  content.querySelectorAll('[data-nav]').forEach((b) => (b.onclick = () => goto(b.dataset.nav)));
}

async function renderView() {
  const content = document.getElementById('content');
  const title = document.getElementById('page-title') || {};
  const sub = document.getElementById('page-sub') || {};

  if (state.view === 'home') {
    title.textContent = 'Dashboard';
    sub.textContent = '';
    return renderHome(content);
  }
  if (state.view === 'ticket' && state.currentTicketId) {
    title.textContent = 'Ticket detail';
    sub.textContent = '';
    return renderTicketDetail(content);
  }
  if (state.view === 'newticket') {
    title.textContent = 'Report a problem';
    sub.textContent = 'AI auto-triage will classify and route this automatically.';
    return renderNewTicket(content);
  }
  if (state.view === 'queue') {
    title.textContent = state.user.role === 'STUDENT' ? 'My Tickets' : state.user.role === 'ADMIN' ? 'All Tickets' : 'Department Queue';
    sub.textContent = '';
    return renderQueue(content);
  }
  if (state.view === 'users') {
    title.textContent = 'Users';
    sub.textContent = '';
    return renderUsers(content);
  }
}

// -------------------------------------------------------------------- queue
async function renderQueue(content) {
  content.innerHTML = `<div class="empty">Loading tickets…</div>`;
  const params = new URLSearchParams(state.ticketFilters).toString();
  const { tickets } = await API.get(`/tickets${params ? '?' + params : ''}`);
  state.tickets = tickets;

  const filterBar = `
    <div class="filter-bar">
      <select id="f-status" class="filter-select">
        <option value="">All statuses</option>
        ${['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'AWAITING_USER', 'AWAITING_REVIEW', 'RESOLVED', 'CLOSED', 'REOPENED']
          .map((s) => `<option ${state.ticketFilters.status === s ? 'selected' : ''}>${s}</option>`)
          .join('')}
      </select>
      <select id="f-priority" class="filter-select">
        <option value="">All priorities</option>
        ${['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
          .map((p) => `<option ${state.ticketFilters.priority === p ? 'selected' : ''}>${p}</option>`)
          .join('')}
      </select>
      <input id="f-q" class="filter-search" placeholder="Search title or ticket no" value="${esc(state.ticketFilters.q || '')}" />
      ${state.user.role === 'STUDENT' ? `<button class="btn" id="new-ticket-cta">+ New ticket</button>` : ''}
    </div>`;

  if (!tickets.length) {
    content.innerHTML = filterBar + `<div class="empty">No tickets match. ${state.user.role === 'STUDENT' ? 'Create your first ticket above.' : ''}</div>`;
  } else {
    content.innerHTML =
      filterBar +
      `<table class="table"><thead><tr>
        <th>Ticket</th><th>Title</th><th>Status</th><th>Priority</th><th>Department</th><th>Area</th>
        ${state.user.role !== 'STUDENT' ? '<th>Reporter</th><th>Assigned</th>' : ''}
        <th>Visit?</th><th>Updated</th>
      </tr></thead><tbody>
      ${tickets
        .map(
          (t) => `<tr class="row-link" data-id="${t.id}">
            <td class="ticket-no">${esc(t.ticket_no)}</td>
            <td>${esc(t.title)}</td>
            <td><span class="pill status-${t.status}">${t.status.replace('_', ' ')}</span></td>
            <td><span class="pill prio-${t.priority}">${t.priority}</span></td>
            <td>${esc(t.department_name || '—')}</td>
            <td>${esc(t.location_type || '—')}</td>
            ${state.user.role !== 'STUDENT' ? `<td>${esc(t.reporter_name)}</td><td>${esc(t.assigned_name || '—')}</td>` : ''}
            <td>${t.physical_visit_required ? 'Yes' : 'No'}</td>
            <td class="meta-line">${fmtDate(t.updated_at)}</td>
          </tr>`
        )
        .join('')}
      </tbody></table>`;
  }

  content.querySelectorAll('.row-link').forEach((row) => {
    row.onclick = () => {
      state.currentTicketId = row.dataset.id;
      state.view = 'ticket';
      render();
    };
  });
  const cta = document.getElementById('new-ticket-cta');
  if (cta) cta.onclick = () => { state.view = 'newticket'; render(); };

  ['f-status', 'f-priority'].forEach((id) => {
    const el = document.getElementById(id);
    if (el)
      el.onchange = () => {
        const key = id === 'f-status' ? 'status' : 'priority';
        state.ticketFilters[key] = el.value || undefined;
        renderView();
      };
  });
  const q = document.getElementById('f-q');
  if (q)
    q.onkeydown = (e) => {
      if (e.key === 'Enter') {
        state.ticketFilters.q = q.value || undefined;
        renderView();
      }
    };
  enhanceSelects(content);
}

// ---------------------------------------------------------------- new ticket
function renderNewTicket(content) {
  content.innerHTML = `
    <div class="card form-narrow">
      <div id="nt-error"></div>
      <form id="nt-form">
        <div class="field"><label>Title</label><input name="title" required maxlength="200" placeholder="e.g. Wi-Fi keeps disconnecting" /></div>
        <div class="field"><label>Description</label><textarea name="description" required placeholder="Describe the problem, when it started, and where."></textarea></div>
        <div class="field"><label>Location</label><input name="location" placeholder="e.g. Tower 5, Room 117" /></div>
        <div class="field"><label>Location Type</label>
          <select name="location_type" required>
            <option value="">Select where this is…</option>
            ${['Hostel Room', 'Academic / Admin Block', 'Library', 'Transport / Campus Grounds', 'Other']
              .map((lt) => `<option value="${esc(lt)}">${esc(lt)}</option>`)
              .join('')}
          </select>
          <div class="hint">Electrical / plumbing / AC issues route to the Warden in a hostel room, and to Campus Facilities elsewhere.</div>
        </div>
        <div class="field"><label>Category (optional; auto-triage suggests one if left blank)</label>
          <select name="category_id"><option value="">Auto-detect</option>
            ${state.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        <div id="nt-selfhelp"></div>
        <button class="btn" type="submit" id="nt-submit">Submit ticket</button>
      </form>
    </div>`;

  enhanceSelects(content);
  // Self-help: before filing, ask the AI for quick fixes the student can try
  // (e.g. toggle Wi-Fi). Shown once per edit of the form; "Still not working"
  // files the ticket. No steps / AI down -> the ticket is filed straight away.
  const form = document.getElementById('nt-form');
  const submitBtn = document.getElementById('nt-submit');
  const helpBox = document.getElementById('nt-selfhelp');
  let selfHelpShown = false;
  form.oninput = () => {
    if (!selfHelpShown) return;
    selfHelpShown = false;
    helpBox.innerHTML = '';
    submitBtn.textContent = 'Submit ticket';
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    if (!payload.category_id) delete payload.category_id;
    const errBox = document.getElementById('nt-error');
    errBox.innerHTML = '';
    if (!selfHelpShown) {
      selfHelpShown = true;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Checking for quick fixes…';
      let steps = [];
      try {
        ({ steps = [] } = await API.post('/tickets/self-help', payload));
      } catch (err) {
        /* self-help is best-effort; fall through to filing */
      }
      submitBtn.disabled = false;
      if (steps.length) {
        helpBox.innerHTML = `
          <div class="card" style="margin:12px 0;">
            <h3 style="margin-top:0;">Try this first</h3>
            <ol>${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
            <button class="btn secondary" type="button" id="nt-fixed">That fixed it</button>
          </div>`;
        submitBtn.textContent = 'Still not working — create ticket';
        document.getElementById('nt-fixed').onclick = () => {
          toast('Glad that worked — no ticket filed.', 'ok');
          state.view = 'home';
          render();
        };
        return;
      }
    }
    submitBtn.disabled = true;
    try {
      const result = await API.post('/tickets', payload);
      toast(`Ticket ${result.ticketNo} created. Routed to ${result.triage.department} (${result.triage.priority}).`, 'ok');
      state.currentTicketId = result.ticket.id;
      state.view = 'ticket';
      render();
    } catch (err) {
      submitBtn.disabled = false;
      errBox.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }
  };
}

// ---------------------------------------------------------------- ticket detail
async function renderTicketDetail(content) {
  content.innerHTML = `<div class="empty">Loading…</div>`;
  let data;
  try {
    data = await API.get(`/tickets/${state.currentTicketId}`);
  } catch (err) {
    content.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    return;
  }
  const { ticket, comments, history, visits } = data;
  const role = state.user.role;
  const isAdmin = role === 'ADMIN';
  const isStaffish = ['STAFF', 'LEAD', 'CUSTODIAN', 'ADMIN'].includes(role);
  const isOwner = ticket.user_id === state.user.id;

  // After a department submits for review, the reporter has 24h to confirm;
  // only then can an admin close it on their behalf.
  const inReview = ticket.status === 'AWAITING_REVIEW';
  const submittedRow = history.filter((h) => h.action === 'SUBMITTED_FOR_REVIEW').pop();
  const submittedAt = submittedRow ? new Date((submittedRow.created_at || '').replace(' ', 'T') + 'Z').getTime() : null;
  const reviewHoursLeft = inReview && submittedAt ? Math.max(0, 24 - (Date.now() - submittedAt) / 3.6e6) : 0;

  content.innerHTML = `
    <button class="btn secondary" id="back-btn" style="margin-bottom:14px;">&larr; Back</button>
    <div class="detail-head">
      <div>
        <h2><span class="ticket-no">${esc(ticket.ticket_no)}</span>&nbsp;&nbsp;${esc(ticket.title)}</h2>
        <div class="meta-line">Reported by ${esc(ticket.reporter_name)} · ${fmtDate(ticket.created_at)} · Location: ${esc(ticket.location || '—')} · Type: ${esc(ticket.location_type || '—')}</div>
      </div>
      <div class="btn-row">
        <span class="pill status-${ticket.status}">${ticket.status.replace('_', ' ')}</span>
        <span class="pill prio-${ticket.priority}">${ticket.priority}</span>
      </div>
    </div>

    <div class="grid cols-2">
      <div>
        <div class="desc-box">${esc(ticket.description)}</div>
        ${
          ticket.ai_summary
            ? `<div class="ai-box"><b>Auto-triage</b>${esc(ticket.ai_summary)} (confidence ${Math.round((ticket.ai_confidence || 0) * 100)}%).<br/>${esc(ticket.ai_reason || '')}</div>`
            : ''
        }
        ${
          ticket.resolution_notes
            ? `<div class="notice" style="margin-top:14px;"><b>${
                inReview
                  ? (isOwner ? 'The team says this is fixed — please confirm' : 'Completed by the department — waiting for the reporter to confirm')
                  : ['RESOLVED', 'CLOSED'].includes(ticket.status) ? 'Resolution notes' : 'Completion notes'
              }</b><br/>${esc(ticket.resolution_notes)}</div>`
            : ''
        }
        ${
          inReview && isOwner
            ? `<div class="card" style="margin-top:14px;">
                 <h3 style="margin-bottom:8px;">Is your problem solved?</h3>
                 <div class="hint" style="margin-top:0;margin-bottom:12px;">If you don't respond within 24 hours an admin can close it for you.</div>
                 <div class="btn-row">
                   <button class="btn" id="confirm-yes">Yes, it's solved</button>
                   <button class="btn secondary" id="confirm-no">No, still not fixed</button>
                 </div>
               </div>`
            : ''
        }

        <div class="section-title">Comments</div>
        <div class="card">
          ${
            comments.length
              ? comments.map((c) => `<div class="comment ${c.visibility === 'INTERNAL' ? 'internal' : ''}"><span class="who">${esc(c.author_name)}<span class="when">${fmtDate(c.created_at)}</span></span><div class="msg">${esc(c.message)}</div></div>`).join('')
              : '<div class="empty">No comments yet.</div>'
          }
          <form id="comment-form" style="margin-top:12px;">
            <div class="field"><textarea name="message" placeholder="Write a reply…" required></textarea></div>
            <div class="btn-row">
              <button class="btn" type="submit">Post</button>
              ${isStaffish ? `<label class="inline-check"><input type="checkbox" name="internal" /> internal note (staff only)</label>` : ''}
            </div>
          </form>
        </div>

        ${
          ticket.physical_visit_required
            ? `<div class="section-title">Smart Visit</div><div class="card">${renderVisits(visits, ticket, isStaffish)}</div>`
            : ''
        }

        <div class="section-title">History</div>
        <div class="card">
          ${history.map((h) => `<div class="history-item">${fmtDate(h.created_at)} · ${esc(h.action)} ${h.actor_name ? 'by ' + esc(h.actor_name) : ''} ${h.new_value ? '&rarr; ' + esc(h.new_value).slice(0, 80) : ''}</div>`).join('') || '<div class="empty">No history yet.</div>'}
        </div>
      </div>

      <div>
        <div class="card">
          <h3>Category</h3><div>${esc(ticket.category_name || '—')}</div>
          <h3 style="margin-top:12px;">Department</h3><div>${esc(ticket.department_name || '—')}</div>
          <h3 style="margin-top:12px;">Assigned to</h3><div>${esc(ticket.assigned_name || 'Unassigned')}</div>
        </div>

        ${isStaffish ? renderStaffActionsCard(ticket, isAdmin, reviewHoursLeft) : ''}

        ${
          (isOwner || role === 'ADMIN') && ['RESOLVED', 'CLOSED'].includes(ticket.status)
            ? `<div class="card" style="margin-top:12px;"><button class="btn secondary block" id="reopen-btn">Reopen ticket</button></div>`
            : ''
        }
      </div>
    </div>`;

  document.getElementById('back-btn').onclick = () => { state.view = 'queue'; render(); };

  document.getElementById('comment-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await API.post(`/tickets/${ticket.id}/comments`, {
        message: fd.get('message'),
        visibility: fd.get('internal') ? 'INTERNAL' : 'PUBLIC',
      });
      renderTicketDetail(content);
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  const reopenBtn = document.getElementById('reopen-btn');
  if (reopenBtn) reopenBtn.onclick = async () => {
    try {
      await API.post(`/tickets/${ticket.id}/reopen`);
      toast('Ticket reopened.', 'ok');
      renderTicketDetail(content);
    } catch (err) { toast(err.message, 'err'); }
  };

  const confirm = (solved) => async () => {
    try {
      await API.post(`/tickets/${ticket.id}/confirm`, { solved });
      toast(solved ? 'Thanks — the ticket is closed.' : 'Sent back to the team.', 'ok');
      renderTicketDetail(content);
    } catch (err) { toast(err.message, 'err'); }
  };
  const cy = document.getElementById('confirm-yes');
  if (cy) cy.onclick = confirm(true);
  const cn = document.getElementById('confirm-no');
  if (cn) cn.onclick = confirm(false);

  wireStaffActions(ticket, content, isAdmin);
  wireVisitActions(ticket, content);
  enhanceSelects(content);
}

function renderStaffActionsCard(ticket, isAdmin, reviewHoursLeft = 0) {
  // A department moves a ticket around its working states but cannot resolve or
  // close it. After it submits for review the REPORTER confirms; only once the
  // 24h reporter window has elapsed with no answer may an admin close it.
  const deptStatuses = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'AWAITING_USER'];
  const allStatuses = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'AWAITING_USER', 'AWAITING_REVIEW', 'RESOLVED', 'CLOSED', 'REOPENED'];
  let statuses = isAdmin ? allStatuses : deptStatuses.slice();
  if (!statuses.includes(ticket.status)) statuses = [ticket.status, ...statuses];
  const inReview = ticket.status === 'AWAITING_REVIEW';
  const waitingOnReporter = inReview && reviewHoursLeft > 0;
  const reporterTimedOut = inReview && reviewHoursLeft <= 0;

  const head = `
    <div class="field"><label>Status</label>
      <select id="status-select">
        ${statuses.map((s) => `<option ${s === ticket.status ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>Priority</label>
      <select id="priority-select">
        ${['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((p) => `<option ${p === ticket.priority ? 'selected' : ''}>${p}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>Department</label>
      <select id="dept-select">
        ${state.departments.map((d) => `<option value="${d.id}" ${d.id === ticket.department_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
      </select>
    </div>
    <button class="btn block" id="save-update-btn">Save changes</button>
    <div class="hint">Every change here is validated server-side and timestamped in the history log.</div>
    <hr class="rule" />
    <button class="btn secondary block" id="retriage-btn">Re-run AI auto-triage</button>`;

  let tail = '';
  if (!isAdmin) {
    // department
    tail = inReview
      ? `<hr class="rule" /><div class="hint">Submitted for review — waiting for the reporter to confirm.</div>`
      : `<div style="margin-top:12px;">
           <div class="field"><label>Mark completed — send for review</label>
             <textarea id="resolve-notes" placeholder="What was done — this goes to the reporter to confirm (required)"></textarea>
           </div>
           <button class="btn block" id="resolve-btn">Submit for review</button>
         </div>`;
  } else if (waitingOnReporter) {
    tail = `<hr class="rule" />
       <div class="hint" style="margin-bottom:10px;">Completed by the department. The reporter has about ${Math.ceil(reviewHoursLeft)}h left to confirm — you can close it yourself after that.</div>
       <button class="btn secondary block" id="return-btn">Return to department</button>`;
  } else if (reporterTimedOut) {
    tail = `<hr class="rule" />
       <div class="notice" style="margin-bottom:10px;">The reporter did not respond within 24 hours — you can close this yourself.</div>
       <div class="field"><label>Resolution notes</label>
         <textarea id="resolve-notes" placeholder="Resolution notes (required)">${esc(ticket.resolution_notes || '')}</textarea>
       </div>
       <div class="btn-row">
         <button class="btn" id="close-btn">Close ticket</button>
         <button class="btn secondary" id="return-btn">Return to department</button>
       </div>`;
  } else {
    // admin, ticket not in review
    tail = `<div style="margin-top:12px;">
         <div class="field"><label>Resolve with notes</label>
           <textarea id="resolve-notes" placeholder="Resolution notes (required)"></textarea>
         </div>
         <button class="btn block" id="resolve-btn">Mark resolved</button>
       </div>
       ${ticket.status !== 'CLOSED' ? `<button class="btn secondary block" id="close-btn" style="margin-top:10px;">Close ticket</button>` : ''}`;
  }

  return `<div class="card" style="margin-top:12px;">
      <h3>${isAdmin ? 'Admin actions' : 'Department actions'}</h3>
      ${head}
      ${tail}
    </div>`;
}

function wireStaffActions(ticket, content, isAdmin) {
  const reload = () => renderTicketDetail(content);

  const saveBtn = document.getElementById('save-update-btn');
  if (saveBtn)
    saveBtn.onclick = async () => {
      const body = {
        priority: document.getElementById('priority-select').value,
        department_id: Number(document.getElementById('dept-select').value),
      };
      const nextStatus = document.getElementById('status-select').value;
      if (nextStatus !== ticket.status) body.status = nextStatus; // only send status if it actually changed
      try {
        await API.patch(`/tickets/${ticket.id}`, body);
        toast('Ticket updated.', 'ok');
        reload();
      } catch (err) { toast(err.message, 'err'); }
    };

  const retriageBtn = document.getElementById('retriage-btn');
  if (retriageBtn)
    retriageBtn.onclick = async () => {
      try {
        const r = await API.post(`/tickets/${ticket.id}/triage`);
        toast(`Re-triaged: ${r.triage.category} / ${r.triage.priority}`, 'ok');
        reload();
      } catch (err) { toast(err.message, 'err'); }
    };

  const resolveBtn = document.getElementById('resolve-btn');
  if (resolveBtn)
    resolveBtn.onclick = async () => {
      const notes = (document.getElementById('resolve-notes') || {}).value || '';
      try {
        const r = await API.post(`/tickets/${ticket.id}/resolve`, { resolution_notes: notes });
        toast(r.ticket && r.ticket.status === 'AWAITING_REVIEW' ? 'Submitted — the reporter will confirm.' : 'Ticket resolved.', 'ok');
        reload();
      } catch (err) { toast(err.message, 'err'); }
    };

  const returnBtn = document.getElementById('return-btn');
  if (returnBtn)
    returnBtn.onclick = async () => {
      try {
        await API.patch(`/tickets/${ticket.id}`, { status: 'IN_PROGRESS' });
        toast('Returned to the department.', 'ok');
        reload();
      } catch (err) { toast(err.message, 'err'); }
    };

  const closeBtn = document.getElementById('close-btn');
  if (closeBtn)
    closeBtn.onclick = async () => {
      try {
        await API.patch(`/tickets/${ticket.id}`, { status: 'CLOSED' });
        toast('Ticket closed.', 'ok');
        reload();
      } catch (err) { toast(err.message, 'err'); }
    };
}

function renderVisits(visits, ticket, isStaffish) {
  const list = visits.length
    ? visits
        .map(
          (v) => `<div class="key-card">
        <div class="top"><span class="room">${v.technician_slot ? fmtDate(v.technician_slot) : 'No slot yet'}</span><span class="pill status-${v.status === 'MISSED' ? 'AWAITING_USER' : v.status === 'COMPLETED' ? 'RESOLVED' : 'ASSIGNED'}">${v.status.replace('_', ' ')}</span></div>
        <div class="meta">${v.outcome_notes ? esc(v.outcome_notes) : ''}</div>
        ${
          isStaffish
            ? `<div class="btn-row" style="margin-top:8px;">
              <button class="btn secondary" data-visit="${v.id}" data-status="SCHEDULED">Schedule</button>
              <button class="btn secondary" data-visit="${v.id}" data-status="CHECKED_IN">Check-in</button>
              <button class="btn secondary" data-visit="${v.id}" data-status="MISSED">Mark missed</button>
              <button class="btn secondary" data-visit="${v.id}" data-status="COMPLETED">Complete</button>
            </div>`
            : ''
        }
      </div>`
        )
        .join('')
    : '<div class="empty">No visit proposed yet.</div>';

  return (
    list +
    `<form id="visit-form" style="margin-top:10px;">
      <div class="field"><label>Propose a visit slot (date/time)</label><input type="datetime-local" name="technician_slot" /></div>
      <button class="btn secondary" type="submit">Propose visit</button>
    </form>`
  );
}

function wireVisitActions(ticket, content) {
  const form = document.getElementById('visit-form');
  if (form)
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await API.post(`/tickets/${ticket.id}/visits`, { technician_slot: fd.get('technician_slot') });
        toast('Visit proposed.', 'ok');
        renderTicketDetail(content);
      } catch (err) { toast(err.message, 'err'); }
    };
  content.querySelectorAll('[data-visit]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await API.patch(`/visits/${btn.dataset.visit}`, { status: btn.dataset.status });
        toast('Visit updated.', 'ok');
        renderTicketDetail(content);
      } catch (err) { toast(err.message, 'err'); }
    };
  });
}

// -------------------------------------------------------------------- metrics
const CHART_COLORS = ['#0E7C86', '#2E579F', '#A0570F', '#6B5B95', '#B14A4A', '#5B6470', '#357A5B'];

function donutChart(segments) {
  const total = segments.reduce((s, x) => s + x.count, 0);
  const R = 52, C = 2 * Math.PI * R;
  let off = 0;
  const arcs = total
    ? segments
        .map((s, i) => {
          const len = (s.count / total) * C;
          const arc = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${CHART_COLORS[i % CHART_COLORS.length]}"
        stroke-width="19" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}"
        stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 70 70)" class="donut-arc"/>`;
          off += len;
          return arc;
        })
        .join('')
    : `<circle r="${R}" cx="70" cy="70" fill="none" stroke="var(--line)" stroke-width="19"/>`;
  const legend = total
    ? segments
        .map(
          (s, i) => `<li><span class="dot" style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></span>
        <span class="lg-label">${esc(s.label)}</span>
        <b>${s.count}</b><span class="lg-pct">${Math.round((s.count / total) * 100)}%</span></li>`
        )
        .join('')
    : `<li class="lg-empty">No tickets yet</li>`;
  return `<div class="donut-wrap">
    <svg viewBox="0 0 140 140" class="donut" role="img" aria-label="Tickets by department">
      ${arcs}
      <text x="70" y="66" text-anchor="middle" class="donut-num">${total}</text>
      <text x="70" y="83" text-anchor="middle" class="donut-lbl">tickets</text>
    </svg>
    <ul class="legend">${legend}</ul>
  </div>`;
}

// Renders the /api/admin/metrics `last7Days` array verbatim: one point per day,
// oldest first, zero-count days included. No client-side bucketing.
function trendChart(last7Days) {
  const counts = last7Days.map((d) => d.count);
  const W = 480, H = 168, padX = 30, padTop = 16, padBot = 26;
  const max = Math.max(1, ...counts);
  const px = (i) => padX + (i / Math.max(1, last7Days.length - 1)) * (W - padX * 2);
  const py = (v) => padTop + (1 - v / max) * (H - padTop - padBot);
  const line = counts.map((c, i) => `${px(i).toFixed(1)},${py(c).toFixed(1)}`).join(' ');
  const area = `${px(0).toFixed(1)},${(H - padBot).toFixed(1)} ${line} ${px(last7Days.length - 1).toFixed(1)},${(H - padBot).toFixed(1)}`;
  const grid = [0, 0.5, 1]
    .map((f) => {
      const y = padTop + f * (H - padTop - padBot);
      return `<line x1="${padX}" y1="${y.toFixed(1)}" x2="${W - padX}" y2="${y.toFixed(1)}" class="tr-grid"/>
        <text x="${padX - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end" class="tr-tick">${Math.round(max * (1 - f))}</text>`;
    })
    .join('');
  const dots = counts.map((c, i) => `<circle cx="${px(i).toFixed(1)}" cy="${py(c).toFixed(1)}" r="3.5" class="tr-dot"/>`).join('');
  const labels = last7Days
    .map((d, i) => {
      const lbl = new Date(d.date + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
      return `<text x="${px(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="tr-tick">${lbl}</text>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="trend" role="img" aria-label="New tickets over the last 7 days">
    <defs><linearGradient id="trFill" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="var(--accent)" stop-opacity="0.28"/>
      <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    <polygon points="${area}" fill="url(#trFill)"/>
    <polyline points="${line}" fill="none" class="tr-line"/>
    ${dots}${labels}
  </svg>`;
}

// The system overview lives inside the admin Dashboard (renderHome); this
// builds its inner HTML from the live /api/admin/metrics response.
async function metricsInnerHTML() {
  let m;
  try {
    m = await API.get('/admin/metrics');
  } catch (err) {
    return `<div class="empty">Couldn't load system metrics (${esc(err.message)}).</div>`;
  }
  const statusMap = Object.fromEntries(m.byStatus.map((s) => [s.status, s.count]));
  const prioMap = Object.fromEntries(m.byPriority.map((p) => [p.priority, p.count]));
  const resolved = (statusMap.RESOLVED || 0) + (statusMap.CLOSED || 0);
  const last7Days = Array.isArray(m.last7Days) ? m.last7Days : [];

  const deptSegments = (m.byDepartment || [])
    .filter((d) => d.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((d) => ({ label: d.department, count: d.count }));

  const bars = (rows, key) => {
    if (!rows.length) return '<div class="empty">No data.</div>';
    const max = Math.max(1, ...rows.map((r) => r.count));
    return rows
      .map(
        (r) => `<div class="bar-row">
          <span class="bar-label">${esc(r[key])}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${Math.round((r.count / max) * 100)}%"></span></span>
          <b>${r.count}</b>
        </div>`
      )
      .join('');
  };

  return `
    <div class="grid cols-4 stat-grid">
      <div class="card stat-card"><h3>Total tickets</h3><div class="stat">${m.totalTickets}</div></div>
      <div class="card stat-card"><h3>Open</h3><div class="stat">${statusMap.OPEN || 0}</div></div>
      <div class="card stat-card"><h3>Critical</h3><div class="stat">${prioMap.CRITICAL || 0}</div></div>
      <div class="card stat-card"><h3>Resolved</h3><div class="stat">${resolved}</div></div>
    </div>

    <div class="charts-row">
      <div class="card">
        <div class="card-head"><h3>Tickets by department</h3></div>
        ${donutChart(deptSegments)}
      </div>
      <div class="card">
        <div class="card-head"><h3>New tickets</h3><span class="card-meta">last 7 days</span></div>
        ${trendChart(last7Days)}
      </div>
    </div>

    <div class="grid cols-2b">
      <div>
        <div class="section-title">By status</div>
        <div class="card">${bars(m.byStatus, 'status')}</div>
      </div>
      <div>
        <div class="section-title">By priority</div>
        <div class="card">${bars(m.byPriority, 'priority')}</div>
      </div>
    </div>
    ${m.avgAiConfidence !== null ? `<div class="hint">Average auto-triage confidence: ${Math.round(m.avgAiConfidence * 100)}%</div>` : ''}
  `;
}

// -------------------------------------------------------------------- users (admin)
async function renderUsers(content) {
  content.innerHTML = `<div class="empty">Loading…</div>`;
  const { users } = await API.get('/admin/users');
  content.innerHTML = `<table class="table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Department</th><th>Status</th><th></th></tr></thead><tbody>
    ${users
      .map(
        (u) => `<tr>
        <td>${esc(u.name)}</td><td>${esc(u.email)}</td>
        <td><select data-user="${u.id}" data-field="role">
          ${['STUDENT', 'STAFF', 'LEAD', 'ADMIN', 'CUSTODIAN'].map((r) => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}
        </select></td>
        <td><select data-user="${u.id}" data-field="department_id">
          <option value="">—</option>
          ${state.departments.map((d) => `<option value="${d.id}" ${d.name === u.department_name ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select></td>
        <td><select data-user="${u.id}" data-field="status">
          ${['ACTIVE', 'INACTIVE'].map((s) => `<option ${s === u.status ? 'selected' : ''}>${s}</option>`).join('')}
        </select></td>
        <td><button class="btn secondary" data-save="${u.id}">Save</button></td>
      </tr>`
      )
      .join('')}
  </tbody></table>`;

  content.querySelectorAll('[data-save]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.save;
      const row = btn.closest('tr');
      const payload = {};
      row.querySelectorAll('[data-field]').forEach((sel) => {
        payload[sel.dataset.field] = sel.value || null;
      });
      try {
        await API.patch(`/admin/users/${id}`, payload);
        toast('User updated.', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    };
  });
  enhanceSelects(content);
}

boot();
