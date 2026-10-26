/** Incremental discovery metadata, not a copy of the transcript. mtime is only a hint:
 * Windows writers can append to an open file without advancing its last-write time. */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readLocal, writeLocal } from '../util/localJson.ts';
import { mentionsAnyRoot } from './pathMatch.ts';
import type { DiscoverQuery } from './types.ts';

type Entry = {
  size: number;
  ctime: number;
  edge: string;
  anchor: string;
  fileId: string;
  recent: number;
  match: boolean;
  tail: string;
};
type Index = { v: 1; entries: Record<string, Entry> };
const memory = new Map<string, Index>();

export function discoveryIndex(query: DiscoverQuery, agent = 'codex') {
  const key = createHash('sha256')
    .update(JSON.stringify([agent, query.roots, query.needles, query.all]))
    .digest('hex');
  const path = query.cacheDir ? join(query.cacheDir, `${agent}-${key}.json`) : undefined;
  const index = (path ? readLocal<Index>(path) : memory.get(key)) ?? {
    v: 1,
    entries: {},
  };
  let changed = false;
  const seen = new Set<string>();
  return {
    inspect(file: string): { recent: number; match: boolean } | undefined {
      seen.add(file);
      let fd: number | undefined;
      try {
        const stat = statSync(file);
        fd = openSync(file, 'r');
        const edge = Buffer.alloc(Math.min(512, stat.size));
        readSync(fd, edge, 0, edge.length, 0);
        const signature = createHash('sha256').update(edge).digest('hex');
        const tailHash = (size: number) => {
          const bytes = Buffer.alloc(Math.min(512, size));
          readSync(fd!, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
          return createHash('sha256').update(bytes).digest('hex');
        };
        const anchor = tailHash(stat.size);
        const fileId = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
        const previous = index.entries[file];
        // A larger file with the same prefix is an append, including unchanged mtime.
        const append =
          previous &&
          stat.size > previous.size &&
          previous.edge === signature &&
          previous.fileId === fileId &&
          previous.anchor === tailHash(previous.size);
        if (
          previous &&
          stat.size === previous.size &&
          stat.ctimeMs === previous.ctime &&
          previous.edge === signature &&
          previous.anchor === anchor &&
          previous.fileId === fileId
        )
          return previous;
        // Re-read a small overlap: the previous process may have stopped mid-token.
        let offset = append ? Math.max(0, previous.size - 8192) : 0;
        let tail = append ? previous.tail : '';
        let recent = append ? previous.recent : 0;
        let match = append ? previous.match : !!query.all;
        const decoder = new StringDecoder('utf8');
        const buffer = Buffer.alloc(64 * 1024);
        const inspectText = (part: string) => {
          const text = tail + part;
          if (!match)
            match =
              mentionsAnyRoot(text, query.roots) ||
              (query.needles ?? []).some((n) =>
                text.toLowerCase().includes(n.toLowerCase()),
              );
          for (const hit of text.matchAll(
            /"(?:timestamp|ts|created_at|updated_at|createTime)"\s*:\s*"([^"\n]+)"/g,
          )) {
            const time = Date.parse(hit[1]!);
            if (Number.isFinite(time)) recent = Math.max(recent, time);
          }
          // Only discovery tokens crossing a chunk boundary are needed next time.
          tail = text.slice(-8192);
        };
        while (offset < stat.size) {
          const size = readSync(
            fd,
            buffer,
            0,
            Math.min(buffer.length, stat.size - offset),
            offset,
          );
          if (!size) break;
          offset += size;
          inspectText(decoder.write(buffer.subarray(0, size)));
        }
        inspectText(decoder.end());
        const entry = {
          size: offset,
          ctime: stat.ctimeMs,
          edge: signature,
          anchor,
          fileId,
          recent,
          match,
          tail,
        };
        index.entries[file] = entry;
        changed = true;
        return entry;
      } catch {
        return undefined;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    },
    save() {
      if (!changed) return;
      for (const file of Object.keys(index.entries))
        if (!seen.has(file)) delete index.entries[file];
      // Tail is raw transcript data: keep it only in memory, never on disk.
      memory.set(key, index);
      if (path) {
        try {
          writeLocal(path, {
            v: 1,
            entries: Object.fromEntries(
              Object.entries(index.entries).map(([p, e]) => [p, { ...e, tail: '' }]),
            ),
          });
        } catch {
          /* cache is optional */
        }
      }
      if (memory.size > 8) memory.delete(memory.keys().next().value!);
    },
  };
}
