# PIKE Chapter Meetings — UCLA

Standalone meeting attendance + absence request system for Pi Kappa Alpha (Beta Eta, UCLA). Companion to the [event tracker](https://uclapikes-hub.github.io/pike-attendance/).

## What this app does

- Brothers scan a QR code at chapter meetings to mark themselves present
- Brothers submit absence requests (≥48 hours in advance)
- Approvers (President / IVP / Secretary) review requests
- System tracks no-shows, escalates to warnings → fines → Sgt-at-Arms per chapter bylaws
- Treasurer pulls fine ledgers; exec pulls quarterly attendance reports

## Architecture

- **Hosting:** GitHub Pages (free)
- **Database:** Firebase Firestore — **shared with the event tracker** (same `pike-attendance` project)
- **Auth:** Firebase Auth (Google sign-in)
- **Roles:** exec, approver, sergeant-at-arms, treasurer, judicial vice chair, brother, guest

## Stage 1 (live now)

✅ Brother + exec sign-in with role detection
✅ Quarter selector (UCLA quarter system)
✅ "My Standing" dashboard
✅ Settings screen for Sgt-at-Arms email + Judicial Vice Chair email
✅ All other tabs scaffolded with "coming soon" messaging

## Stages 2–5 (in progress)

⏳ Stage 2: Create meetings, generate QR codes, roll call
⏳ Stage 3: Submit + review absence requests
⏳ Stage 4: No-show enforcement, $25 fines, Sgt-at-Arms escalation, appeals
⏳ Stage 5: EmailJS notifications + Excel reports + 50% participation watchlist

## Files

```
index.html              ← Main app
firestore.rules         ← MERGED rules covering both apps (paste in Firebase)

js/
  firebase-config.js    ← Firebase project config (same as event tracker)
  data.js               ← Firestore + auth wrapper
  quarters.js           ← UCLA quarter math
  app.js                ← UI logic

assets/
  styles.css            ← PIKE brand styling (richer palette than event tracker)
  pike-wordmark.png
  coat-of-arms.jpg
  pike-wordmark-sm.png
  coat-of-arms-sm.jpg

README.md
DEPLOY.md               ← Deployment + Firebase rules update walkthrough
```

## Bylaw references

This app is built to comply with:

- **Article VI Section 12:** Mandatory meetings (max 4/quarter, 14 days notice); 50% participation watchlist
- **Article VIII Section 3:** Roll call as step 2 of every meeting
- **Article VI Sections 1–9:** Judicial board structure, Sgt-at-Arms role
- **Article VI Section 13:** Fine schedule (TBD per chapter discussion)
- **Secretary Handbook:** QR code roll call as best practice; 48-hour absence notice rule

Where bylaws and policy decisions diverge, see `Meeting_Tracker_Spec_Confirmation.md`.
