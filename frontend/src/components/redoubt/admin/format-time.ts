// Every admin card reads raw unix-second timestamps and second-counts
// straight off chain (epoch deadlines, oracle staleness, decryptionTimeout
// eligibility). A bare number like "unix 1735689600" or "3600s" means
// nothing at a glance -- this file is the one place that turns those into
// browser-local, human-readable text, so no card hand-rolls its own
// formatting (or its own timezone bug).

function toSeconds(value: bigint | number): number {
  return typeof value === "bigint" ? Number(value) : value;
}

// Absolute, browser-local time (never forced to UTC) for an on-chain unix
// timestamp -- the standard `new Date(seconds * 1000).toLocaleString()`
// idiom, centralized so every card renders deadlines the same way.
export function formatAbsolute(unixSeconds: bigint | number): string {
  return new Date(toSeconds(unixSeconds) * 1000).toLocaleString();
}

// A duration in seconds -> "3m 49s" / "1h 5m" / "2d 3h" -- coarsest two
// units, never a bare second count. Used for both "how long has this been
// pending" (oracle age) and "how long is this tolerance" (maxOracleStaleness,
// decryptionTimeout) style values.
export function formatDuration(totalSeconds: bigint | number): string {
  let seconds = Math.abs(Math.round(toSeconds(totalSeconds)));
  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds -= hours * 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

// "in 3m 49s" / "3m 49s ago" / "now" -- a target unix timestamp relative to
// a live "now" (see use-now-seconds.ts). Deliberately takes `nowUnixSeconds`
// as a parameter rather than calling Date.now() itself, so callers stay
// clear of the react-hooks/purity trap this project already hit once
// (session 23).
export function formatRelative(targetUnixSeconds: bigint, nowUnixSeconds: bigint): string {
  const diff = targetUnixSeconds - nowUnixSeconds;
  if (diff === BigInt(0)) return "now";
  return diff > BigInt(0) ? `in ${formatDuration(diff)}` : `${formatDuration(-diff)} ago`;
}

// The standard rendering for any on-chain deadline in the admin UI: absolute
// local time plus a relative form alongside it, never a bare "unix
// 1735689600" and never the relative form alone (absolute is what you'd
// actually cross-check against a wallet clock or Etherscan).
export function formatDeadline(targetUnixSeconds: bigint, nowUnixSeconds: bigint | undefined): string {
  const absolute = formatAbsolute(targetUnixSeconds);
  if (nowUnixSeconds === undefined) return absolute;
  return `${absolute} (${formatRelative(targetUnixSeconds, nowUnixSeconds)})`;
}
