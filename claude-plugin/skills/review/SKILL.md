---
name: review
description: Open this repository's yojana plans as live review pages in the browser, where the person can read, comment, edit, suggest, accept changes and decide on beads.
argument-hint: "[--check]"
disable-model-invocation: true
---

# Review plans in the browser

1. If `.yojana/log.jsonl` does not exist, there is nothing to review: say so, and offer to start
   a plan (`/yojana:plan`) or import one (`yojana import`).
2. Run `yojana ingest` first, so the page shows the plan files as they are now.
3. Start the server in the background, with claim checks when the person asked for them
   ($ARGUMENTS):

   ```sh
   yojana review --serve $ARGUMENTS
   ```

   It prints one URL per plan. Give the person those URLs, using `localhost` in place of
   `127.0.0.1` if their browser needs it. The server listens on this machine only, and every
   write needs the token the page carries.
4. What the person does on the page is recorded as them, not as you. Their edits rewrite the
   plan files, accepted changes move to `changes/archive/`, and a decision on a bead is finalized
   and applied through bd at once.
5. Leave the server running until the person is done; stop it when they say so.
