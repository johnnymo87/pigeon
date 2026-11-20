# Runbook: Slack workspace and app setup (one per machine)

Creates the personal Slack workspace and the pigeon app for one machine (devbox, cloudbox,
macbook), and stages its credentials, so that the machine can later be flipped from Telegram to
Slack (chat-transport phase 2, epic `pigeon-4ogz`). Spec:
`docs/plans/2026-11-20-slack-transport-design.md` (§2 workspaces and apps, §3 Muting). Bead that
runs this: `pigeon-4ogz.7`.

**This runbook changes nothing in pigeon.** It ends with credentials staged in sops. Nothing goes
into the worker until the flip (`scripts/slack-flip.ts <machine> on`, `pigeon-4ogz.6`), and no
Slack resource beyond the ones listed here is created without asking Jonathan.

## What you end up with, per machine

| | devbox | cloudbox | macbook |
|---|---|---|---|
| Machine id (`CCR_MACHINE_ID`, used in the manifest and the secret names) | `devbox` | `cloudbox` | `macbook` |
| Workspace name (the Telegram group's name) | `pigeon devbox` | `pigeon cloudbox` | `pigeon <mac name>`: the Mac Telegram group's title as Jonathan sees it; ask him if no note records it, and use `pigeon macbook` if he has no preference. Do not call the Bot API for it (`getChat` puts the bot token in the URL) |
| Workspace owner | `jonathan.mohrbacher@gmail.com` | same | same |
| Preferred URL | `pigeon-devbox.slack.com` | `pigeon-cloudbox.slack.com` | `pigeon-macbook.slack.com` |
| Channels created here | `#alerts`, `#em-alerts` | `#alerts` | `#alerts` |
| App | `pigeon devbox`, from the rendered manifest | `pigeon cloudbox` | `pigeon macbook` |
| Worker config, staged in workstation sops `secrets/devbox.yaml` | `pigeon_slack_workspace_devbox` | `pigeon_slack_workspace_cloudbox` | `pigeon_slack_workspace_macbook` |
| `#alerts` incoming-webhook URL, in the machine's own secrets | sops `secrets/devbox.yaml` `pigeon_slack_alarm_webhook` | sops `secrets/cloudbox.yaml` `pigeon_slack_alarm_webhook` | Keychain `pigeon-slack-alarm-webhook` |

All three workspaces can be set up from devbox. The webhook for cloudbox and the Mac is carried
to its machine by that machine's config bead (`pigeon-4ogz.10`, `.11`); devbox's by `.15`.

The worker config is a JSON object with exactly these fields, and nothing else (the webhook URL
is *not* part of it):

```json
{"teamId":"T…","appId":"A…","domain":"pigeon-devbox","botToken":"xoxb-…","userToken":"xoxp-…",
 "signingSecret":"<32 hex>","ownerUserId":"U…"}
```

`domain` is the subdomain only. `node packages/worker/scripts/slack-manifest.mjs check-config <file>`
checks the shape without printing any secret.

## Safeguards (browser and tokens)

Signup has no API, so it needs a browser: a throwaway headless Chromium on devbox
(`nix shell nixpkgs#chromium`), or Jonathan's browser on port 9222 when he attaches it. If Slack
blocks automation (captcha, "unusual activity"), stop and hand that step to Jonathan; do not try to
get around it.

- **A throwaway profile**: `--user-data-dir=$(mktemp -d)`. Never a real profile.
- **CDP over `--remote-debugging-pipe`**, or a random localhost port. Not 9222, which is
  Jonathan's.
- **Never extract or store a client token (`xoxc-`, `xoxd-` cookie) or a session cookie.** The
  only tokens kept are the app's own bot (`xoxb-`) and user (`xoxp-`) tokens, read from the app's
  *OAuth & Permissions* page. `check-config` refuses `xoxc`/`xoxd` values.
- **An app configuration token** (if you create the app through `apps.manifest.create` rather than
  the UI) is used for that one call, then revoked on the *Your App Configuration Tokens* page and
  discarded. It is never stored.
- **Secrets never pass through argv, stdout, a log, a commit, a screenshot, or your own
  transcript.** Anything a tool returns to you is stored in the session database and sent to the
  model provider, so "I'll read it and write it to the file" already leaks it. See *Getting a
  secret off a page* below.
- **When done**: sign out of every workspace in that browser, close it, and delete the profile
  directory.

### Getting a secret off a page

The pages that show secrets are *OAuth & Permissions* (bot and user tokens), *Basic Information →
App Credentials* (signing secret, after *Show*), *Incoming Webhooks* (the webhook URL) and the
app configuration token modal. On those pages:

- **No screenshots** and no accessibility-tree or DOM dumps returned to you. If you need to see
  where you are, inject `input, code, pre, [data-qa*="token"] { filter: blur(8px) !important }`
  first, and screenshot only after.
- **Read the value inside your browser-driver process and pipe it to `stage-field`**, which writes
  it into the staging file (0600, outside any work tree) and prints only its shape:

  ```js
  // inside the Node CDP driver, never returned to the agent
  const { spawnSync } = require("node:child_process");
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector(${JSON.stringify(selector)})?.value
                 ?? document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`,
    returnByValue: true,
  });
  const r = spawnSync("node", [SCRIPT, "stage-field", FILE, FIELD], { input: result.value.trim() });
  console.log(r.stdout.toString(), r.stderr.toString()); // "staged botToken …: xoxb-…, 57 chars"
  ```

  `SCRIPT` is `packages/worker/scripts/slack-manifest.mjs`; `FILE` is `~/slack-workspace.<m>.json`
  (config fields) or `~/slack-alarm-webhook.<m>` (with `FIELD` = `alarmWebhookUrl`). Find the
  selector on a blurred page; print the element's tag and attributes, never its value. If a value
  sits behind a *Copy* button rather than in the DOM, click *Show* first. `stage-field` refuses a
  value of the wrong shape (an `xoxc` token, a truncated secret) without echoing it, so a
  wrong selector fails loudly instead of staging junk.
- Non-secret ids (team, app, owner) can be read normally, or staged the same way.

## Per workspace

Do the whole sequence for one workspace before starting the next. `<m>` is the machine id.

### 1. Render the manifest

From a pigeon checkout (any worktree on main):

```bash
node packages/worker/scripts/slack-manifest.mjs render <m> > /tmp/slack-manifest.<m>.json
```

It names the app `pigeon <m>` and points every request URL at
`https://ccr-router.jonathan-mohrbacher.workers.dev/slack/<m>/{events,interactivity,commands}`.
Bot scopes `chat:write channels:manage channels:read channels:history channels:join commands
files:read files:write incoming-webhook`; user scope `channels:write` (unarchive, and the real-mute
candidate); bot event `message.channels`; interactivity on; slash commands `/launch /kill
/interrupt /compact /retitle /mcp /model /tag` (`/rename` is a Slack built-in, hence `/retitle`);
token rotation off (rotated tokens expire in 12 h, and nothing in the worker refreshes them).

