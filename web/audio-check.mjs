// Copyright (c) 2026 机械小鸽; SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('./', import.meta.url));
const encoded = execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi',
  '-i','sine=frequency=440:sample_rate=44100','-t','1','-ac','2','-c:a','aac','-f','adts','pipe:1']);
const packets=[];
for (let offset=0; offset<encoded.length;) {
  assert.equal(encoded[offset],255);
  const size=((encoded[offset+3]&3)<<11)|(encoded[offset+4]<<3)|(encoded[offset+5]>>5);
  packets.push(Array.from(encoded.subarray(offset+7,offset+size)));
  offset+=size;
}
const ogg = execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi',
  '-i','sine=frequency=660:sample_rate=16000','-t','1','-ac','1','-c:a','libopus','-f','ogg','pipe:1']);
const opusPackets = [];
let partial = [];
for (let offset = 0; offset < ogg.length;) {
  assert.equal(ogg.subarray(offset, offset + 4).toString(), 'OggS');
  const segments = ogg[offset + 26];
  let payload = offset + 27 + segments;
  for (let index = 0; index < segments; index++) {
    const size = ogg[offset + 27 + index];
    partial.push(...ogg.subarray(payload, payload + size));
    payload += size;
    if (size < 255) { opusPackets.push(partial); partial = []; }
  }
  offset = payload;
}
opusPackets.splice(0, 2); // Ogg stream headers are replaced by our WebM initialization.
const server=createServer((request,response)=>{
  const path=new URL(request.url,'http://localhost').pathname;
  if(path.startsWith('/src/') && /^\/src\/[a-z0-9-]+(?:\.ts)?$/.test(path)) {
    const file=path.endsWith('.ts')?path:path+'.ts';
    const source=readFileSync(root+file.slice(1),'utf8');
    response.setHeader('Content-Type','application/javascript');
    response.end(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
  } else {
    response.setHeader('Content-Type','text/html');
    response.end(`<button id="play">Play test</button><script type="module">
      import {AudioEngine} from "/src/audio.ts";
      window.engine = new AudioEngine(message => (window.audioErrors ||= []).push(message),
        playing => window.playbackAllowed = playing);
      document.querySelector("button").onclick=()=>window.engine.unlock();
      if (new URL(location.href).searchParams.has('auto')) {
        window.analyser=engine.context.createAnalyser(); engine.gain.connect(analyser);
        window.energy=()=>{const data=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(data);
          return Math.sqrt(data.reduce((sum,value)=>sum+value*value,0)/data.length);};
        engine.handleConfig({kind:'audio-config',streamType:102,codec:1,sampleRate:44100,channels:2,
          name:'media',description:new Uint8Array([0x12,0x10])});
        engine.startPlayback();
        const packets=${JSON.stringify(packets)}; let sample=0,index=0;
        window.feed=setInterval(()=>{
          engine.handlePacket({kind:'audio-packet',streamType:102,timestampUs:sample*1_000_000/44100,
            data:new Uint8Array(packets[index++%packets.length])});sample+=1024;
        },1024*1000/44100);
      }
    </script>`);
  }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true});
try {
  const context=await browser.newContext();
  await context.addInitScript(()=>Object.defineProperty(window,'AudioDecoder',{value:undefined}));
  const page=await context.newPage(); const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(()=>window.engine).catch(error=>{
    throw new Error('Audio harness failed: '+errors.join('; ')+'; '+error.message);
  });
  await page.evaluate(()=>{
    window.analyser=engine.context.createAnalyser();
    engine.gain.connect(analyser);
    engine.handleConfig({kind:'audio-config',streamType:102,codec:1,sampleRate:44100,channels:2,name:'media',description:new Uint8Array([0x12,0x10])});
  });
  await page.getByRole('button',{name:'Play test'}).click();
  await page.evaluate(packets=>{
    let sample=0,index=0;
    window.feed=setInterval(()=>{
      engine.handlePacket({kind:'audio-packet',streamType:102,timestampUs:sample*1_000_000/44100,data:new Uint8Array(packets[index++%packets.length])});
      sample+=1024;
    },1024*1000/44100);
    window.energy=()=>{
      const data=new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data);
      return Math.sqrt(data.reduce((sum,value)=>sum+value*value,0)/data.length);
    };
  },packets);
  await page.waitForFunction(()=>energy()>.01,{timeout:10000});
  await page.waitForTimeout(7000);
  const playing=await page.evaluate(()=>({
    energy:energy(), time:document.querySelector('audio').currentTime,
    bufferedStart:document.querySelector('audio').buffered.start(0),
    bufferedLength:document.querySelector('audio').buffered.end(0)-document.querySelector('audio').buffered.start(0),
  }));
  assert.ok(playing.time>5,'Native HTTP AAC playback must advance continuously');
  assert.ok(playing.bufferedStart>0,'Old audio must be pruned');
  assert.ok(playing.bufferedLength<5,'Buffer duration must remain bounded: '+JSON.stringify(playing));
  await page.evaluate(()=>engine.setVolume(0));
  await page.waitForFunction(()=>energy()<.0001);
  await page.evaluate(()=>engine.setVolume(1));
  await page.waitForFunction(()=>energy()>.01);
  await page.evaluate(()=>{clearInterval(feed);engine.stopAll();});
  assert.equal(await page.locator('audio').count(),0,'Stream cleanup must remove audio elements');
  assert.deepEqual(await page.evaluate(()=>window.audioErrors||[]),[]);
  await page.evaluate(opusPackets => {
    engine.handleConfig({kind:'audio-config',streamType:101,codec:2,sampleRate:16000,channels:1,
      name:'default',description:new Uint8Array()});
    engine.startPlayback();
    let index=0, time=0;
    window.feed=setInterval(()=>{
      engine.handlePacket({kind:'audio-packet',streamType:101,timestampUs:time*1000,
        data:new Uint8Array(opusPackets[index++%opusPackets.length])});
      time+=20;
    },20);
  }, opusPackets);
  await page.waitForFunction(()=>energy()>.01,{timeout:10000});
  await page.waitForTimeout(7000);
  const opusPlayback = await page.locator('audio').evaluate(a=>({
    time:a.currentTime, start:a.buffered.start(0), duration:a.buffered.end(0)-a.buffered.start(0),
    error:a.error?.message??null,
  }));
  assert.equal(opusPlayback.error,null);
  assert.ok(opusPlayback.time>5 && opusPlayback.start>0 && opusPlayback.duration<5,
    'HTTP Opus must play continuously and prune buffers: '+JSON.stringify(opusPlayback));
  await page.evaluate(()=>engine.setVolume(0));
  await page.waitForFunction(()=>energy()<.0001);
  await page.evaluate(()=>engine.setVolume(1));
  await page.waitForFunction(()=>energy()>.01);
  await page.evaluate(packets=>{
    engine.handleConfig({kind:'audio-config',streamType:102,codec:1,sampleRate:44100,channels:2,
      name:'media',description:new Uint8Array([0x12,0x10])});
    engine.startPlayback();
    let sample=0,index=0;
    window.musicFeed=setInterval(()=>{
      engine.handlePacket({kind:'audio-packet',streamType:102,timestampUs:sample*1_000_000/44100,
        data:new Uint8Array(packets[index++%packets.length])});sample+=1024;
    },1024*1000/44100);
  },packets);
  await page.waitForFunction(()=>document.querySelectorAll('audio').length===2 &&
    Array.from(document.querySelectorAll('audio')).every(a=>a.currentTime>.2));
  await page.evaluate(()=>{clearInterval(feed);engine.stopStream(101);});
  await page.waitForFunction(()=>energy()>.01);
  assert.equal(await page.locator('audio').count(),1,'Stopping a navigation prompt must preserve media music');
  await page.evaluate(()=>clearInterval(musicFeed));
  await page.evaluate(()=>{clearInterval(feed);engine.stopAll();});
  assert.equal(await page.locator('audio').count(),0);
  assert.deepEqual(await page.evaluate(()=>window.audioErrors||[]),[]);
  await page.evaluate(()=>{
    engine.handleConfig({kind:'audio-config',streamType:100,codec:3,sampleRate:44100,channels:2,name:'default',description:new Uint8Array()});
    engine.handlePacket({kind:'audio-packet',streamType:100,timestampUs:0,data:new Uint8Array([1,2])});
    const bytes=new Uint8Array(4096);
    const view=new DataView(bytes.buffer);
    for(let sample=0;sample<2048;sample++) view.setInt16(sample*2,Math.round(Math.sin(sample/2*440*2*Math.PI/44100)*8000),true);
    window.feed=setInterval(()=>engine.handlePacket({kind:'audio-packet',streamType:100,timestampUs:0,data:bytes}),1024*1000/44100);
  });
  await page.waitForFunction(()=>energy()>.05);
  await page.evaluate(()=>{clearInterval(feed);engine.stopAll();});
  assert.deepEqual(await page.evaluate(()=>window.audioErrors||[]),[]);
  await page.evaluate(packet=>{
    engine.handleConfig({kind:'audio-config',streamType:102,codec:1,sampleRate:44100,channels:2,name:'media',description:new Uint8Array([0x12,0x10])});
    engine.startPlayback();
    for(let index=0;index<2000;index++) engine.handlePacket({kind:'audio-packet',streamType:102,timestampUs:index*1024*1_000_000/44100,data:new Uint8Array(packet)});
  },packets.reduce((largest, packet)=>packet.length>largest.length?packet:largest));
  await page.waitForFunction(()=>energy()>.01, null, {timeout:10000}).catch(async error=>{
    throw new Error(error.message+'; '+JSON.stringify(await page.evaluate(()=>({
      errors:window.audioErrors, audio:Array.from(document.querySelectorAll('audio'),a=>({
        error:a.error?.message,time:a.currentTime,paused:a.paused,
        ranges:Array.from({length:a.buffered.length},(_,i)=>[a.buffered.start(i),a.buffered.end(i)]),
      })),
    }))));
  });
  assert.equal(await page.locator('audio').count(),1,'Burst delivery must preserve playback rather than permanently close audio');
  assert.deepEqual(await page.evaluate(()=>window.audioErrors||[]),[]);
  await page.evaluate(()=>engine.stopAll());
  assert.equal(await page.locator('audio').count(),0);
  assert.deepEqual(errors,[]);
  console.log('HTTP audio check passed: native AAC and Opus decoding with nonzero Web Audio output without AudioDecoder; simultaneous music/prompts, LPCM, volume/mute, bounded buffers and cleanup.');
  for (const automatic of [true,false]) {
    const policyBrowser = await chromium.launch({headless:true,args:[
      automatic ? '--autoplay-policy=no-user-gesture-required' : '--autoplay-policy=user-gesture-required',
    ]});
    try {
      const policyContext=await policyBrowser.newContext();
      await policyContext.addInitScript(()=>Object.defineProperty(window,'AudioDecoder',{value:undefined}));
      const policyPage=await policyContext.newPage();
      await policyPage.goto(`http://127.0.0.1:${server.address().port}/?auto=1`);
      if (automatic) {
        await policyPage.waitForFunction(()=>window.energy?.()>.01 && window.playbackAllowed===true,{timeout:10000});
      } else {
        await policyPage.waitForFunction(()=>window.playbackAllowed===false,{timeout:10000});
        assert.equal(await policyPage.evaluate(()=>engine.isUnlocked),false,'Blocked autoplay must not claim sound is playing');
        await policyPage.getByRole('button',{name:'Play test'}).click();
        await policyPage.waitForFunction(()=>energy()>.01 && playbackAllowed===true,{timeout:10000});
      }
      assert.deepEqual(await policyPage.evaluate(()=>window.audioErrors||[]),[]);
      await policyPage.evaluate(()=>{clearInterval(feed);engine.stopAll();});
    } finally {await policyBrowser.close();}
  }
  console.log('Autoplay check passed: automatic AAC output with permissive policy; blocked policy reports authorization and recovers with one gesture.');
} finally {
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
