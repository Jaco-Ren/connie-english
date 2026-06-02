# Connie's English Learning Tracker

**Language:** English | [Simplified Chinese](README.zh-CN.md)

![Vanilla JS](https://img.shields.io/badge/Frontend-Vanilla%20JS-f7df1e?logo=javascript&logoColor=111)
![Supabase](https://img.shields.io/badge/Backend-Supabase-3ecf8e?logo=supabase&logoColor=white)
![Vercel](https://img.shields.io/badge/Deploy-Vercel-000?logo=vercel)
![Status](https://img.shields.io/badge/Status-Online%20Tracker-4c6fff)

An English learning check-in and review system for Connie, supervised by Jaco. Connie submits daily proof for vocabulary, CET-4 reading, and CET-4 listening tasks. Jaco reviews each submission online, and points are awarded only after approval.

The project is built with vanilla HTML, CSS, and JavaScript. The backend uses Supabase Auth, PostgreSQL, Storage, Realtime, and Row Level Security. There is no frontend framework and no build step, which keeps the app lightweight and easy to deploy as a static site.

## Features

| Module | Current implementation |
| --- | --- |
| Login and roles | Supabase Auth login with `profiles.role`, switching between Connie's submission UI and Jaco's review UI |
| Daily tasks | Vocabulary `+5`, CET-4 reading `+7`, CET-4 listening `+8`; listening follows an every-other-day schedule |
| Proof submission | Connie can upload image proof; reading and listening support multiple proof images |
| Image processing | Browser-side JPEG compression with a maximum width of 1000px |
| Review workflow | Jaco can approve, reject, revoke approval, or reopen expired tasks for late submission; only `approved` tasks count toward points |
| Points system | Task points are calculated automatically and combined with manual score adjustments |
| Notes | Jaco can leave notes for Connie, and Connie can leave messages for Jaco |
| Weekly progress | Weekly completion rate, full-attendance days, streak counter, and submission log |
| Realtime sync | `tasks`, `notes`, and `score_adjustments` changes refresh both roles automatically |
| Security | Supabase RLS separates Connie and Jaco permissions |

## Role Workflow

### Connie

1. Sign in with the Connie account.
2. Review today's tasks and weekly progress.
3. Upload proof images after completing tasks.
4. Wait for Jaco's review.
5. Receive points after approval, or resubmit if rejected.
6. Read Jaco's notes and leave a message when needed.

### Jaco

1. Sign in with the Jaco account.
2. Check the pending review panel.
3. Open proof images and verify completion.
4. Approve or reject each submission.
5. Revoke approval or apply manual score adjustments when needed.
6. Leave reminders or feedback for Connie.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | Vanilla HTML + CSS + JavaScript |
| Auth | Supabase Auth |
| Database | Supabase PostgreSQL |
| Storage | Supabase Storage bucket: `proofs` |
| Realtime | Supabase Realtime Postgres changes |
| Security | Supabase Row Level Security |
| Deployment | Vercel static site |

## Project Structure

```text
.
├── index.html                 # Page shell, login view, and app container
├── styles.css                 # Responsive UI styles
├── app.js                     # Rendering, upload, review, scoring, and realtime logic
├── docs/
│   └── supabase-setup.md      # Supabase schema, RLS, and smoke-test notes
└── supabase/
    └── rls.sql                # Re-runnable RLS, Storage, and Realtime setup script
```

## Core Tables

| Table | Purpose |
| --- | --- |
| `profiles` | Connects Supabase Auth users to app roles: `connie` or `jaco` |
| `tasks` | Stores daily task status, proof images, submission time, and review metadata |
| `notes` | Stores Jaco's note for Connie and Connie's message for Jaco |
| `score_adjustments` | Stores Jaco's manual point additions and deductions |

See [docs/supabase-setup.md](docs/supabase-setup.md) for the expected columns, constraints, and permission policies.

## Local Usage

This project does not require dependency installation.

1. Clone the repository.
2. Open `index.html` in a browser.
3. Make sure the browser can access the Supabase CDN and Google Fonts.
4. Sign in with Connie or Jaco accounts that already exist in Supabase and have matching profile roles.

You can also serve the project with any static server, such as VS Code Live Server, Vercel CLI, or another local HTTP server.

## Supabase Setup

The frontend currently reads Supabase configuration directly from `app.js`:

```js
const SUPABASE_URL = '...';
const SUPABASE_KEY = '...';
```

If you reuse this project, replace these values with your own Supabase project URL and publishable key. The publishable key is safe to use in the browser; the actual permission boundary is enforced by RLS policies.

Setup flow:

1. Create a Supabase project.
2. Create one Connie Auth user and one Jaco Auth user.
3. Create the `profiles`, `tasks`, `notes`, and `score_adjustments` tables.
4. Insert the corresponding role rows into `profiles`.
5. Run [supabase/rls.sql](supabase/rls.sql).
6. Follow the smoke test in [docs/supabase-setup.md](docs/supabase-setup.md) to verify Connie submission and Jaco review.

## Deployment

The app can be deployed to Vercel as a static site:

1. Import the repository into Vercel.
2. Choose `Other` as the framework preset, or keep the default static configuration.
3. Leave the Build Command empty.
4. Leave the Output Directory empty, or use the project root.
5. After deployment, test login, upload, review, and realtime sync with both roles.

## Security Notes

- The browser only uses a Supabase publishable key.
- Core authorization relies on Supabase RLS, not hidden frontend buttons.
- Connie can submit or replace `pending/rejected` tasks, but cannot update approved tasks from the browser client.
- Jaco can review tasks, revoke approval, reopen expired tasks for late submission, and create or delete manual score adjustments.
- The `proofs` bucket is currently public because the frontend stores public image URLs.
- If proof images need stronger privacy later, switch to a private bucket and use signed URLs in the frontend.

## Current Limitations

- `notes.content` currently stores both messages with a `|||` separator. A cleaner schema would split this into `jaco_note` and `connie_message`.
- The Supabase URL and publishable key are currently hardcoded in `app.js`. For broader reuse, consider injecting them through deployment-time environment configuration.
- The app currently models one Connie and one Jaco. Supporting multiple learners would require adding an owner or student dimension to `tasks`, `notes`, and `score_adjustments`.
- Proof images are stored as public URLs. Higher privacy requirements would require signed URL support.

## Roadmap Ideas

- Add README screenshots or a GIF showing the Connie and Jaco views.
- Split the notes schema and remove the `|||` delimiter.
- Move task names, schedule, and point values into database-managed configuration.
- Add monthly reports, streak history, or export features.
- Improve upload progress and retry feedback.
