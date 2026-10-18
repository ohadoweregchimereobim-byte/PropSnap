/**
 * Save a CSV string as a file download. Used by the popup and the dashboard.
 */
export function downloadCsv(csv: string): void {
  // The byte order mark tells Excel the file is UTF-8, so letters like "ŵ" survive
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `propsnap-export-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