### 2. Create the workspace

1. `https://slack.com/get-started#/createnew`, sign in as `jonathan.mohrbacher@gmail.com`. The
   six-character code arrives in Gmail; read it with `gws` on devbox (the `using-gws` skill).
2. Workspace name: `pigeon <box>` (table above). Your name: `Jonathan`.
3. Skip inviting anyone.
4. If it asks what the team is working on (it creates a channel from the answer), answer `alerts`,
   which creates `#alerts`. Otherwise create `#alerts` yourself as the first channel (step 3).
5. Choose the free plan ("Limited Free Version"), not a Pro trial.
6. Workspace settings → URL: set `pigeon-<m>` if Slack picked something else. If it is taken, keep
   what Slack gives and use that as `domain`.
7. Note the team id: it is the `T…` in the browser URL (`app.slack.com/client/T…/…`).

### 3. Create the channels first

`#alerts` must exist before the app is installed, because the install picks the channel the
incoming webhook posts to. On devbox also create `#em-alerts` (for `pigeon-4ogz.9`). Both public.
Create nothing else: session channels are pigeon's to create.

### 4. Create the app from the manifest

Either:

- **UI**: `https://api.slack.com/apps` → *Create New App* → *From a manifest* → pick the workspace
  → paste `/tmp/slack-manifest.<m>.json` (JSON tab) → *Create*; or
- **API**: generate an app configuration token for the workspace on that same page, staged with
  the recipe above into its own 0600 file (`~/slack-config-token.<m>`; it is not a config field,
  so write it from the driver with `fs.writeFileSync(path, value, {mode: 0o600})`). The response
  carries `credentials.signing_secret` and `client_secret`, so never print it:

  ```bash
  umask 077
  curl -s -H @<(printf 'Authorization: Bearer %s' "$(cat ~/slack-config-token.<m>)") \
    --data-urlencode manifest@/tmp/slack-manifest.<m>.json https://slack.com/api/apps.manifest.create \
    > ~/slack-create.<m>.json   # 0600 under the umask below
  jq '{ok, error, errors, app_id}' ~/slack-create.<m>.json
  jq -r .app_id ~/slack-create.<m>.json | node packages/worker/scripts/slack-manifest.mjs stage-field ~/slack-workspace.<m>.json appId
  jq -r .credentials.signing_secret ~/slack-create.<m>.json | node packages/worker/scripts/slack-manifest.mjs stage-field ~/slack-workspace.<m>.json signingSecret
  rm ~/slack-create.<m>.json ~/slack-config-token.<m>
  ```

  Then revoke the token on the *Your App Configuration Tokens* page.

