# Calendar Connector

Merge Google Calendars from several Google accounts into one calendar, and share it in full or as free/busy only.

It runs on Google Apps Script, so there is no server to host and nothing to pay for. Your computer can be off.

## How it works

The same script is installed in every account that needs to contribute events. Each copy reads the calendars its account can see and writes copies of their events into a merged calendar it can edit. A time trigger runs it every 5 minutes.

```
account A ──(shared with the main account)──┐
account B ──(shared with the main account)──┼──> script in the main account ──┐
                                            │                                 ├──> merged calendar
account C (org calendars that can't be      └─> script in account C ──────────┘
re-shared, e.g. Google Workspace)
```

- **Incremental sync.** It uses Calendar API sync tokens, so only changes are read after the first run.
- **Copies are safe:**
  - no attendees are copied, so nobody gets invitations;
  - no reminders are copied;
  - every copy is tagged with its source, so copies are never copied again.
- **Deterministic ids.** Each copy's id is derived from its source event. There is no mapping table, re-runs never create duplicates, and edits to single occurrences of a recurring event are applied to the right occurrence of the copy.
- **Two modes per source:**
  - *full details*;
  - *busy only*: just the time, with a configurable label such as "Busy".
- **Cascade sources.** A merged calendar can feed another calendar. Only events that came from other accounts are passed on, so there are no loops and nothing comes back as a duplicate.

  Example: write "Busy" blocks from personal accounts into a work account's primary calendar. Colleagues then see your real availability in the "Meet with…" search, which only shows primary calendars.
- **Web UI** (visible only to the account owner):
  - create a merged calendar and choose its color;
  - pick sources and their mode;
  - share by link or with specific people;
  - see sync status and run a sync on demand.

## Setup

Requires macOS (arm64) and `make`. Everything (Node.js, clasp, npm cache, credentials) is installed inside the project folder. Deleting the folder removes all of it, and the deployed scripts keep running.

```sh
make setup                     # local Node.js and clasp
make test                      # unit tests + sync tests against a fake Calendar API
make login  ACCOUNT=personal   # sign in to Google in the browser
make create ACCOUNT=personal   # create the Apps Script project in that account (once)
make push   ACCOUNT=personal   # run tests, then upload the code
make app    ACCOUNT=personal   # print the web UI URL
```

`ACCOUNT` is any name you choose. Use one name per Google account that runs a copy of the script. Before `make create`, enable the Apps Script API for that account at https://script.google.com/home/usersettings.

### Connecting accounts

1. **Pick a main account.** It will own the merged calendar. Open its web UI and create the merged calendar there.
2. **For every other account, share its calendars with the main account.** In Google Calendar open Settings → the calendar → *Share with specific people* → the main account → *See all event details*.

   If a shared calendar does not appear in the UI, add it under **Add a source calendar**. A primary calendar's id is the account's email address.
3. **If a calendar can't be shared** (for example, an organization-owned calendar in Google Workspace), install the script in that account instead:
   1. in the main account's UI, give that account **edit** access to the merged calendar;
   2. run `make login create push app ACCOUNT=<name>`;
   3. open the printed URL;
   4. attach the merged calendar by its id;
   5. tick the sources.

On first open, Google warns that the app is unverified, because it is your own unpublished script. Choose *Advanced* → *Go to …* and allow access.

If you are signed in to several Google accounts, the web UI may fail to open. Use a private window, or for Workspace accounts the URL form `https://script.google.com/a/macros/<domain>/s/<id>/dev`.

## Maintenance

- **Normally nothing.** The scripts run on Google's servers every 5 minutes.
- **New calendars are not picked up automatically.** This includes new course calendars each semester: open the UI, tick them and save. Unticking a source deletes its copies.
- **Check the UI now and then.** Each source shows the result of its last run, and errors are shown in red.
- **To update the code**, run `make push ACCOUNT=<name>` for each account. If Google asks for new permissions, open the UI once.
- **To turn everything off**, delete the "Calendar Connector (…)" projects at https://script.google.com/home in each account, then delete the merged calendar if you no longer need it.

## Project layout

| Path | Purpose |
|---|---|
| `src/Transform.js` | Pure logic: what to do with a source event and the body of its copy |
| `src/Sync.js` | Incremental sync, paging, time budget, recovery from expired sync tokens |
| `src/Api.js` | Calendar API wrappers: error codes, retries, idempotent writes |
| `src/Calendars.js` | Merged calendars, colors, sharing, trigger |
| `src/Config.js` | Settings and sync state in Script Properties |
| `src/Ui.js`, `src/Index.html` | Web UI |
| `test/` | `node --test` suites; `sync.test.js` runs the real code against an in-memory Calendar API |
| `docs/PLAN.md` | Original design notes (in Russian) |
