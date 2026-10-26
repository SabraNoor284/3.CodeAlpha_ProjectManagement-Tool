/* TaskBoard – project management frontend (vanilla JS, hash routing, WebSocket live updates) */
const app = document.getElementById('app');
const modal = document.getElementById('modal');
const STATUS = { todo: 'To Do', in_progress: 'In Progress', done: 'Done' };

const state = {
  token: localStorage.getItem('token'),
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  project: null, // currently open project (with members + tasks)
  openTaskId: null, // task shown in modal
  ws: null,
  wsOn: false,
  notifs: { unread: 0, items: [] },
  notifOpen: false,
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function timeAgo(ts) {
  const d = new Date(String(ts).replace(' ', 'T') + 'Z');
  const s = Math.max(1, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return d.toLocaleDateString();
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

async function api(url, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  const res = await fetch(url, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.token) logout(false);
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

/* ===================== auth ===================== */
function setAuth(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
  connectWS();
  loadNotifications();
}
function logout(redirect = true) {
  state.token = null;
  state.user = null;
  state.project = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
  state.wsOn = false;
  renderNav();
  if (redirect) location.hash = '#/login';
}

/* ===================== WebSocket ===================== */
function connectWS() {
  if (!state.token || (state.ws && state.ws.readyState <= 1)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  state.ws = ws;
  ws.onopen = () => {
    state.wsOn = true;
    updateLive();
    if (state.project) ws.send(JSON.stringify({ type: 'join', projectId: state.project.id }));
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    onSocketMessage(m);
  };
  ws.onclose = () => {
    state.wsOn = false;
    updateLive();
    if (state.token) setTimeout(connectWS, 2000);
  };
}

function joinProject(id) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ type: 'join', projectId: id }));
}
function leaveProject(id) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ type: 'leave', projectId: id }));
}
function updateLive() {
  const el = document.getElementById('live');
  if (el) el.innerHTML = `<span class="dot ${state.wsOn ? 'on' : ''}"></span>${state.wsOn ? 'Live' : 'Reconnecting…'}`;
}

function onSocketMessage(m) {
  const p = state.project;
  switch (m.type) {
    case 'notification':
      state.notifs.unread += 1;
      state.notifs.items.unshift(m.notification);
      toast('🔔 ' + m.notification.message);
      renderNav();
      // keep the project list fresh if the user is looking at it (e.g. just added to a project)
      if (!state.project && !location.hash.startsWith('#/p/') && document.getElementById('new')) viewDashboard();
      break;
    case 'task_created':
      if (p && !p.tasks.some((t) => t.id === m.task.id)) { p.tasks.push(m.task); renderBoard(); toast(`${m.by} added "${m.task.title}"`); }
      break;
    case 'task_updated':
      if (p) {
        const i = p.tasks.findIndex((t) => t.id === m.task.id);
        if (i >= 0) p.tasks[i] = m.task; else p.tasks.push(m.task);
        renderBoard();
        if (state.openTaskId === m.task.id) refreshModalFields(m.task);
      }
      break;
    case 'task_deleted':
      if (p) {
        p.tasks = p.tasks.filter((t) => t.id !== m.taskId);
        renderBoard();
        if (state.openTaskId === m.taskId) { closeModal(); toast('This task was deleted by ' + m.by); }
      }
      break;
    case 'comment_added':
      if (p) {
        const t = p.tasks.find((x) => x.id === m.taskId);
        if (t) { t.comment_count += 1; renderBoard(); }
        if (state.openTaskId === m.taskId) appendComment(m.comment);
      }
      break;
    case 'member_added':
    case 'member_removed':
      if (p && p.id === m.projectId) openProjectRefresh();
      break;
    case 'project_deleted':
      if (p && p.id === m.projectId) { toast('This project was deleted'); state.project = null; location.hash = '#/'; }
      break;
  }
}