Expect the Events request URL to be **unverified** ("Your URL didn't respond…"). That is correct:
the worker answers Slack only for a workspace whose config secret it holds, and it gets that only
at the flip. Verification is a flip-time step (below). Do not edit the URL to make the warning go
away.

Note the app id (`A…`, *Basic Information*).

### 5. Install the app

*Install App* → *Install to Workspace*. On the consent page, choose **`#alerts`** as the channel
for the incoming webhook. Then collect each value with `stage-field` (*Getting a secret off a
page*), under `umask 077`:

| Field | Where |
|---|---|
| `botToken` | *OAuth & Permissions* → Bot User OAuth Token (`xoxb-`) |
| `userToken` | *OAuth & Permissions* → User OAuth Token (`xoxp-`), Jonathan's, for unarchive |
| `signingSecret` | *Basic Information* → App Credentials → Signing Secret (not the deprecated Verification Token) |
| `appId` | *Basic Information* → App ID |
| `teamId`, `domain` | step 2 |
| `ownerUserId` | Jonathan's member id: his profile → ⋮ → *Copy member ID* (`U…`) |
| the `#alerts` webhook URL | *Incoming Webhooks* → the URL for `#alerts` (`https://hooks.slack.com/services/…`). Goes in a **separate** file: it is not part of the worker config |

### 6. Notifications (Jonathan's account, this browser session)

Spec D7 (revised 2026-11-20): **nothing pushes to start**; Jonathan turns categories on later
(`SLACK_NOTIFY_OWNER`, `PIGEON_SLACK_NOTIFY_OWNER`). A push happens only on an @-mention, and pigeon
mentions him only for enabled categories, so with these preferences and every category off, nothing
pushes:

0. *Preferences → Availability → Allow notifications*: **Every day, 12:00 AM to Midnight**. A new
   workspace defaults to weekdays 9:00–17:00 and pauses everything outside it, `#alerts` included.
1. *Preferences → Notifications → Notify me about*: **"Direct messages, mentions & keywords"**
   ("Mentions only"). Session channels then push only when pigeon @-mentions him (questions, error
   alerts).
2. **No per-channel override.** `#alerts` and `#em-alerts` stay at *Just mentions* (the bell →
   *Edit notifications*). To make one push on every post later (healthchecks.io cannot mention),
   set it to *All new posts* there.
3. Mobile: check that *Use different settings for my mobile devices* is **off**, so the phone
   follows desktop. Do this check on the phone if Jonathan has the workspace there; otherwise
   record it as unchecked.

Unread badges still show for session channels; that is the difference from a real mute.

### 7. Real-mute test (record the result, pass or fail)

Slack has no public API for muting. The only route is the undocumented `users.prefs.set` with
`muted_channels`, known to work with client tokens and unknown with an app's user token. Test it
**with the app's user token only** (never a client token):

1. Create a scratch public channel `#mute-test`. Do not invite the bot or post in it: the worker
   refuses every event until the flip, and each refused delivery counts towards Slack disabling the
   app's event subscriptions (see *At the flip*).
2. Call `users.prefs.set` with the user token to add that channel's id to `muted_channels` (read
   `users.prefs.get` first and write back the existing list plus the one id; it is a whole-list
   write):

   ```bash
   tok() { printf 'Authorization: Bearer %s' "$(jq -r .userToken ~/slack-workspace.<m>.json)"; }
   curl -s -H @<(tok) https://slack.com/api/users.prefs.get | jq '{ok, error, muted: .prefs.muted_channels}'
   curl -s -H @<(tok) --data-urlencode 'name=muted_channels' --data-urlencode 'value=<existing,>C…' \
     https://slack.com/api/users.prefs.set | jq '{ok, error}'
   ```

   The method is undocumented, so its argument shape is the web client's. If it answers
   `invalid_arguments` (a shape problem, not a token one), try the other form once,
   `--data-urlencode 'prefs={"muted_channels":"<existing,>C…"}'`, before calling it a fail.

3. **Pass** only if `#mute-test` then shows as muted in the client (reload it: the channel is
   dimmed in the sidebar and its menu offers *Unmute channel*), not merely if the API answers
   `ok: true`. Any error
   (`missing_scope`, `not_allowed_token_type`, `unknown_method`), or `ok` with no visible effect,
   is a **fail**. Do not retry with another kind of token.
