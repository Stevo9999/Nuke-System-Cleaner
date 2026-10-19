// lib/age.mjs: "changed after the scan started" test shared by the delete path and the app's pre-start re-check.
// The newer of mtime and birthtime counts. File times can run a little ahead of Date.now() (measured about 1 ms on NTFS; FAT keeps
// 2 s steps; not a target here), so "after the scan" means later than the scan start plus this tolerance. The same value bounds how far
// in the future a scan start time may lie (server.mjs).
export const AGE_SKEW_MS = 250;
export const newerMs = st => Math.max(st.mtimeMs, st.birthtimeMs);
export const changedAfter = (st, ms) => newerMs(st) > ms + AGE_SKEW_MS;
