import assert from "node:assert/strict";
import test from "node:test";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from "node:fs";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createInterface} from "node:readline";
import {fileURLToPath} from "node:url";

test("actual Pi bridge shows preparation while a read-only tool waits for complete arguments", {timeout:30000}, async t => {
  const dir = mkdtempSync(join(tmpdir(),"umeko-preparing-"));
  const agentDir = join(dir,"agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir,"settings.json"),JSON.stringify({retry:{enabled:false},cacheWarming:"off"}));
  writeFileSync(join(dir,"fixture.txt"),"synthetic read-only result");
  let finishArguments, seenResults = 0, requests = 0, child;
  const server = createServer(async (req,res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    const common = {id:"fixture",object:"chat.completion.chunk",created:1,model:"test-model"};
    const send = (delta,finish_reason=null) => res.write(`data: ${JSON.stringify({...common,
      choices:[{index:0,delta,finish_reason}]})}\n\n`);
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    if (++requests === 1) {
      send({role:"assistant",tool_calls:[{index:0,id:"read-once",type:"function",
        function:{name:"read",arguments:'{"path":"fix'}}]});
      finishArguments = () => {
        send({tool_calls:[{index:0,function:{arguments:'ture.txt"}'}}]});
        send({},"tool_calls");
        res.end("data: [DONE]\n\n");
      };
    } else {
      seenResults += body.messages.filter(m=>m.role==="tool" && m.tool_call_id==="read-once"
        && JSON.stringify(m).includes("synthetic read-only result")).length;
      send({role:"assistant",content:"fixture completed"});
      send({},"stop");
      res.end("data: [DONE]\n\n");
    }
  });
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill();
      await stopped;
    }
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    rmSync(dir,{recursive:true,force:true});
  });
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  const bridge = fileURLToPath(new URL("../runtime/releases/coding-1.5.2/bridge.mjs",import.meta.url));
  child = spawn(process.execPath,[bridge],{cwd:dir,stdio:["pipe","pipe","pipe"],windowsHide:true});
  let stderr = "";
  child.stderr.on("data",chunk=>{stderr=(stderr+chunk).slice(-2000);});
  const lines = createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const send = command => child.stdin.write(JSON.stringify(command)+"\n");
  async function next() {
    const line = await lines.next();
    assert.ok(!line.done,stderr);
    const event = JSON.parse(line.value);
    assert.notEqual(event.type,"error",event.message);
    return event;
  }
  send({type:"inspect",gateway:`http://127.0.0.1:${server.address().port}/`,token:"fixture-only",
    workspace:dir,defaultCwd:dir,agentDir,sessionDir:join(dir,"sessions"),
    models:[{id:"test-model",input:["text"],contextWindow:128000}],model:"test-model",
    agent:{autoCompaction:false}});
  while ((await next()).type!=="done") {}
  send({type:"prompt",text:"Read the synthetic fixture"});
  const events = [];
  for (;;) {
    const event = await next();
    events.push(event);
    if (event.type==="tool_preparation" && event.count===1) {
      assert.equal(requests,1);
      assert.ok(!events.some(e=>e.type==="tool"));
      finishArguments();
    }
    if (event.type==="done") break;
  }
  const preparations = events.filter(e=>e.type==="tool_preparation");
  assert.deepEqual(preparations,[{type:"tool_preparation",count:1},{type:"tool_preparation",count:0}]);
  assert.ok(events.indexOf(preparations[1])<events.findIndex(e=>e.type==="tool"));
  assert.deepEqual(events.filter(e=>e.type==="tool" && e.state==="running").map(e=>[e.id,e.args]),
    [["read-once",{path:"fixture.txt"}]]);
  assert.equal(seenResults,1);
  assert.equal(requests,2);
});
