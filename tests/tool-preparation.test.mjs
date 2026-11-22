import assert from "node:assert/strict";
import test from "node:test";
import { createToolPreparation } from "../runtime/tool-preparation.mjs";

function fixture() {
  const emitted = [], executed = [];
  const tracker = createToolPreparation(event => emitted.push(event));
  const start = () => tracker.observe({type:"message_start",message:{role:"assistant"}});
  const part = (type,contentIndex,other={}) => tracker.observe({
    type:"message_update",assistantMessageEvent:{type,contentIndex,...other}});
  const end = stopReason => tracker.observe({type:"message_end",message:{role:"assistant",stopReason}});
  // Fixture deliberately owns the execution callback; the production observer
  // receives only a UI-event callback and never receives its execution authority.
  const execute = args => executed.push(args);
  return {emitted,executed,start,part,end,execute,tracker,counts:()=>emitted.map(e=>e.count)};
}

test("tool args do not leak or notify per delta; exact real-tool fixture remains separate",()=>{
  const f = fixture();
  f.start();
  f.part("toolcall_start",0,{partial:{arguments:"SYNTHETIC_SECRET"}});
  for(let i=0;i<3000;i++) f.part("toolcall_delta",0,{delta:"SYNTHETIC_SECRET"});
  f.part("toolcall_start",0);
  f.part("toolcall_start",2);
  f.part("toolcall_end",0,{toolCall:{id:"fake",arguments:{value:"completed"}}});
  assert.deepEqual(f.executed,[]);
  f.execute({value:"completed"});
  f.part("toolcall_end",2);
  f.end("toolUse");
  assert.deepEqual(f.counts(),[1,2,1,0]);
  assert.deepEqual(f.executed,[{value:"completed"}]);
  for (const event of f.emitted) assert.deepEqual(Object.keys(event),["type","count"]);
});

test("retry same content index starts fresh; aborted/length and teardown clear",()=>{
  const f = fixture();
  f.start(); f.part("toolcall_start",0);
  f.tracker.observe({type:"auto_retry_start"});
  f.part("toolcall_start",0); // Late abandoned-attempt event, before next start.
  f.start(); f.part("toolcall_start",0); f.end("aborted");
  f.start(); f.part("toolcall_start",0); f.end("length");
  f.start(); f.part("toolcall_start",0); f.tracker.clear();
  assert.deepEqual(f.counts(),[1,0,1,0,1,0,1,0]);
  assert.deepEqual(f.executed,[]);
});

test("malformed or over-limit indices never grow the bounded live snapshot",()=>{
  const f=fixture();
  f.start();
  for(const i of [-1,0.5,Infinity,"1"]) f.part("toolcall_start",i);
  for(let i=0;i<256;i++) f.part("toolcall_start",i);
  assert.equal(f.counts().length,64);
  assert.equal(f.counts().at(-1),64);
  f.end("length");
  assert.equal(f.counts().at(-1),0);
});
