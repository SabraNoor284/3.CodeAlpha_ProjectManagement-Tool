const express = require('express');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3003;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const STATUSES = ['todo', 'in_progress', 'done'];
const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, 'pm.db'));

db.exec(`
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  project_id INTEGER,
  task_id INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);
`);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);

/* ===================== real-time (WebSocket) ===================== */
const wss = new WebSocketServer({ server, path: '/ws' });
const sockets = new Set(); // each socket: { ws, userId, projects:Set }

const role = (projectId, userId) => {
  const r = db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId);
  return r ? r.role : null;
};

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcastProject(projectId, msg, exceptUserId) {
  for (const c of sockets) {
    if (c.projects.has(Number(projectId)) && c.userId !== exceptUserId) send(c.ws, msg);
  }
}
function pushToUser(userId, msg) {
  for (const c of sockets) if (c.userId === userId) send(c.ws, msg);
}

wss.on('connection', (ws, req) => {
  let user;
  try {
    const token = new URL(req.url, 'http://x').searchParams.get('token');
    user = jwt.verify(token, JWT_SECRET);
  } catch {
    ws.close(4401, 'unauthorized');
    return;
  }
  const client = { ws, userId: user.id, projects: new Set() };
  sockets.add(client);
  send(ws, { type: 'ready' });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'join' && role(msg.projectId, user.id)) {
      client.projects.add(Number(msg.projectId));
      send(ws, { type: 'joined', projectId: Number(msg.projectId) });
    } else if (msg.type === 'leave') {
      client.projects.delete(Number(msg.projectId));
    }
  });
  ws.on('close', () => sockets.delete(client));
  ws.on('error', () => sockets.delete(client));
});

function notify(userId, message, projectId, taskId) {
  const info = db
    .prepare('INSERT INTO notifications (user_id, message, project_id, task_id) VALUES (?,?,?,?)')
    .run(userId, message, projectId ?? null, taskId ?? null);
  const n = db.prepare('SELECT * FROM notifications WHERE id = ?').get(Number(info.lastInsertRowid));
  pushToUser(userId, { type: 'notification', notification: n });
}

/* ===================== helpers ===================== */
const signToken = (u) => jwt.sign({ id: u.id, name: u.name, email: u.email }, JWT_SECRET, { expiresIn: '7d' });
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Login required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// loads project + membership for :id, 404 if the user can't see it
function projectAccess(req, res, next) {
  const id = Number(req.params.id);
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  const r = p ? role(id, req.user.id) : null;
  if (!p || !r) return res.status(404).json({ error: 'Project not found' });
  req.project = p;
  req.role = r;
  next();
}

const TASK_SELECT = `
  SELECT t.*, a.name AS assignee_name,
    (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count
  FROM tasks t LEFT JOIN users a ON a.id = t.assignee_id`;
const getTask = (id) => db.prepare(TASK_SELECT + ' WHERE t.id = ?').get(id);

function taskAccess(req, res, next) {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id));
  if (!t || !role(t.project_id, req.user.id)) return res.status(404).json({ error: 'Task not found' });
  req.task = t;
  next();
}

const isMember = (projectId, userId) => !!role(projectId, userId);
const validDate = (d) => d === undefined || d === null || d === '' || /^\d{4}-\d{2}-\d{2}$/.test(d);

/* ===================== auth ===================== */
app.post('/api/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'Email is already registered' });
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash) VALUES (?,?,?)')
    .run(name.trim().slice(0, 60), email.trim(), bcrypt.hashSync(password, 10));
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
  res.status(201).json({ token: signToken(u), user: publicUser(u) });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: 'Incorrect email or password' });
  res.json({ token: signToken(u), user: publicUser(u) });
});

app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

