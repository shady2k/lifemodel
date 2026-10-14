import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoaderApp, type LoaderApp } from '../../loader/src/app.js';
import { loadConfig } from '../../loader/src/config.js';
import { systemClock } from '../../loader/src/clock.js';
import { createNodeFileSystem } from '../../loader/src/fs.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
function appFor(options: { root?: string; runInitial?: () => Promise<void>; unseal?: () => Promise<void>; lines?: RecordedLine[] } = {}): LoaderApp {
  const root = options.root ?? mkdtempSync(join(tmpdir(),'platform-loader-'));
  if (!options.root) roots.push(root);
  const lines = options.lines ?? [];
  return createLoaderApp({
    config: { ...loadConfig({LIFEMODEL_VOLUME_ROOT:root,LIFEMODEL_HTTP_PORT:'0'}), loaderDir:root },
    fs: createNodeFileSystem(),
    runner: { run: async () => ({code:0,stdout:'',stderr:''}) },
    logger: createRecordingLogger(lines),
    clock: systemClock,
    exit: () => {},
    platformBootstrap: { runInitial: options.runInitial ?? (async()=>{}), unsealIfSealed: options.unseal ?? (async()=>{}) },
  });
}

describe('the platform loader', () => {
  it('sets up authentication and preserves it across a restart', async () => {
    const root=mkdtempSync(join(tmpdir(),'platform-loader-')); roots.push(root);
    const first=appFor({root}); await first.start();
    const port=first.port();
    const setup=await fetch(`http://127.0.0.1:${port}/setup`,{method:'POST',headers:{origin:`http://127.0.0.1:${port}`,host:`127.0.0.1:${port}`,'content-type':'application/x-www-form-urlencoded'},body:'password=secret',redirect:'manual'});
    expect(setup.status).toBe(303);
    const cookie=setup.headers.get('set-cookie')?.split(';')[0] ?? '';
    const home=await fetch(`http://127.0.0.1:${port}/`,{headers:{host:'boot.localhost',cookie}});
    expect(home.status).toBe(200); expect(await home.text()).toContain('Platform mode');
    expect(await first.shutdown('test')).toBe(0);
    const second=appFor({root}); await second.start();
    const login=await fetch(`http://127.0.0.1:${second.port()}/login`,{method:'POST',headers:{origin:`http://127.0.0.1:${second.port()}`,host:`127.0.0.1:${second.port()}`,'content-type':'application/x-www-form-urlencoded'},body:'password=secret',redirect:'manual'});
    expect(login.status).toBe(303);
    expect(await second.shutdown('test')).toBe(0);
  });

  it('does not expose instance controls or a CLI API', async () => {
    const app=appFor(); await app.start();
    for (const path of ['/panic','/resume','/_api/status','/_api/panic','/_api/resume']) {
      const response=await fetch(`http://127.0.0.1:${app.port()}${path}`,{headers:{host:'boot.localhost'}});
      expect(response.status,path).toBe(404);
    }
    expect(await app.shutdown('test')).toBe(0);
  });

  it('starts platform bootstrap after the HTTP interface is listening', async () => {
    let app!: LoaderApp; const observed:string[]=[];
    app=appFor({runInitial:async()=>{observed.push(`bootstrap:${app.host()}`)},unseal:async()=>{observed.push(`unseal:${app.host()}`)}});
    await app.start();
    for (let i=0;i<20 && observed.length<2;i++) await new Promise(resolve=>setImmediate(resolve));
    expect(observed).toEqual(['bootstrap:0.0.0.0','unseal:0.0.0.0']);
    expect(await app.shutdown('test')).toBe(0);
  });

  it('logs the failed platform phase before retrying', async () => {
    const lines:RecordedLine[]=[]; const app=appFor({lines,runInitial:async()=>{throw new Error('bootstrap broke')}});
    await app.start();
    for (let i=0;i<20 && !lines.some(line=>line.level==='error');i++) await new Promise(resolve=>setImmediate(resolve));
    expect(lines.find(line=>line.level==='error')?.message).toContain('platform bootstrap failed');
    expect(await app.shutdown('test')).toBe(0);
  });
});