4. Archive `#mute-test`.
5. Record the result, with the exact API answers, as a `bd note` on `pigeon-4ogz.7` and in the
   *Results* section at the end of this runbook. On a pass, the worker may mute session channels
   best-effort (`pigeon-4ogz.3`); on a fail it does nothing, and the mention mechanism above
   already meets D7.

### 8. Check and stage the credentials

The staging files live in your home directory, mode 0600, never in a work tree, written by
`stage-field`:

```bash
# ~/slack-workspace.<m>.json  : the worker config JSON (7 fields)
# ~/slack-alarm-webhook.<m>   : the #alerts webhook URL, one line
node packages/worker/scripts/slack-manifest.mjs check-config ~/slack-workspace.<m>.json
```

`check-config` prints the ids and "ok", or the fields that are wrong (never their values). Then
check the tokens against Slack (read-only; tokens go through a header file, not argv):

```bash
for t in botToken userToken; do
  curl -s -H @<(printf 'Authorization: Bearer %s' "$(jq -r .$t ~/slack-workspace.<m>.json)") \
    https://slack.com/api/auth.test | jq -c --arg t "$t" '{t: $t, ok, error, team_id, user_id}'
done
```

Expect `ok: true` for both, `team_id` = `teamId`, and for `userToken`, `user_id` = `ownerUserId`.

Stage the worker config in the workstation repo's `secrets/devbox.yaml` (from a workstation
worktree on devbox; age key `/persist/sops-age-key.txt`), as a JSON-encoded string, so it is never
typed or echoed:

```bash
/run/wrappers/bin/sudo nix-shell -p sops -p jq --run 'v=$(jq -c . ~dev/slack-workspace.<m>.json | jq -R .); SOPS_AGE_KEY_FILE=/persist/sops-age-key.txt sops set secrets/devbox.yaml "[\"pigeon_slack_workspace_<m>\"]" "$v"; unset v'
```

All three machines' configs go into **devbox's** file, because the flip script runs on devbox. They
are not declared as NixOS secrets here; how the flip reads them is `pigeon-4ogz.6`'s. Check it
round-trips (an empty value is accepted silently by `sops set`); this prints only the team id:

```bash
/run/wrappers/bin/sudo nix-shell -p sops -p jq --run 'SOPS_AGE_KEY_FILE=/persist/sops-age-key.txt sops -d --extract "[\"pigeon_slack_workspace_<m>\"]" secrets/devbox.yaml | jq -r .teamId'
```

The webhook URL is not staged here: hand `~/slack-alarm-webhook.<m>` to the machine's config bead
(`.15` devbox: sops `pigeon_slack_alarm_webhook` in `secrets/devbox.yaml`; `.10` cloudbox: same key
in `secrets/cloudbox.yaml`; `.11` macbook: Keychain `pigeon-slack-alarm-webhook`), or do that
`sops set` now with the same pattern. The owner id is not a secret and goes into the daemon env as
`PIGEON_SLACK_OWNER_USER_ID` and into `PIGEON_PULL_ALLOWED_USER_IDS` (those beads).

Workstation changes go through a branch and PR. Delete the staging files once everything is in
sops (or the Keychain) and the PR is merged.

### 9. Record and clean up

- `bd note pigeon-4ogz.7` the non-secret ids: team id, app id, domain, owner id, webhook channel,
  and the step 6 and 7 results.
- Sign out, close the browser, delete the profile directory.

## At the flip (for `pigeon-4ogz.8`, `.10`, `.11`)

These need the worker holding the workspace's config, so they cannot be done at setup. They need
the app settings page, so sign in again in a fresh throwaway profile under the same safeguards
(code through `gws`), and sign out and delete it afterwards.

1. `scripts/slack-flip.ts <m> on` (the only way to put the secret).
2. App settings → *Event Subscriptions* → **Retry** next to the request URL. It must turn
   *Verified*. If it does not, either the worker is refusing Slack's signature (check the
   `signingSecret` in the staged config) or it is applying the `team_id`/`api_app_id` check to
   `url_verification`, whose body carries neither (`pigeon-4ogz.4`).
3. Check that event subscriptions are **enabled** on that page, and search Gmail (`gws`) for a
   Slack mail saying the app's event subscriptions were disabled. Slack disables them when more than
   95% of deliveries fail within an hour, and before the flip every delivery fails, so a message
   typed in a channel the bot is in (`#alerts`, once pigeon posts there) can trip it. If disabled,
   re-enable them there.
