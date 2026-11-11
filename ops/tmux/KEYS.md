# HQ workspace keys (all Alt, no prefix)

Terminals
  Alt-n          new terminal (hq)
  Alt-t          new terminal on a rig (prompts; blank = hq)
  Alt-x          kill focused terminal (confirms; it disappears, grid re-tiles)
  Alt-h          minimize: park focused terminal into the hidden 'parked' window
  Alt-o          reopen a parked terminal (picker menu)

Focus and layout
  Alt-arrows     move focus between terminals
  Alt-Shift-hjkl resize focused terminal (hold to repeat)
  Alt-z          fullscreen toggle for focused terminal
  Alt-f          re-tile (1 full / 2 side-by-side / 3 two+wide / 4+ grid)
  Alt-Space      cycle tmux layouts
  Alt-m          mouse mode toggle (click to focus, drag borders)

Windows and sessions
  Alt-,  Alt-.   previous / next window (monitor, sync, work, console live here)
  Alt-s          window and session chooser (arrows + Enter, q to cancel)
  Alt-g          floating scratch terminal (persists; Ctrl-b d closes the popup,
                 Alt-g brings it back with everything still running)
  Alt-/          this help (q to close)

Notes
  Finished worker terminals auto-park; Alt-o lists them marked (done) until
  finish.sh tears them down. Minimized terminals keep running while parked.
