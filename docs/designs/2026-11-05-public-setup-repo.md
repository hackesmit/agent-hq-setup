# Public setup repo: the export pipeline

Bead hq-an7jw.1 (epic hq-an7jw). The repo itself is hq-an7jw.2; the red-team pass is hq-an7jw.3.

## Goal

A tree a stranger can read and run to stand up their own HQ, built from the live hq repo
with no client name, person name, internal id, secret, tailnet name, email, phone,
address, price or client data file in it.

## Constraints

- hq mixes machinery (constitution, ops/, .claude/, design docs, units) with client
  material (bunkers/, rigs/, state/, ops/reference/, outbox/, metrics, proposals).
- The export is read-only on hq, makes no network call and commits nothing.
- It fails closed: anything not proven clean stays out or stops the run.

## Design

`ops/scripts/hq-public-export.sh (--out DIR | --check)` runs three passes.

1. Select. Only git-tracked files are candidates (untracked secrets and gitignored state
   never qualify). `ops/config/public-export.allow` lists path prefixes, exact paths and
   globs; `!` lines exclude; the last matching line wins; everything else stays out.
   Binary files are skipped and logged. The denylist is never exported.
2. Scrub. `ops/config/public-export.deny` maps each term to a neutral placeholder
   (`term<TAB>replacement[<TAB>flags]`, `c` case-sensitive, `w` whole word, longest term
   first). The scrub runs over file names as well as contents, so a reference still
   points at its renamed file. A markdown table headed `| Rig |` becomes an example table.
3. Gate. The staged tree is searched for every denylist term (case-insensitive) and for
   generic leak shapes: email, phone, tailnet name, public IPv4, 32-hex key, vendor API
   key prefixes, JWT, private key block, generated-looking secret assignment, Supabase
   project ref, Mexican RFC. Any hit exits 2 with `file:line`. A file name that still
   carries a term or shape, a symlink leaving the root, or an allowlisted `.env` file is
   refused the same way. `ok <regex>` lines in the allowlist whitelist known placeholder
   and vendor values (example.com, test fixtures); never a client term.
   Round 2 shapes (hq-an7jw.4), one line each:
   - phone: Mexican 3-3-2-2 grouping with space, dash or dot, and a bare 10-digit run
     starting 2-9 (no longer run, no timestamp); code constants go on the ok list.
   - secret-assign: any-case name holding secret, token, password, pwd, api key, auth
     key, access key or private key, as `name=v`, `name: v`, `"name": "v"` or
     `--name v`; value 12+ token chars with a digit or 24+ without; a bare `key` needs
     16+ mixed-case chars with a digit; dotted code references never count.
   - api-key: adds `tskey-`, `re_` (mixed case with a digit) and `Bearer <20+ chars>`.
   - symlink target: gated exactly like a file name; a link whose target is not
     itself exported is refused (exit 2).
   - whole-word terms (`w`) also match a plural without an apostrophe (`s`, `es`);
     the scrub keeps the suffix.
   - the run log holds the real term map, so it is written 600 (no symlink follow);
     a log that cannot be written 600 exits 1 before any work.
   Round 3 rules (hq-an7jw.5, lucy round 2), one line each:
   - run log: a `--log` path inside `--out` or inside the root exits 1 before any work.
   - phone edges: a match may touch sentence punctuation, `tel:`, a colon, a slash or a
     file extension; a word character or a digit-separator-digit neighbor still blocks it.
   - secret-assign: a quoted value counts whatever it holds; only an unquoted dotted
     reference (`cfg.n8nToken`) is exempt.
   - secret-assign runs over the whole file text, so a value on the line after its key
     (JSON, YAML) is caught; the hit names the key's line.
   - symlink target: checked after staging, it must resolve to a staged file or
     directory (a link to a skipped binary or a renamed or private path is refused).

The tree is staged in a temp dir and moved to `--out` only after a clean gate, so a
refused run leaves nothing. The run log (term map with counts, renames, skips, hits)
goes outside the output; the map never enters the tree.

Exit codes: 0 clean, 1 usage or config error (missing allowlist or denylist, replacement
that contains a term, non-empty `--out`), 2 leak or refusal, 3 nothing selected.

## Limits

- The gate catches what the denylist and the shapes know. A new client or person name
  must be added to the denylist; the red-team bead (hq-an7jw.3) reads the output by hand.
- Binary files (sound cues, fonts, dump fixtures) are not exported; a scan cannot read
  an image or audio file for names.
- Personal project names (public repos) and the box host names are kept on purpose.
- Homoglyph, zero-width and percent-encoded forms of a term pass the gate (synthetic
  only so far); the red team reads for them by hand.

## Round 4 rules

- `--out` is resolved in full, last component included, before the emptiness, root and log tests; a missing parent exits 1.
- A Mexican number is one shape: `+52`, `0052` or `52` prefix, optional mobile `1`, area code bare or in parens, 3-3-2-2 or 3-7.
- A secret key with nothing, a comment or a block indicator after its colon takes the next content line (a `- ` item included) as its value; a value it cannot read exits 2.
- A quoted or backtick value after a secret key is gated on its whole content, `/` included, with no path or reference exemption.
- A `\t`, `\n` or `\r` escape right before a whole-word term is a word boundary, in the scrub and the gate.

