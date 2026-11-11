# Contributing

This repo is generated. Every file except this one, `README.md` and `LICENSE` is
exported from a private working HQ by `ops/scripts/hq-public-export.sh`, and the next
export replaces the tree. A pull request that edits an exported file cannot be merged
here as is: the change is made in the source HQ and arrives with the next export.

Useful contributions:

- Issues that describe a step of the README that fails on a fresh box: the command,
  the output, the Ubuntu version.
- Pull requests to `README.md`, `CONTRIBUTING.md` or `LICENSE`.
- Pull requests to any other file are welcome as proposals; they are applied by hand
  in the source and credited in the commit.

Do not put client data, personal data or secrets in an issue or a pull request. Each
export runs a leak gate that refuses such content; a contribution that trips it is
dropped.
