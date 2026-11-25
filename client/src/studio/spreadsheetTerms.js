// Reads a term list from an uploaded spreadsheet: column A the term, column B
// an optional sentence. XLSX is parsed in the browser (the library loads only
// when someone uploads one); CSV and plain text need no library.
import { parseCsv, parseTermList, rowsToEntries } from './specialtyTerms.js';

export const TERM_FILE_ACCEPT = '.xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain';
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export async function readTermsFile(file) {
  const name = String(file?.name || '').toLowerCase();
  if (!file || file.size > MAX_FILE_BYTES) throw new Error('That file is too big — keep it under 5 MB.');
  if (name.endsWith('.xlsx')) {
    const { readSheet } = await import('read-excel-file/browser');
    return rowsToEntries(await readSheet(file));
  }
  if (name.endsWith('.csv')) return rowsToEntries(parseCsv(await file.text()));
  if (name.endsWith('.txt')) return parseTermList(await file.text()).map((term) => ({ term, sentence: '' }));
  if (name.endsWith('.xls')) throw new Error('Old .xls files cannot be read — in Excel, use Save As › Excel Workbook (.xlsx).');
  throw new Error('Use an Excel (.xlsx), CSV or text file.');
}

/** A small CSV the lecturer can fill in and upload. */
export function termTemplateUrl() {
  const csv = 'Term,Your own sentence (optional)\nhaematochezia,"Bright red blood per rectum, or haematochezia, usually points to a lower GI source."\nmelaena,\n';
  return URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
}
