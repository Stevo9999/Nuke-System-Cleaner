# Originality policy

Nuke - System Cleaner is its own program, built from scratch for this project. This page says how we keep it that way and how a reader can check.

## What "not copying" means here
- **Code:** every line outside `vendor/` and `node_modules/` was written for this project. Third-party code is used only under an open license and is listed with its license on the in-app Credits page. We do not use code from products whose terms forbid copying (for example a project that only allows personal use is credited as an idea source, nothing more).
- **Words, labels, icons, layout:** all screen text, button names and descriptions are our own wording. No icon, picture, sound or font comes from another cleaner. The sounds are CC0; the 3D scene is built with three.js; the app icon (`build/icon.svg`, rendered to `build/icon.png`) is our own drawing: a monitor with a mushroom cloud on its screen. It is not copied from or traced over any other icon, and it uses no trademarked shapes.
- **Names:** we do not use another product's name or its feature names (`test/originality.test.mjs` fails the build if one appears in any tracked file).
- **Ideas:** a program that lists installed software, runs its uninstaller and looks for leftovers is a normal kind of tool, and ideas and functions are free to use. What we must not do is copy the way someone else expressed them: their code, text, art or look.

## What makes this design different
1. **The key ritual:** nothing is deleted without a warning, a restore-point step (optional), then a locked 3D confirmation: key, glass lid, red button, a 60-second expiry with a visible countdown. A plain two-step confirm is available as a setting.
2. **One narrow delete funnel:** every deletion goes through the same re-validated path with an audit line written first. Windows system areas are unreachable by design (fixed junk locations only, a hard never-touch list in `lib/never-touch.mjs`, user exclusions).
3. **Proof, not guessing:** leftovers are offered only when they can be tied to the program you picked; the rest is shown but never ticked.
4. **No registry writing in this version.** The registry cleaner is a separate later project with its own allow-list and backup.
5. **Plain-language screens:** every button has a one-line description beside it; results use words like "Only used by this" instead of jargon.
6. **Runs as a normal user** (administrator mode is optional and limited to four Windows folders).

## Rules for anyone changing this project
- Write your own labels and descriptions; do not paste from another product, its website or its help pages.
- Before using any outside code, font, picture or sound: check its license, add it to `app/renderer/credits.js` with the license and a link, and keep the license text available.
- Reference material (articles, other projects) goes on the Credits page as "reference", with what it was used for. If its terms are not open, do not copy anything from it.
- Never add a competitor's name, logo or feature trademark. Use plain descriptive names.
- Run `node --test --test-concurrency=1` before shipping; the originality test is part of it.

This is an engineering policy, not legal advice.
