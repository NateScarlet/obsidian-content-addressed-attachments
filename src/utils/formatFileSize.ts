// https://stackoverflow.com/a/14919494
export default function formatFileSize(
  bytes: number,
  si = false,
  dp = 1
): string {
  let b = bytes;
  const thresh = si ? 1000 : 1024;

  if (Math.abs(b) < thresh) {
    return `${b} B`;
  }

  const units = si
    ? ['kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
    : ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
  let u = -1;
  const r = 10 ** dp;

  do {
    b /= thresh;
    u += 1;
  } while (Math.round(Math.abs(b) * r) / r >= thresh && u < units.length - 1);

  return `${b.toFixed(dp)} ${units[u]}`;
}