/* ===================== notifications ===================== */
async function loadNotifications() {
  if (!state.token) return;
  try { state.notifs = await api('/api/notifications'); renderNav(); } catch { /* ignore */ }
}

function renderNav() {
  const nav = document.getElementById('nav');
  if (!state.user) {
    nav.innerHTML = '<a href="#/login">Login</a><a href="#/register">Register</a>';
    return;
  }
  nav.innerHTML = `
    <a href="#/">Projects</a>
    <button class="bell" id="bell" title="Notifications">🔔${state.notifs.unread ? `<span class="count">${state.notifs.unread}</span>` : ''}</button>
    <div class="notifs" id="notifs" ${state.notifOpen ? '' : 'hidden'}>
      ${state.notifs.items.length
        ? state.notifs.items.map((n) => `<div class="notif ${n.is_read ? '' : 'unread'}" data-p="${n.project_id || ''}">${esc(n.message)}<div class="muted">${esc(timeAgo(n.created_at))}</div></div>`).join('')
        : '<div class="notif muted">No notifications yet.</div>'}
    </div>
    <span class="muted">${esc(state.user.name)}</span>
    <a href="#" id="logout">Logout</a>`;
  document.getElementById('logout').onclick = (e) => { e.preventDefault(); logout(); };
  document.getElementById('bell').onclick = async (e) => {
    e.stopPropagation();
    state.notifOpen = !state.notifOpen;
    renderNav();
    if (state.notifOpen && state.notifs.unread) {
      await api('/api/notifications/read', { method: 'POST' }).catch(() => {});
      state.notifs.unread = 0;
      state.notifs.items.forEach((n) => (n.is_read = 1));
      setTimeout(() => { if (state.notifOpen) renderNav(); }, 1500);
    }
  };
  document.querySelectorAll('.notif[data-p]').forEach((el) => {
    el.onclick = () => { if (el.dataset.p) location.hash = '#/p/' + el.dataset.p; state.notifOpen = false; renderNav(); };
  });
}
document.addEventListener('click', (e) => {
  if (state.notifOpen && !e.target.closest('#notifs')) { state.notifOpen = false; renderNav(); }
});

/* ===================== views ===================== */
function viewAuth(mode) {
  const reg = mode === 'register';
  app.innerHTML = `
    <div class="card auth">
      <h2>${reg ? 'Create account' : 'Login'}</h2>
      <form class="stack" id="form">
        ${reg ? '<label>Name <input name="name" required maxlength="60" /></label>' : ''}
        <label>Email <input name="email" type="email" required /></label>
        <label>Password <input name="password" type="password" minlength="6" required /></label>
        <div class="error" id="err"></div>
        <button class="btn" type="submit">${reg ? 'Register' : 'Login'}</button>
        <span class="muted">${reg ? 'Already registered? <a href="#/login">Login</a>' : 'No account? <a href="#/register">Register</a>'}</span>
      </form>
    </div>`;
  document.getElementById('form').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try {
      const r = await api(reg ? '/api/register' : '/api/login', { method: 'POST', body });
      setAuth(r.token, r.user);
      location.hash = '#/';
    } catch (err) { document.getElementById('err').textContent = err.message; }
  };
}

async function viewDashboard() {
  const projects = await api('/api/projects');
  app.innerHTML = `
    <h1>Your projects</h1>
    <form class="card new-project" id="new">
      <input name="name" placeholder="New project name" required maxlength="80" />
      <input name="description" placeholder="Short description (optional)" maxlength="500" />
      <button class="btn" type="submit">Create project</button>
    </form>
    <div class="projects">
      ${projects.length ? projects.map((p) => {
        const pct = p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0;
        return `<a class="card project" href="#/p/${p.id}">
          <strong>${esc(p.name)}</strong>
          <span class="muted">${esc(p.description || 'No description')}</span>
          <div class="bar"><span style="width:${pct}%"></span></div>
          <span class="muted">${p.done_count}/${p.task_count} tasks done · ${p.member_count} member${p.member_count === 1 ? '' : 's'} · ${esc(p.role)}</span>
        </a>`;
      }).join('') : '<div class="empty" style="grid-column:1/-1">No projects yet. Create your first one above!</div>'}
    </div>`;
  document.getElementById('new').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try {
      const p = await api('/api/projects', { method: 'POST', body });
      location.hash = '#/p/' + p.id;
    } catch (err) { toast(err.message); }
  };
}

