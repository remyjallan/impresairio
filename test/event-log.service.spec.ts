import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HomeDirectoryResolver } from '../src/config/home-directory.resolver';
import { EventLogService } from '../src/runs/event-log.service';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('EventLogService', () => {
  it('keeps the valid prefix when the final JSONL record was truncated', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-events-')));
    directories.push(home);
    const runDirectory = join(home, 'runs', 'run-events');
    const path = join(runDirectory, 'events.jsonl');
    const first = { type: 'run.started', at: '2026-07-22T10:00:00.000Z' };
    mkdirSync(runDirectory, { recursive: true });
    appendFileSync(path, `${JSON.stringify(first)}\n{"type":"step.completed","at":"2026-07-22T10:01`, 'utf8');

    const events = new EventLogService(new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home })).read('run-events');

    expect(events).toEqual([first]);
  });

  it('rejects corruption in a complete event record instead of hiding it', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'impresairio-events-')));
    directories.push(home);
    const runDirectory = join(home, 'runs', 'run-events');
    const path = join(runDirectory, 'events.jsonl');
    mkdirSync(runDirectory, { recursive: true });
    appendFileSync(path, '{"type":"run.started"}\n{"type":"not-json"oops}\n', 'utf8');

    expect(() => new EventLogService(new HomeDirectoryResolver({ IMPRESAIRIO_HOME: home })).read('run-events'))
      .toThrow('Invalid event log for run run-events at line 2');
  });
});
