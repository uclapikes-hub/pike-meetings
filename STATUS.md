# STATUS — PIKE Meeting Tracker (UCLA)

> **Resume token.** When picking up the build in a fresh conversation, paste this entire file and I'll be caught up.

## Where we are

**Stage 1 of 5 complete and deployable.** Skeleton with auth, roles, quarter selector, and settings is ready.

| Stage | Status | What it ships |
|---|---|---|
| 1. Foundations | ✅ Built (awaiting deploy) | Auth, roles, quarters, "My Standing" dashboard, settings |
| 2. Meetings + Roll Call | ⏳ Next | Create meetings, QR codes, attendance recording |
| 3. Absence Requests | ⏳ Pending | Submit + review workflow |
| 4. No-show enforcement | ⏳ Pending | Counter, fines, Sgt escalation, appeals, 50% watchlist |
| 5. Email + reports | ⏳ Pending | EmailJS, Excel reports, treasurer fine ledger |

## URLs

- **Live (after deploy):** `https://uclapikes-hub.github.io/pike-meetings/`
- **Repo:** `github.com/uclapikes-hub/pike-meetings`
- **Companion event tracker:** `github.com/uclapikes-hub/pike-attendance` (live at `uclapikes-hub.github.io/pike-attendance/`)
- **Firebase project:** `pike-attendance` (SHARED with event tracker — Option A)

## Locked-in policy decisions

- **Eligible:** Active brothers + New Members
- **Free absences:** 3 per UCLA quarter
- **Approved-with-proof excuses:** don't count toward the 3 (unlimited if approved)
- **Mandatory meetings:** max 4 per quarter, 14 days notice required (Article VI Section 12)
- **Mandatory absence requests:** auto-denied; verbal/manual override only
- **Denied request:** = no-show
- **Pending request when meeting starts:** auto-deny → no-show
- **QR window:** 15 min before meeting start → 5 min after start (configurable per meeting)
- **Roll call:** QR only, no manual exec override
- **1st no-show:** warning email to brother + treasurer
- **2nd no-show:** $25 fine email + Sgt-at-Arms warning
- **3rd no-show:** Sgt-at-Arms primary notice + Vice Chair CC + treasurer
- **Fines:** $25 flat, treasurer collects manually, reset each quarter
- **Appeals:** allowed for no-shows
- **Approvers:** President, IVP, Secretary
- **Sgt-at-Arms:** Nikk Ranjith (`nikkranjith21@gmail.com`)
- **Treasurer:** David Escobedo (`david.mescobedo20@gmail.com`)
- **Judicial Vice Chair:** configurable in Settings tab (empty default)
- **Proof:** text required, file optional
- **Brother auth:** Google sign-in
- **Email service:** EmailJS (Stage 5)
- **Architecture:** **Option A — shared Firebase project** with event tracker
- **Standalone repo:** YES — separate URL, separate codebase, just shares the database

## Architecture decisions

- **Shared Firebase project means combined reporting in Stage 5 is trivial** — the 50% participation watchlist (Article VI Section 12) reads from BOTH `events`/`checkins` and `meetings`/`meeting_attendance` collections. No cross-project federation needed.
- **Roster collection is shared and managed in the event tracker.** This app reads it but doesn't write to it. When a new brother joins, exec adds them in the event tracker's Roster tab, and they appear here automatically.
- **Brother identity = email match against roster.** Same model as the event tracker.
- **Quarter system** is identical to event tracker (same `quarters.js` module, copied).
- **Auth roles in `data.js`** are kept in sync with `firestore.rules` by hand. If you add or remove an exec officer, both files need updating + the rules need re-publishing in Firebase.

## Data model (Firestore)

Existing collections (event tracker, untouched): `events`, `roster`, `checkins`

New collections (this app):
- `meetings/{meetingId}` — title, date, startTime, endTime, location, mandatory bool, qrWindowStart/End, quarter
- `meeting_attendance/{recordId}` — meetingId, brotherKey, status, timestamp, quarter
- `absence_requests/{requestId}` — meetingId, brotherKey, reason, description, proofFileUrl, status, submittedAt, reviewedAt, reviewedBy, reviewerNote, quarter
- `no_shows/{recordId}` — brotherKey, meetingId, reason, count (1/2/3), timestamp, quarter, appealed, appealStatus
- `fines/{fineId}` — brotherKey, amount, reason, meetingId, status (pending/paid/waived), quarter
- `settings/main` — singleton doc: judicialViceChair, sgtAtArmsEmail, treasurerEmail, notes

## Open questions for Stage 2 (Meetings)

1. **Recurring meetings.** One-at-a-time creation, OR a "every Sunday 7 PM" template that auto-generates? Default for v1: **one-at-a-time** (simpler, more control). If exec wants templating later it's an additive feature.
2. **Meeting time format.** Date + start time + end time, OR just date + start time + auto-1-hour-end? Default: explicit start + end.
3. **QR window override.** Default is 5 min after start. Should the create-meeting form let secretary override per-meeting (e.g. 10 min for the first meeting of the term)? Default: yes, with a sensible default.
4. **Display: meetings list view.** Show all this quarter? Show only upcoming? Show past + upcoming with toggle? Default: upcoming-by-default, toggle for past.

## Open questions for Stage 3 (Absence Requests)

1. **File upload.** We agreed text required + file optional. File goes in Firebase Storage. Does Firebase Storage need to be enabled in the shared `pike-attendance` project? (Yes, but it's a free-tier add — quick step in Firebase console.)
2. **What does the brother see on submit?** Confirmation toast + a "Pending" entry in their dashboard, with the option to cancel before review. Confirm.
3. **Approver review UX.** Single-pane queue with each request as a card showing who/when/why/proof, plus Approve/Deny buttons + optional note? Or list + click-to-detail? Default: card pane.
4. **Bulk approve/deny.** If 8 brothers all request out for the same midterm, should approvers be able to multi-select and act? Default: yes, in Stage 3 v1.

## File structure

```
pike-meetings/
├── README.md                     ← Overview
├── DEPLOY.md                     ← Step-by-step deployment
├── STATUS.md                     ← This file
├── firestore.rules               ← MERGED rules (covers both apps)
├── index.html                    ← Main page
├── assets/
│   ├── styles.css                ← Brand styles, richer palette
│   ├── pike-wordmark.png
│   ├── pike-wordmark-sm.png
│   ├── coat-of-arms.jpg
│   └── coat-of-arms-sm.jpg
└── js/
    ├── app.js                    ← UI logic (Stage 1)
    ├── data.js                   ← Firestore + auth wrapper
    ├── firebase-config.js        ← Same Firebase project as event tracker
    └── quarters.js               ← UCLA quarter math
```

## Next-conversation prompt

When picking up Stage 2:

> Picking up the PIKE Meeting Tracker at Stage 2. Repo: `uclapikes-hub/pike-meetings`. Firebase project: `pike-attendance` (shared with event tracker, Option A). Stage 1 is deployed and tested.
>
> Build Stage 2 (Meetings + Roll Call) per the open questions in STATUS.md:
> 1. [your answer to recurring vs. one-at-a-time]
> 2. [your answer to meeting time format]
> 3. [your answer to per-meeting QR window override]
> 4. [your answer to upcoming vs. past meetings display]
>
> Feedback from Stage 1 testing: [paste any issues]
>
> Here's STATUS.md from the repo: [paste this file]

---

Last updated: end of Stage 1 build.
