const {app,BrowserWindow,ipcMain}=require('electron');
const {CommunicationBridgeIntegration}=require('./bridge.cjs');
const {registerCommunicationIpc}=require('./ipc.cjs');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const fs=require('node:fs');
const path=require('node:path');
const repo=process.env.AETHER_TEST_REPO, output=process.env.AETHER_TEST_OUTPUT, mode=process.env.AETHER_TEST_MODE;
if(!repo||!output||!['flow','slow','watchdog'].includes(mode))throw Error('Test fixture configuration missing');
app.setPath('userData',path.join(output,'profile'));
const stage=s=>fs.writeFileSync(path.join(output,'stage.txt'),s);stage('module ready');
let win,client,transport,nextDelay=mode==='slow'?126000:mode==='watchdog'?200000:700;
const evidence={mode,checks:[],turns:0,providerPids:[],helperPids:[],limits:'Production bridge/controller/IPC + built MCP helper + renderer/preload in sandboxed Electron. Deterministic child-process provider. No real models; not production main bootstrap.'};
const expected='U9_PRIVATE_ANSWER '+('😀 Unicode "quoted"\\ text\n'.repeat(1500));
const service=new CommunicationBridgeIntegration({providerFactory:()=>{
 let child,exited=Promise.resolve();
 return {connect:async()=>{},health:async()=>({ready:true,authMode:'subscription'}),newSession:async()=> 'fixture',
 sendTurn:(_request,onEvent)=>new Promise((resolve,reject)=>{
   evidence.turns++;
   child=spawn(process.execPath,['-e',`process.on('message',m=>{let n=0;const t=setInterval(()=>process.send({chunk:'observed '+(++n)+'\\n'}),1000);setTimeout(()=>{clearInterval(t);process.send({answer:m.answer});},m.delay);});`],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
   evidence.providerPids.push(child.pid);exited=once(child,'exit').then(()=>{});child.once('error',reject);
   child.on('message',m=>{if(m.chunk)onEvent({kind:'message-chunk',sessionId:'fixture',text:m.chunk});if(m.answer)resolve({stopReason:'completed',text:m.answer,usage:{inputTokens:12,outputTokens:34,cachedInputTokens:null}});});
   child.send({answer:expected,delay:nextDelay});
 }),cancel:async()=>{if(child)child.kill();},dispose:async()=>{if(child)child.kill();await exited;}};
},onSnapshot:s=>{if(win&&!win.isDestroyed())win.webContents.send('communication:snapshot',s);}});
registerCommunicationIpc(ipcMain,service,e=>!!win&&e.sender===win.webContents&&e.senderFrame===win.webContents.mainFrame);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const ev=s=>win.webContents.executeJavaScript(s);
async function until(fn,ms=10000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await delay(100);}throw Error('condition timed out');}
function check(ok,label){if(!ok)throw Error(label);evidence.checks.push(label);fs.writeFileSync(path.join(output,'progress.json'),JSON.stringify({checks:evidence.checks,providerPids:evidence.providerPids,helperPids:evidence.helperPids}));}
async function connect(){const manifest=await service.prepareLaunch();transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,'out/main/communication-mcp.js')],stderr:'pipe',env:{...process.env,ELECTRON_RUN_AS_NODE:'1',AETHER_BRIDGE_PIPE:manifest.endpoint,AETHER_BRIDGE_CAPABILITY:manifest.capability}});client=new Client({name:'u9-deterministic-test',version:'1'});stage('helper connecting');await client.connect(transport);stage('helper connected');evidence.helperPids.push(transport.pid);const tools=await client.listTools();check(tools.tools.length===3,'real helper exposes exactly three tools');await until(async()=>service.snapshot().readiness==='ready');}
async function tool(name,args){const result=await client.callTool({name,arguments:args},undefined,{timeout:70000});check(Buffer.byteLength(JSON.stringify(result))<=32768,'encoded MCP result fits budget');return JSON.parse(result.content[0].text);}
app.whenReady().then(async()=>{try{
 win=new BrowserWindow({width:1400,height:1000,webPreferences:{preload:path.join(repo,'out/preload/preload.cjs'),contextIsolation:true,sandbox:true}});
 stage('renderer load');await win.loadFile(path.join(repo,'out/renderer/index.html'));stage('renderer loaded');await until(()=>ev('!!window.aetherElectron'));
 await ev(`localStorage.setItem('aetheros-v1',JSON.stringify({activeTab:'Settings',communicationCfg:{enabled:true}}));true`);await win.reload();await until(()=>ev(`!!document.querySelector('section[aria-label="Agent communication"]')`));
 stage('enabling');await service.setEnabled(true);stage('preparing helper');await connect();
 const ask={request_key:'stable-key',question:'U9_PRIVATE_QUESTION',context:'<script>U9_PRIVATE_CONTEXT</script>'};
 const accepted=await tool('ask_codex',ask), id=accepted.exchange_id;check(!!id,'ask returns exchange ID');
 const retry=await tool('ask_codex',ask);check(retry.exchange_id===id,'lost acknowledgement retry retains same exchange');
 if(mode==='watchdog'){await until(async()=>evidence.turns===1);check(true,'watchdog owns helper and provider descendants');await new Promise(()=>{});}
 if(mode==='slow'){
   for(let i=0;i<2;i++){const start=Date.now();const pending=await tool('get_codex_exchange',{exchange_id:id,wait_ms:60000});const elapsed=Date.now()-start;check(elapsed>=59000&&pending.provider_state==='streaming','60 second get stays blocked despite real output deltas');}
   const final=await tool('get_codex_exchange',{exchange_id:id,wait_ms:60000});check(final.availability==='ready','turn longer than two minutes completes through sequential waits');
 }else{
   await until(async()=>service.snapshot().metadata[0]?.delivery.availability==='ready');
   check(service.snapshot().metadata[0].delivery.uniquePagesServed===0,'answer ready does not imply Claude receipt');check(evidence.turns===1,'idempotency creates one provider process');
   await ev(`document.querySelector('button[aria-label^="Open communication."]').click();true`);await until(()=>ev(`document.body.innerText.includes('U9_PRIVATE_ANSWER')`));
   check(service.snapshot().metadata[0].delivery.uniquePagesServed===0,'opening Comms does not serve Claude pages');
   win.show();win.focus();await delay(400);fs.writeFileSync(path.join(output,'ready-dark.png'),(await win.webContents.capturePage()).toPNG());
   const first=await tool('get_codex_exchange',{exchange_id:id});const replay=await tool('get_codex_exchange',{exchange_id:id,cursor:first.cursor});check(replay.text===first.text&&service.snapshot().metadata[0].delivery.uniquePagesServed===1,'cursor replay does not inflate delivery');
   let text=first.text,next=first.next_cursor,pages=1;while(next){const page=await tool('get_codex_exchange',{exchange_id:id,cursor:next});text+=page.text;next=page.next_cursor;pages++;}
   check(text===expected&&pages>1,'Unicode multi-page answer is complete and ordered');
   check(service.snapshot().remainingCredits===2,'retrieval consumes no extra credit');
   for (let n=2;n<=3;n++) {
     await until(async()=>service.snapshot().cleanup==='confirmed');
     const follow=await tool('ask_codex',{request_key:'success-'+n,question:'successful follow-up '+n});
     check(!!follow.exchange_id,'successful prior turn imposes no cooldown');
     await until(async()=>service.snapshot().metadata.find(m=>m.exchangeId===follow.exchange_id)?.delivery.availability==='ready');
   }
   check(service.snapshot().remainingCredits===0,'three consumed starts exhaust initial allowance');
   service.grantCredits('operator-confirmed-fixture');service.grantCredits('operator-confirmed-fixture');
   check(service.snapshot().remainingCredits===3,'main operator grant adds exactly three credits once');
   await client.close();await until(async()=>service.snapshot().readiness==='disconnected');check(service.readPayload(id)?.answer===expected,'completed answer remains after helper loss');
   await ev(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Settings').click();true`);await until(()=>ev(`!!document.querySelector('section[aria-label="Agent communication"]')`));
   await ev(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim().toUpperCase()==='LIGHT').click();true`);await ev(`document.querySelector('button[aria-label^="Open communication."]').click();true`);await until(()=>ev(`document.body.innerText.includes('U9_PRIVATE_ANSWER')`));await delay(300);fs.writeFileSync(path.join(output,'delivered-light.png'),(await win.webContents.capturePage()).toPNG());
   check(!await ev(`localStorage.getItem('aetheros-v1').includes('U9_PRIVATE_')`),'Aether persistence excludes question/context/answer sentinels');
   await connect();const old=await tool('get_codex_exchange',{exchange_id:id});check(old.code==='UNKNOWN_EXCHANGE','replacement launch cannot retrieve predecessor');
   nextDelay=200000;const pending=await tool('ask_codex',{request_key:'cancel-key',question:'cancel fixture'});await until(async()=>evidence.turns===4);await ev(`window.aetherElectron.communication.cancel(${JSON.stringify(pending.exchange_id)})`);await until(async()=>service.snapshot().metadata.find(m=>m.exchangeId===pending.exchange_id)?.cleanup==='confirmed');check(service.snapshot().metadata.find(m=>m.exchangeId===pending.exchange_id)?.providerState==='cancelled','operator cancellation reaches real helper-launched work and cleanup');
 }
 await client.close();const stopped=await service.dispose();check(stopped.ok,'bridge disposal confirms cleanup');
 for(const pid of [...evidence.providerPids,...evidence.helperPids]){await until(async()=>{try{process.kill(pid,0);return false;}catch{return true;}},10000);}check(true,'all recorded helper and provider child processes exited');
 evidence.verdict='Passed';fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2));app.exit(0);
 }catch(error){await client?.close().catch(()=>{});await service.dispose().catch(()=>{});evidence.verdict='Failed';evidence.error=String(error.stack);fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2));app.exit(1);}});