4. *Event Subscriptions* → turn **Delayed Events** on (hourly retries for 24 h after the first
   three). It is not a manifest field. Turn it on only now, after *Verified*.
5. Then the live checks listed on the flip bead.

Events Slack sent before the flip were refused and are not replayed; that is harmless.

## Changing the manifest later

Edit `packages/worker/slack/manifest.template.json` (and the test that pins it,
`packages/daemon/test/slack-manifest-script.test.ts`), merge, re-render, and paste into each app's
*App Manifest* page (or `apps.manifest.update`). A **scope** change needs a reinstall. Check with
`auth.test` afterwards whether the tokens changed; if they did, re-stage the config and put it into
the worker with the flip script. Adding a slash
command needs no reinstall, but the worker must handle it first (`pigeon-4ogz.4`).

## Limits worth knowing

- Free plan: 90 days of visible history, 10 integrations per workspace (pigeon uses 1; devbox's
  em-alerts app is a second).
- Bots cannot delete channels, and a bot token cannot unarchive one (hence the user token).
- App slash commands do not work in threads.

## Results

Filled in by `pigeon-4ogz.7`.

| Machine | Team id | App id | Domain | Owner id | Mobile follows desktop | Real-mute test |
|---|---|---|---|---|---|---|
| devbox | `T0CLL1EQAM6` | `A0CKTHXA7Q9` | `pigeon-devbox` | `U0CKTGLSULR` | desktop pref off; phone unchecked | fail |
| cloudbox | `T0CLL4Y8HL0` | `A0CKRJH4FPU` | `pigeon-cloudbox` | `U0CKLESTD45` | desktop pref off; phone unchecked | fail (same scopes, not re-run) |
| macbook | `T0CKTMDR0AV` | `A0CKTN5CD8R` | `pigeon-macbook` | `U0CKKHX34MR` | desktop pref off; phone unchecked | fail (same scopes, not re-run) |

Done 2026-11-20 by `pigeon-4ogz.7`. Bot users: devbox `U0CKPNC3TKQ`, cloudbox `U0CKVFC4MEG`,
macbook `U0CKLGY0F37`. Webhook channel: `#alerts` in each. `#em-alerts` (devbox) is `C0CKPMQ81AA`.
Configs are staged in workstation `secrets/devbox.yaml` (workstation #880), and devbox's webhook
as `pigeon_slack_alarm_webhook`. The cloudbox and macbook webhooks are **not** staged: devbox cannot
write `secrets/cloudbox.yaml` (it is encrypted only to cloudbox's key). `.10`/`.11` read them off
that app's *Incoming Webhooks* page with the stage-field recipe.

What setup actually looked like, differing from the steps above:

- **Headless Chromium hits a reCAPTCHA** after the email on `get-started#/createnew`. It was
  done in Jonathan's browser on 9222, where he ticked the captcha once. After that first
  workspace, `https://slack.com/get-started#/landing` (already signed in) offers *Create a new
  workspace* with no email, code or captcha.
- That browser is also signed into his **work** workspace. *Create New App → Paste a manifest*
  lists every signed-in workspace; pick `pigeon <m>` and check it before *Next*. The manifest
  editor is CodeMirror 5: `cm.setValue()` is reset by React, so type the minified JSON in with
  `Input.insertText`. *Next → Create and Install* goes straight to the consent page.
- Slack assigned `pigeon<m>` URLs (no dash); renamed at `https://<old>.slack.com/admin/name`.
- **New workspaces pause notifications outside weekdays 9:00–17:00** (*Preferences →
  Availability*). That would silence `#alerts` at night, so it was set to *Every day*, 12:00 AM
  to *Midnight* (the last end option, below the visible list). Step 6 needs this added.
- `#alerts` and `#em-alerts` were first set to *All new posts*, then set back to *Just mentions*
  the same day (`pigeon-4ogz.18`, no pushes to start).
- Notification pref is *Mentions and direct messages* (which also counts `@channel`/`@here`, so
  pigeon must never use those). *Thread replies* was left on (Slack's default), so a bot reply in a
  thread Jonathan follows still pushes.
- Real-mute test: `users.prefs.get` → `missing_scope`, `needed: read`; `users.prefs.set` (both
  argument forms) → `missing_scope`, `needed: post`, `provided: identify,channels:write`. These
  are legacy scopes a granular app cannot request, so the app user token can never mute.
  **Fail.** The worker does not mute (`pigeon-4ogz.3`); mentions alone meet D7.
- The onboarding creates `#all-pigeon-<m>` (the default channel, which can't be archived),
  `#new-channel` and `#social`. The last two were archived.
