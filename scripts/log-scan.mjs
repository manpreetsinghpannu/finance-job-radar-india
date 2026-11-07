#!/usr/bin/env node
/**
 * log-scan.mjs: append one line to data/scan-log.jsonl saying when a scan ran,
 * what kind it was, how many boards it read and which roles were new.
 *
 * Usage: node scripts/log-scan.mjs <scan receipt JSON> <kind>
 *   kind: hourly | manual | starting | new-firms
 */
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';

const [receiptPath, kind = 'hourly'] = process.argv.slice(2);
let r = {};
try {
  r = JSON.parse(readFileSync(receiptPath, 'utf8').trim().split('\n').filter((l) => l.startsWith('{')).pop() || '{}');
} catch { /* scan failed before writing a receipt */ }

mkdirSync('data', { recursive: true });
const entry = {
  at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  kind,
  boards: r.scanned ?? null,
  boards_failed: Array.isArray(r.errors) ? r.errors.length : null,
  postings_seen: r.found ?? null,
  new_urls: Array.isArray(r.added_urls) ? r.added_urls : [],
};
if (!existsSync('data/scan-log.jsonl')) entry.note = 'log started';
appendFileSync('data/scan-log.jsonl', `${JSON.stringify(entry)}\n`);
console.log(`log-scan: ${kind}, ${entry.new_urls.length} new roles`);
