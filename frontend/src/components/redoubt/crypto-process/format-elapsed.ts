// Case-file timestamp framing ("T+00:14") shared by both timed sub-phases
// (encryptedInput, userDecrypt) -- never used for the indeterminate
// human-signature wait, which has no fixed duration to count up against.
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `T+${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