async function viewProject(id) {
  state.project = await api('/api/projects/' + id);
  joinProject(state.project.id);
  app.innerHTML = `
    <div class="board-head">
      <div>
        <a href="#/">← Projects</a>
        <h1 style="margin:6px 0 4px">${esc(state.project.name)}</h1>
        <div class="muted">${esc(state.project.description)}</div>
      </div>
      <div style="text-align:right">
        <div class="live" id="live"></div><br />
        ${state.project.my_role === 'owner' ? '<button class="btn danger small" id="del-project">Delete project</button>' : '<button class="btn danger small" id="leave">Leave project</button>'}
      </div>
    </div>
    <div class="side card" id="members-box"></div>
    <form class="add-task card" id="add-task" style="margin-bottom:14px">
      <input name="title" placeholder="Add a task to “To Do” and press Enter…" required maxlength="120" />
      <button class="btn" type="submit">Add task</button>
    </form>
    <div class="columns" id="board"></div>`;
  updateLive();
  renderMembers();
  renderBoard();

  document.getElementById('add-task').onsubmit = async (e) => {
    e.preventDefault();
    const input = e.target.elements.title; // not e.target.title (that is the form's own title attribute)
    try {
      const t = await api(`/api/projects/${state.project.id}/tasks`, { method: 'POST', body: { title: input.value } });
      state.project.tasks.push(t);
      input.value = '';
      renderBoard();
    } catch (err) { toast(err.message); }
  };
  const dp = document.getElementById('del-project');
  if (dp) dp.onclick = async () => {
    if (!confirm('Delete this project and all its tasks?')) return;
    await api('/api/projects/' + state.project.id, { method: 'DELETE' }).catch((e) => toast(e.message));
    location.hash = '#/';
  };
  const lv = document.getElementById('leave');
  if (lv) lv.onclick = async () => {
    if (!confirm('Leave this project?')) return;
    await api(`/api/projects/${state.project.id}/members/${state.user.id}`, { method: 'DELETE' }).catch((e) => toast(e.message));
    location.hash = '#/';
  };

  // drag & drop between columns (event delegation)
  const board = document.getElementById('board');
  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.task');
    if (!card) return;
    e.dataTransfer.setData('text/plain', card.dataset.id);
    card.classList.add('dragging');
  });
  board.addEventListener('dragend', (e) => {
    const card = e.target.closest('.task');
    if (card) card.classList.remove('dragging');
    board.querySelectorAll('.column').forEach((c) => c.classList.remove('over'));
  });
  board.addEventListener('dragover', (e) => {
    const col = e.target.closest('.column');
    if (!col) return;
    e.preventDefault();
    board.querySelectorAll('.column').forEach((c) => c.classList.toggle('over', c === col));
  });
  board.addEventListener('drop', async (e) => {
    const col = e.target.closest('.column');
    if (!col) return;
    e.preventDefault();
    const taskId = Number(e.dataTransfer.getData('text/plain'));
    const task = state.project.tasks.find((t) => t.id === taskId);
    if (!task || task.status === col.dataset.status) return renderBoard();
    const old = task.status;
    task.status = col.dataset.status; // optimistic
    renderBoard();
    try {
      const updated = await api('/api/tasks/' + taskId, { method: 'PUT', body: { status: task.status } });
      Object.assign(task, updated);
    } catch (err) {
      task.status = old;
      toast(err.message);
    }
    renderBoard();
  });
}

