# CodeAlpha_ProjectManager

**CodeAlpha Full Stack Development Internship – Task 3: Project Management Tool**

"TaskBoard" is a collaborative Trello/Asana-style tool: group projects with Kanban boards, task assignment, task comments, and the bonus features — **notifications and real-time updates via WebSockets**.

## Tech stack
- **Frontend:** HTML, CSS, vanilla JavaScript (single-page app, drag & drop board)
- **Backend:** Node.js + Express.js + `ws` (WebSocket server)
- **Database:** SQLite (Node's built-in `node:sqlite`) – users, projects, project_members, tasks, comments, notifications
- **Auth:** bcrypt password hashing + JWT (also used to authenticate the WebSocket connection)

## Features
- Register / login
- Create group projects, invite registered users by email (owner only), remove members, leave or delete a project
- Project board with three columns (To Do / In Progress / Done); drag a card between columns to change its status
- Task cards: title, description, assignee (project members only), due date (overdue highlighted)
- Comments inside each task
- **Real-time:** everybody viewing a project sees task creation, edits, moves, deletions, comments and membership changes instantly (green "Live" indicator, auto-reconnect)
- **Notifications** (bell icon, stored in the database and pushed live): when you are added to a project, assigned a task, a task you're assigned to is moved, or someone comments on a task you created or are assigned to

## Run it
Requires **Node.js 22.5+**.

```bash
npm install
npm start
# open http://localhost:3003
```

To see the real-time features, open the app in two browsers (or one normal + one private window), register two users, create a project in the first, invite the second by email, and open the same project in both.

Optional environment variables: `PORT`, `JWT_SECRET`, `DB_FILE`. The SQLite file `pm.db` is created on first start.

## API
| Method | Endpoint | Description |
|-------:|----------|-------------|
| POST | `/api/register`, `/api/login` | Auth (returns JWT) |
| GET / POST | `/api/projects` | My projects / create project |
| GET / DELETE | `/api/projects/:id` | Project with members + tasks / delete (owner) |
| POST | `/api/projects/:id/members` | Add member by email (owner) |
| DELETE | `/api/projects/:id/members/:userId` | Remove member / leave |
| POST | `/api/projects/:id/tasks` | Create task |
| PUT / DELETE | `/api/tasks/:id` | Update (title, description, status, assignee, due date) / delete |
| GET / POST | `/api/tasks/:id/comments` | List / add comments |
| GET | `/api/notifications` | My notifications + unread count |
| POST | `/api/notifications/read` | Mark all as read |

**WebSocket:** `ws://host/ws?token=<JWT>`. Client sends `{type:"join", projectId}` / `{type:"leave", projectId}`. Server pushes `task_created`, `task_updated`, `task_deleted`, `comment_added`, `member_added`, `member_removed`, `project_deleted` and `notification` events.
