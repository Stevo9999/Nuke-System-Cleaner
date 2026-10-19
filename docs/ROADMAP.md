# Roadmap (ideas, not promises)

Done: standard-mode scans, installed programs and Windows apps (uninstall + leftovers), browsers cleaner, start-up programs list, Windows tools shortcuts, never-touch folders, plain confirm option, installers.

Ideas, roughly in order:
- **Registry cleaner (separate project).** Per investigated program, provable orphans only, a .reg backup first, and the restore-point prompt before any registry item is deleted. Guarded by an allow-list plus the never-touch registry list in `lib/never-touch.mjs`.
- Start-up programs: turn entries on and off.
- Junk-file patterns with a recent-use cutoff and include/exclude lists.
- Office-traces, Windows-components and privacy-traces cleaners.
- Secure file wipe.
- A "point at a window to pick its program" helper.
- An in-window folder browser to replace the native pickers.
- Code signing for the installers.