## Push and gate rules (hq-an7jw.8)

- `--gate` refuses (exit 2) any file it cannot read as text: binary, not UTF-8, unreadable, or not a regular file or symlink.
- Config is read from HEAD only (hq-an7jw.16). `--allow`, `--deny` and `--public` are paths relative to the root, checked as strings (no leading slash, no empty, `.` or `..` component; else exit 1), and every mode reads them from the committed tree of the root's HEAD: the two lists as blobs, the public dir as a tree. Nothing maps a filesystem path into the root and nothing reads the working tree at those paths, so a symlink, skip-worktree file or case alias cannot change the export; a config change counts only once committed. `--push` takes from the committed `--public` dir only README.md and LICENSE (required) and CONTRIBUTING.md (optional), each a committed regular file; any other entry, or a dir missing from HEAD, is a refusal.
- Every mode but `--gate` exports the HEAD snapshot (hq-an7jw.17). `--out`, `--check` and `--push` write the committed tree of HEAD from the object store into a temp dir and select, scrub and gate that, never the working tree: an uncommitted edit, even to an exported file such as the allowlist, changes no byte of the output. So `--out` and `--check` refuse a plain-dir root (no repository, no HEAD) and ignore untracked files, under `ops/public` included. Only `--gate DIR` reads a working tree. Inside the shared core every step checks its own status (listing, staging dir, output dir, copy), because `--push` runs core where bash ignores errexit: a failed `find`, `mkdir` or `cp` exits non-zero with nothing published, and a failed copy into `--out` removes what it wrote.
- `--push` refuses a checkout with an untracked or ignored file, or with a commit its origin branch lacks (no origin branch: no commit at all).
- The export commit carries one public identity held in the script (an `HQ_PUBLIC_NAME`/`HQ_PUBLIC_EMAIL` override is gated with the message) and UTC dates, never the ambient git identity.
- Any failure after the swap, a failed push included (exit 4), resets the checkout to its starting commit.
- `ok@<path> <regex>` holds in that one file only; the CUDA wheel pins use it.

## Push and gate rules (hq-an7jw.9)

- `--gate` refuses (exit 2) a listed path that is missing, and the denylist file itself when the gated tree holds it; outside git it lists every entry but a dir, so a FIFO is refused.
- `--push` takes a flock on the checkout before its first check; a second run on the same checkout exits 1 and changes nothing.
- `--push` refuses an assume-unchanged or skip-worktree entry (git status cannot see an edit behind it) and a detached HEAD.
- `--push` reads origin's branch tip from the one push url in this run (no tracking ref); the checkout HEAD must equal it (no origin branch: no commit). More than one push url, or no answer, is a refusal.
- The push sends one ref, `<commit>:refs/heads/<branch>`, to that url with `--force-with-lease=<branch>:<start tip>` (a compare-and-swap; the commit's parent is the start tip, so it only fast-forwards), no tags, no hooks, no signing, whatever the config says. No change: no push.
- After a failed or interrupted push origin is asked: branch holds the commit means pushed (kept, exit 0); start tip or a history without it means rolled back (exit 4); no answer or no branch means unknown (kept, exit 5, never "nothing pushed").
- `--push` (hq-an7jw.10) reads every git answer a check uses with its exit status: a git that fails is a refusal (exit 1) before any file changes, never an empty "clean" answer.
- `--push` refuses a checkout with an operation in progress (merge, cherry-pick, revert, rebase, bisect, sequencer) and one whose index holds a gitlink (the swap would delete a submodule's ignored files).
- The tree `git add` builds is verified before the commit: each path, mode and blob hash equals the checkout file the gate read (hashed raw, no git filter), so a clean filter, attribute, autocrlf or encoding config is a refusal (exit 2), never ungated bytes on origin.
- The commit is built with `git commit-tree` from that tree with the start commit as its one parent (none when unborn), then verified: the object must be exactly tree, parent, public identity and message, else exit 2 and nothing pushed.
- INT, TERM and HUP run the same restore as any failure; the HEAD lookups of `--allow`, `--deny` and `--public` use literal pathspecs; the swapped tree is added with `--force`, so an exported `.gitignore` hides nothing.

## Push from a temp repo (hq-an7jw.11)

`--push CHECKOUT` no longer writes any checkout. It reads the one origin push url from CHECKOUT, fetches origin `main` into a new temp repo (none: an unborn branch), exports and gates the whole tree there, checks that git's tree id equals one computed from the gated bytes with no git involved, commits with `commit-tree`, and pushes with a lease on the fetched tip. Origin is then read: the new commit means pushed (0), the start tip means absent (4), anything else or no answer means unknown (5, the temp repo kept and named). Any failure or signal before the push only deletes the temp dir. Why: every review round from hq-an7jw.8 to .10 found another way the swap and its restore could lose a local file (lucy r4: a clean filter hides bytes git cannot restore), so the part was removed instead of hardened. This replaces the checkout rules above (flock, checkout refusals, restore on failure); pull the checkout after a push.

## Upkeep

Add each new client, person, project ref or address to the denylist when it first
appears in machinery. Run `ops/tests/hq-public-export.test.sh` after any change to the
script, and `hq-public-export.sh --check` before each publish.