/* ===================== projects ===================== */
app.get('/api/projects', auth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.*, m.role,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count,
        (SELECT COUNT(*) FROM project_members x WHERE x.project_id = p.id) AS member_count
       FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
       ORDER BY p.id DESC`
    )
    .all(req.user.id);
  res.json(rows);
});

app.post('/api/projects', auth, (req, res) => {
  const { name, description } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Project name is required' });
  const info = db
    .prepare('INSERT INTO projects (name, description, owner_id) VALUES (?,?,?)')
    .run(name.trim().slice(0, 80), String(description || '').slice(0, 500), req.user.id);
  const id = Number(info.lastInsertRowid);
  db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?,?,'owner')").run(id, req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
});

app.get('/api/projects/:id', auth, projectAccess, (req, res) => {
  const members = db
    .prepare(
      `SELECT u.id, u.name, u.email, m.role FROM project_members m JOIN users u ON u.id = m.user_id
       WHERE m.project_id = ? ORDER BY m.role DESC, u.name`
    )
    .all(req.project.id);
  const tasks = db.prepare(TASK_SELECT + ' WHERE t.project_id = ? ORDER BY t.id').all(req.project.id);
  res.json({ ...req.project, my_role: req.role, members, tasks });
});

app.delete('/api/projects/:id', auth, projectAccess, (req, res) => {
  if (req.role !== 'owner') return res.status(403).json({ error: 'Only the owner can delete a project' });
  broadcastProject(req.project.id, { type: 'project_deleted', projectId: req.project.id }, req.user.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.project.id);
  res.json({ ok: true });
});

app.post('/api/projects/:id/members', auth, projectAccess, (req, res) => {
  if (req.role !== 'owner') return res.status(403).json({ error: 'Only the owner can add members' });
  const email = String((req.body || {}).email || '').trim();
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u) return res.status(404).json({ error: 'No user with that email. Ask them to register first.' });
  if (isMember(req.project.id, u.id)) return res.status(409).json({ error: 'Already a member' });
  db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?,?,'member')").run(req.project.id, u.id);
  notify(u.id, `${req.user.name} added you to project "${req.project.name}"`, req.project.id);
  broadcastProject(req.project.id, { type: 'member_added', projectId: req.project.id }, req.user.id);
  res.status(201).json({ id: u.id, name: u.name, email: u.email, role: 'member' });
});

app.delete('/api/projects/:id/members/:userId', auth, projectAccess, (req, res) => {
  const uid = Number(req.params.userId);
  if (req.role !== 'owner' && uid !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
  if (uid === req.project.owner_id) return res.status(400).json({ error: 'The owner cannot be removed' });
  db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(req.project.id, uid);
  db.prepare('UPDATE tasks SET assignee_id = NULL WHERE project_id = ? AND assignee_id = ?').run(req.project.id, uid);
  broadcastProject(req.project.id, { type: 'member_removed', projectId: req.project.id, userId: uid }, req.user.id);
  res.json({ ok: true });
});

/* ===================== tasks ===================== */
app.post('/api/projects/:id/tasks', auth, projectAccess, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Task title is required' });
  const status = b.status || 'todo';
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (!validDate(b.due_date)) return res.status(400).json({ error: 'Due date must be YYYY-MM-DD' });
  const assignee = b.assignee_id ? Number(b.assignee_id) : null;
  if (assignee && !isMember(req.project.id, assignee)) return res.status(400).json({ error: 'Assignee must be a project member' });
  const info = db
    .prepare('INSERT INTO tasks (project_id, title, description, status, assignee_id, due_date, created_by) VALUES (?,?,?,?,?,?,?)')
    .run(req.project.id, title.slice(0, 120), String(b.description || '').slice(0, 2000), status, assignee, b.due_date || null, req.user.id);
  const task = getTask(Number(info.lastInsertRowid));
  if (assignee && assignee !== req.user.id)
    notify(assignee, `${req.user.name} assigned you "${task.title}" in "${req.project.name}"`, req.project.id, task.id);
  broadcastProject(req.project.id, { type: 'task_created', task, by: req.user.name }, req.user.id);
  res.status(201).json(task);
});

app.put('/api/tasks/:id', auth, taskAccess, (req, res) => {
  const t = req.task;
  const b = req.body || {};
  const next = {
    title: b.title !== undefined ? String(b.title).trim() : t.title,
    description: b.description !== undefined ? String(b.description).slice(0, 2000) : t.description,
    status: b.status !== undefined ? b.status : t.status,
    assignee_id: b.assignee_id !== undefined ? (b.assignee_id ? Number(b.assignee_id) : null) : t.assignee_id,
    due_date: b.due_date !== undefined ? b.due_date || null : t.due_date,
  };
  if (!next.title) return res.status(400).json({ error: 'Task title is required' });
  if (!STATUSES.includes(next.status)) return res.status(400).json({ error: 'Invalid status' });
  if (!validDate(next.due_date)) return res.status(400).json({ error: 'Due date must be YYYY-MM-DD' });
  if (next.assignee_id && !isMember(t.project_id, next.assignee_id))
    return res.status(400).json({ error: 'Assignee must be a project member' });

  db.prepare('UPDATE tasks SET title=?, description=?, status=?, assignee_id=?, due_date=? WHERE id=?').run(
    next.title.slice(0, 120), next.description, next.status, next.assignee_id, next.due_date, t.id
  );
  const task = getTask(t.id);
  const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(t.project_id);
  if (next.assignee_id && next.assignee_id !== t.assignee_id && next.assignee_id !== req.user.id)
    notify(next.assignee_id, `${req.user.name} assigned you "${task.title}" in "${project.name}"`, t.project_id, t.id);
  if (next.status !== t.status && t.assignee_id && t.assignee_id !== req.user.id && next.assignee_id === t.assignee_id)
    notify(t.assignee_id, `${req.user.name} moved "${task.title}" to ${next.status.replace('_', ' ')}`, t.project_id, t.id);
  broadcastProject(t.project_id, { type: 'task_updated', task, by: req.user.name }, req.user.id);
  res.json(task);
});

app.delete('/api/tasks/:id', auth, taskAccess, (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.task.id);
  broadcastProject(req.task.project_id, { type: 'task_deleted', taskId: req.task.id, by: req.user.name }, req.user.id);
  res.json({ ok: true });
});

/* ===================== comments ===================== */
const COMMENT_SELECT = `SELECT c.id, c.task_id, c.content, c.created_at, u.id AS user_id, u.name AS user_name
  FROM comments c JOIN users u ON u.id = c.user_id`;

app.get('/api/tasks/:id/comments', auth, taskAccess, (req, res) => {
  res.json(db.prepare(COMMENT_SELECT + ' WHERE c.task_id = ? ORDER BY c.id').all(req.task.id));
});

app.post('/api/tasks/:id/comments', auth, taskAccess, (req, res) => {
  const content = String((req.body || {}).content || '').trim();
  if (!content) return res.status(400).json({ error: 'Comment cannot be empty' });
  if (content.length > 1000) return res.status(400).json({ error: 'Comment is too long' });
  const info = db.prepare('INSERT INTO comments (task_id, user_id, content) VALUES (?,?,?)').run(req.task.id, req.user.id, content);
  const comment = db.prepare(COMMENT_SELECT + ' WHERE c.id = ?').get(Number(info.lastInsertRowid));
  const recipients = new Set([req.task.assignee_id, req.task.created_by]);
  recipients.delete(req.user.id);
  recipients.delete(null);
  for (const uid of recipients)
    if (isMember(req.task.project_id, uid)) notify(uid, `${req.user.name} commented on "${req.task.title}"`, req.task.project_id, req.task.id);
  broadcastProject(req.task.project_id, { type: 'comment_added', taskId: req.task.id, comment }, req.user.id);
  res.status(201).json(comment);
});

/* ===================== notifications ===================== */
app.get('/api/notifications', auth, (req, res) => {
  const items = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(req.user.id);
  const unread = db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user.id).c;
  res.json({ unread, items });
});

app.post('/api/notifications/read', auth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

if (require.main === module) {
  server.listen(PORT, () => console.log(`Project manager running at http://localhost:${PORT}`));
}
module.exports = { app, server };
