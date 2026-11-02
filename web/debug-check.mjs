// Copyright (c) 2026 机械小鸽; SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'commaplay-debug-'));
const socketPath = join(directory, 'bluetooth.sock');
const calls = [];
const phone = 'AA:BB:CC:DD:EE:01';
let owner = null;
const state = {available:true, safety:{allowed:true,fresh:true}, selectedPhone:null, busy:false, radioState:'ready',
  adapters:[{powered:true,discovering:false}], scanning:false, pair:{state:'idle'}, prompt:null,
  devices:[{address:phone,name:'Fixture iPhone',paired:false,connected:false,trusted:false},
    {address:'AA:BB:CC:DD:EE:02',name:'<img src=x onerror="window.untrustedNameRan=true">',paired:false,connected:false,trusted:false}]};
const broker = createServer(socket => {
  let input = '';
  socket.on('data', bytes => {
    input += bytes;
    if (!input.includes('\n')) return;
    const command = JSON.parse(input.split('\n')[0]); calls.push(command);
    let result = {ok:true};
    if (command.operation === 'status') result.data = {...state, owned:owner === command.client};
    else if (command.operation === 'cancel') {state.scanning=false; state.prompt=null; owner=null;}
    else if (!state.safety.allowed) result = {ok:false,error:'fresh_stationary_disengaged_state_required',status:409};
    else {
      owner = command.client;
      if (command.operation === 'scan') state.scanning=true;
      if (command.operation === 'pair') {
        state.scanning=false; state.pair={state:'pairing',address:phone};
        state.prompt={id:'fixture-prompt',kind:'RequestConfirmation',address:phone,value:'000123',remainingSeconds:60};
      }
      if (command.operation === 'answer') {
        assert.equal(command.promptId,'fixture-prompt'); assert.equal(command.value,true);
        state.prompt=null; state.pair={state:'paired',address:phone}; state.devices[0].paired=true; state.devices[0].trusted=true;
      }
      if (command.operation === 'select') {assert.equal(command.address,phone); state.selectedPhone=phone;}
    }
    socket.end(JSON.stringify(result) + '\n');
  });
});
await new Promise(resolve => broker.listen(socketPath, resolve));
const portProbe = createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const token = 'browser-test-only';
const noAuth = process.env.TEST_NO_AUTH === '1';
let output = '';
const server = spawn(join(root,'server/build/install/server/bin/server'), [
  '--http','--http-port',String(port),'--bind','127.0.0.1','--state-dir',join(directory,'state'),
  '--identity-dir',join(directory,'no-mfi'),'--diagnostics','--demo-video',join(root,'testdata/demo.h264'),
  '--token',token,'--bluetooth-socket',socketPath,...(noAuth ? ['--no-browser-auth'] : [])], {
  cwd:root, env:{...process.env,JAVA_HOME:process.env.JAVA_HOME || join(root,'.runtime/jdk'),
    JAVA_OPTS:'-Xms32m -Xmx256m -XX:ActiveProcessorCount=2 -XX:+UseSerialGC'}, stdio:['ignore','pipe','pipe'],
});
server.stdout.on('data', bytes => {output=(output+bytes).slice(-20000);});
server.stderr.on('data', bytes => {output=(output+bytes).slice(-20000);});
const exited = new Promise(resolve => server.once('exit', resolve));
const waitFor = async predicate => {
  for (let attempt=0; attempt<100; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve,100));
  }
  throw new Error('Timed out waiting for debug integration:\n' + output);
};
let browser;
try {
  await waitFor(async()=>{try{return (await fetch(base+'/api/status')).ok;}catch{return false;}});
  browser = await chromium.launch({headless:true});
  if (noAuth) {
    const context = await browser.newContext();
    await context.addInitScript(()=>Object.defineProperty(window,'VideoDecoder',{value:undefined}));
    const viewer = await context.newPage();
    await viewer.goto(base+'/');
    await viewer.waitForFunction(()=>document.querySelector('.mse-video')?.currentTime>.2,{timeout:15000});
    await viewer.waitForFunction(()=>document.querySelector('.mse-video')?.currentTime>1.2);
    const playback = await viewer.locator('.mse-video').evaluate(video=>({
      buffered: video.buffered.end(video.buffered.length-1)-video.buffered.start(0),
      rate: video.playbackRate,
    }));
    assert.ok(playback.buffered < 5, 'MSE video buffer must remain bounded without seek flashes');
    assert.equal(playback.rate, 1, 'MSE video playback must not time-warp the active decoder');
    assert.equal((await (await fetch(base+'/api/status')).json()).audio.packetsReceived,0,
      'A live video must not imply that phone audio has arrived');
    const page = await context.newPage();
    await page.goto(base+'/debug.html');
    await page.route('**/api/hotspot', route=>route.fulfill({json:{enabled:true,error:null,
      hotspots:[{interface:'wlan0',address:'192.168.43.1'}]}}));
    await page.waitForFunction(()=>document.querySelector('#hotspot-status').textContent.includes('映射已就绪'));
    assert.equal(await page.locator('#tesla-link').isVisible(),true);
    assert.match(await page.locator('#hotspot-address').textContent(),/192\.168\.43\.1/);
    await page.unroute('**/api/hotspot');
    await page.route('**/api/hotspot', route=>route.fulfill({json:{enabled:false,error:null,hotspots:[]}}));
    await page.waitForFunction(()=>document.querySelector('#hotspot-status').textContent.includes('热点未开启'));
    assert.equal(await page.locator('#tesla-link').isVisible(),false);
    await page.unroute('**/api/hotspot');
    await page.route('**/api/hotspot', route=>route.fulfill({json:{enabled:false,error:'monitor_unavailable'}}));
    await page.waitForFunction(()=>document.querySelector('#hotspot-status').textContent.includes('监测暂不可用'));
    assert.equal(await page.locator('#tesla-link').isVisible(),false);
    await page.unroute('**/api/hotspot');
    await page.getByText('Fixture iPhone',{exact:true}).waitFor();
    assert.equal(await page.locator('#auth-note').isVisible(),false);
    await page.getByRole('button',{name:'扫描设备 · 30 秒'}).click();
    await waitFor(()=>calls.some(call=>call.operation==='scan'));
    assert.equal((await fetch(base+'/api/bluetooth?client='+'a'.repeat(32))).status,200);
    assert.equal((await fetch(base+'/api/readiness')).status,200);
    assert.equal((await fetch(base+'/api/display',{method:'POST',headers:{Origin:'http://untrusted.invalid','Content-Type':'application/json'},body:'{}'})).status,403);
    assert.equal((await fetch(base+'/api/bluetooth/scan',{method:'POST',headers:{Origin:'http://untrusted.invalid','Content-Type':'application/json'},body:JSON.stringify({client:'a'.repeat(32)})})).status,403);
    assert.equal((await (await fetch(base+'/api/status')).json()).viewers,1);
    console.log('No-token LAN check passed: fresh browser main video, Debug scan, readiness, single viewer and cross-origin write rejection.');
  } else {
  const context = await browser.newContext();
  await context.addInitScript(()=>Object.defineProperty(window,'VideoDecoder',{value:undefined}));
  const viewer = await context.newPage();
  await viewer.goto(base+'/?token='+token);
  await viewer.waitForFunction(()=>document.querySelector('.mse-video')?.currentTime>.2, {timeout:15000});
  const page = await context.newPage();
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/debug.html');
  await page.getByText('Fixture iPhone',{exact:true}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('#display-fields').disabled);
  for (const size of [{width:1920,height:1080},{width:980,height:480},{width:390,height:844}]) {
    await viewer.setViewportSize(size);
    await viewer.waitForFunction(() => {
      const container = document.querySelector('#screen-container').getBoundingClientRect();
      const surface = document.querySelector('#surface').getBoundingClientRect();
      return Math.abs(container.width - innerWidth) < 1 && Math.abs(container.height - innerHeight) < 1 &&
        surface.width > 0 && Math.abs(surface.width / surface.height - 1280 / 720) < .01;
    });
    const layout = await viewer.evaluate(() => ({
      noScroll:document.documentElement.scrollHeight === innerHeight && document.documentElement.scrollWidth === innerWidth,
      headerHidden:getComputedStyle(document.querySelector('#header')).display === 'none',
      surface:document.querySelector('#surface').getBoundingClientRect().toJSON(),
    }));
    assert.equal(layout.noScroll,true,'Viewport must not overflow on short or portrait screens');
    assert.equal(layout.headerHidden,true,'Main page must default to pure CarPlay');
    assert.ok(layout.surface.width <= size.width + 1 && layout.surface.height <= size.height + 1);
  }
  assert.equal(await viewer.locator('#error-banner').isVisible(),false,'HTTP MSE must not show a WebCodecs-only error');
  assert.equal(await viewer.locator('#kiosk-sound').count(),0,'Main viewer must not have a separate sound activation button');
  let displayRequest;
  await page.route('**/api/display?*', async route => {
    displayRequest = route.request().postDataJSON();
    await route.fulfill({json:{ok:true}});
  });
  await page.locator('#display-width').fill('1920');
  await page.locator('#display-height').fill('1080');
  await page.locator('#display-fps').selectOption('30');
  await page.getByRole('button',{name:'应用画面设置（重启 CarPlay 会话）'}).click();
  await waitFor(()=>displayRequest !== undefined);
  assert.deepEqual(displayRequest,{width:1920,height:1080,fps:30,uiScale:100,hevc:false});
  await page.locator('#master-volume').fill('42');
  await viewer.waitForFunction(()=>document.querySelector('#audio-master').value === '42');
  assert.equal(await page.evaluate(()=>window.untrustedNameRan),undefined,'Device names must be text, not HTML');
  assert.equal((await (await fetch(base+'/api/status')).json()).viewers,1,'Debug must not consume the viewer slot');
  await page.getByRole('button',{name:'扫描设备 · 30 秒'}).click();
  await waitFor(()=>calls.some(call=>call.operation==='scan'));
  await page.locator('.device').filter({hasText:'Fixture iPhone'}).getByRole('button',{name:'配对这台设备'}).click();
  await page.getByText('000123',{exact:true}).waitFor();
  const confirm = page.getByRole('button',{name:'确认',exact:true});
  assert.equal(await confirm.isDisabled(),true,'Passkey confirmation requires explicit user verification');
  assert.equal(calls.filter(call=>call.operation==='answer').length,0);
  await page.getByRole('checkbox').check();
  await confirm.click();
  await page.getByRole('button',{name:'设为 CarPlay iPhone（下次启动生效）'}).click();
  await waitFor(()=>calls.some(call=>call.operation==='select'));
  assert.equal(calls.filter(call=>call.operation==='answer').length,1);
  assert.equal(state.selectedPhone,phone);
  state.safety.allowed=false;
  await page.getByText('操作已锁定：需要新鲜的驻车、巡航关闭状态。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'扫描设备 · 30 秒'}).isDisabled(),true);
  assert.equal(await page.locator('#display-apply').isDisabled(),true,'Display changes must be locked outside stationary setup');
  assert.equal((await (await fetch(base+'/api/bluetooth?client='+'a'.repeat(32))).json()).error,'invalid token');
  const mutation = body => ({method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const cross = mutation({client:'a'.repeat(32)}); cross.headers.Origin='http://untrusted.invalid';
  assert.equal((await fetch(base+'/api/bluetooth/scan',cross)).status,403);
  assert.equal((await fetch(base+'/api/bluetooth/scan',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'text/plain'},body:'{}'})).status,415);
  assert.equal((await fetch(base+'/api/bluetooth/scan',mutation({client:'a'.repeat(32),padding:'x'.repeat(5000)}))).status,413);
  await page.close();
  await waitFor(()=>calls.some(call=>call.operation==='cancel'));
  assert.equal((await (await fetch(base+'/api/status')).json()).viewers,1);
  const unauthenticated = await browser.newContext();
  const noToken = await unauthenticated.newPage();
  await noToken.goto(base+'/debug.html');
  assert.equal(await noToken.locator('#auth-note').isVisible(),true);
  assert.equal(await noToken.locator('#scan').isDisabled(),true);
  await noToken.goto(base+'/');
  await noToken.waitForURL('**/debug.html?reason=access-required');
  assert.equal(await noToken.locator('#auth-note').isVisible(),true);
  const unavailable = await context.newPage();
  let websocketAttempts=0;
  unavailable.on('websocket',()=>websocketAttempts++);
  await unavailable.route('**/api/status',route=>route.fulfill({json:{sessionActive:false,diagnostics:false}}));
  await unavailable.goto(base+'/');
  await unavailable.waitForURL('**/debug.html?reason=receiver-unavailable',{timeout:15000});
  assert.equal(websocketAttempts,0,'Unconnected phone must go to Debug before consuming the viewer slot');
  assert.equal((await (await fetch(base+'/api/status')).json()).viewers,1);
  const interrupted = await context.newPage();
  await interrupted.route('**/api/status',route=>route.fulfill({json:{sessionActive:true,diagnostics:false}}));
  await interrupted.routeWebSocket('**/ws?*',socket=>socket.close({code:1008,reason:'viewer occupied'}));
  await interrupted.goto(base+'/');
  await interrupted.waitForURL('**/debug.html?reason=connection-lost',{timeout:15000});
  assert.equal((await (await fetch(base+'/api/status')).json()).viewers,1,'Rejected viewers must not take over the existing main page');
  const noVideo = await context.newPage();
  await noVideo.route('**/api/status',route=>route.fulfill({json:{sessionActive:true,diagnostics:false}}));
  await noVideo.routeWebSocket('**/ws?*',socket=>socket.send(JSON.stringify({type:'hello',sessionActive:true,diagnostics:false})));
  await noVideo.goto(base+'/');
  await noVideo.waitForURL('**/debug.html?reason=video-unavailable',{timeout:25000});
  assert.equal((await (await fetch(base+'/api/status')).json()).viewers,1);
  assert.deepEqual(errors,[]);
  console.log('Debug browser check passed: viewport/portrait fitting without scroll or stretching, settings and volume sync, startup/auth/first-frame failure routing, scan, manual pairing, safety lock, auth/origin/body limits and independent main video.');
  }
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
  const stopped = await Promise.race([exited.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),5000))]);
  if (!stopped) {server.kill('SIGKILL'); await exited;}
  await new Promise(resolve=>broker.close(resolve));
  rmSync(directory,{recursive:true,force:true});
}