async function openProjectRefresh() {
  if (!state.project) return;
  const fresh = await api('/api/projects/' + state.project.id).catch(() => null);
  if (!fresh) { location.hash = '#/'; return; }
  state.project = fresh;
  renderMembers();
  renderBoard();
}

function renderMembers() {
  const p = state.project;
  const box = document.getElementById('members-box');
  if (!box) return;
  const owner = p.my_role === 'owner';
  box.innerHTML = `
    <div class="members"><strong>Team:</strong>
      ${p.members.map((m) => `<span class="member">${esc(m.name)}${m.role === 'owner' ? ' 👑' : ''}${owner && m.role !== 'owner' ? `<button data-rm="${m.id}" title="Remove">✕</button>` : ''}</span>`).join('')}
    </div>
    ${owner ? `<form class="members" id="add-member"><input name="email" type="email" placeholder="Invite by email (they must be registered)" required style="max-width:340px" /><button class="btn ghost small" type="submit">Add member</button></form>` : ''}`;
  box.querySelectorAll('[data-rm]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/api/projects/${p.id}/members/${b.dataset.rm}`, { method: 'DELETE' });
        await openProjectRefresh();
      } catch (err) { toast(err.message); }
    };
  });
  const form = document.getElementById('add-member');
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/api/projects/${p.id}/members`, { method: 'POST', body: { email: form.email.value } });
      toast('Member added');
      await openProjectRefresh();
    } catch (err) { toast(err.message); }
  };
}

function renderBoard() {
  const board = document.getElementById('board');
  if (!board || !state.project) return;
  const today = new Date().toISOString().slice(0, 10);
  board.innerHTML = Object.keys(STATUS).map((st) => {
    const tasks = state.project.tasks.filter((t) => t.status === st);
    return `<div class="column col-${st}" data-status="${st}">
      <h3>${STATUS[st]} <span class="pill">${tasks.length}</span></h3>
      ${tasks.map((t) => `
        <div class="task" draggable="true" data-id="${t.id}">
          <div class="title">${esc(t.title)}</div>
          <div class="meta">
            ${t.assignee_name ? `<span class="chip">👤 ${esc(t.assignee_name)}</span>` : '<span>Unassigned</span>'}
            ${t.due_date ? `<span class="${t.status !== 'done' && t.due_date < today ? 'overdue' : ''}">📅 ${esc(t.due_date)}</span>` : ''}
            ${t.comment_count ? `<span>💬 ${t.comment_count}</span>` : ''}
          </div>
        </div>`).join('') || '<div class="muted">Drop tasks here</div>'}
    </div>`;
  }).join('');
  board.querySelectorAll('.task').forEach((el) => (el.onclick = () => openTask(Number(el.dataset.id))));
}

/* ===================== task modal ===================== */
function closeModal() {
  modal.hidden = true;
  modal.innerHTML = '';
  state.openTaskId = null;
}
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

async function openTask(id) {
  const task = state.project.tasks.find((t) => t.id === id);
  if (!task) return;
  state.openTaskId = id;
  const members = state.project.members;
  modal.hidden = false;
  modal.innerHTML = `
    <div class="dialog">
      <form class="stack" id="task-form">
        <label>Title <input name="title" required maxlength="120" value="${esc(task.title)}" /></label>
        <label>Description <textarea name="description" rows="3" maxlength="2000">${esc(task.description)}</textarea></label>
        <div class="row2">
          <label>Status <select name="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${task.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label>Assignee <select name="assignee_id"><option value="">Unassigned</option>${members.map((m) => `<option value="${m.id}" ${task.assignee_id === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
          <label>Due date <input type="date" name="due_date" value="${esc(task.due_date || '')}" /></label>
        </div>
        <div class="error" id="err"></div>
        <div style="display:flex;gap:8px;justify-content:space-between">
          <button type="button" class="btn danger" id="del-task">Delete</button>
          <span><button type="button" class="btn ghost" id="close">Close</button> <button class="btn" type="submit">Save changes</button></span>
        </div>
      </form>
      <h3 style="margin-top:22px">Comments</h3>
      <div id="comments"><div class="muted">Loading…</div></div>
      <form class="comment-form" id="comment-form">
        <input name="content" placeholder="Write a comment…" required maxlength="1000" />
        <button class="btn" type="submit">Send</button>
      </form>
    </div>`;
  document.getElementById('close').onclick = closeModal;
  document.getElementById('task-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      const updated = await api('/api/tasks/' + id, { method: 'PUT', body: { ...f, assignee_id: f.assignee_id || null } });
      Object.assign(task, updated);
      renderBoard();
      closeModal();
    } catch (err) { document.getElementById('err').textContent = err.message; }
  };
  document.getElementById('del-task').onclick = async () => {
    if (!confirm('Delete this task?')) return;
    try {
      await api('/api/tasks/' + id, { method: 'DELETE' });
      state.project.tasks = state.project.tasks.filter((t) => t.id !== id);
      renderBoard();
      closeModal();
    } catch (err) { toast(err.message); }
  };
  document.getElementById('comment-form').onsubmit = async (e) => {
    e.preventDefault();
    const input = e.target.content;
    try {
      const c = await api(`/api/tasks/${id}/comments`, { method: 'POST', body: { content: input.value } });
      input.value = '';
      task.comment_count += 1;
      renderBoard();
      appendComment(c);
    } catch (err) { toast(err.message); }
  };
  const comments = await api(`/api/tasks/${id}/comments`).catch(() => []);
  if (state.openTaskId !== id) return;
  const box = document.getElementById('comments');
  box.innerHTML = comments.length ? comments.map(commentHTML).join('') : '<div class="muted" id="no-comments">No comments yet.</div>';
}

const commentHTML = (c) =>
  `<div class="comment" data-cid="${c.id}"><strong>${esc(c.user_name)}</strong> <span class="muted">${esc(timeAgo(c.created_at))}</span><div>${esc(c.content)}</div></div>`;

function appendComment(c) {
  const box = document.getElementById('comments');
  if (!box || box.querySelector(`[data-cid="${c.id}"]`)) return;
  const empty = document.getElementById('no-comments');
  if (empty) empty.remove();
  box.insertAdjacentHTML('beforeend', commentHTML(c));
}

// update the open modal when someone else changes the task (without clobbering what the user is typing)
function refreshModalFields(task) {
  const form = document.getElementById('task-form');
  if (!form || form.contains(document.activeElement)) return;
  const f = form.elements;
  f.title.value = task.title;
  f.description.value = task.description;
  f.status.value = task.status;
  f.assignee_id.value = task.assignee_id || '';
  f.due_date.value = task.due_date || '';
}

/* ===================== router ===================== */
let lastProjectId = null;
async function route() {
  const parts = (location.hash.replace(/^#/, '') || '/').split('/').filter(Boolean);
  closeModal();
  if (lastProjectId) { leaveProject(lastProjectId); lastProjectId = null; }
  state.project = null;
  renderNav();
  if (!state.user && parts[0] !== 'register') {
    if (parts[0] !== 'login') { location.hash = '#/login'; return; }
  }
  try {
    if (parts[0] === 'login') viewAuth('login');
    else if (parts[0] === 'register') viewAuth('register');
    else if (parts[0] === 'p' && parts[1]) { await viewProject(parts[1]); lastProjectId = state.project.id; }
    else await viewDashboard();
  } catch (err) {
    app.innerHTML = `<div class="empty">${esc(err.message)}<br /><a href="#/">Back to projects</a></div>`;
  }
}
window.addEventListener('hashchange', route);
if (state.user) { connectWS(); loadNotifications(); }
route();
