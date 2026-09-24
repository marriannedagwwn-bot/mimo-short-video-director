import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { WorkflowService } from "../../src/workflow.js";
import { ProductionStateStore } from "../../src/production-state-store.js";
import { lineageRef } from "../../src/production-lineage.js";
import { storyboardDesignFromPlan } from "../../src/storyboard-contract.js";
import { fullStoryCharacterRegistryInput, mockFullStoryCharacterRegistry } from "../../src/full-story-character-registry.js";

const listen = server => new Promise(resolve=>server.listen(0,"127.0.0.1",()=>resolve(server.address().port)));
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));

// Explicit protocol fixture. No story in this harness is a real-model result.
export async function createStoryboardRuntime() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"mimo-storyboard-runtime-"));
  const workflow = new WorkflowService();
  const input = {frames:Array.from({length:3},(_,timestamp)=>({timestamp,dataUrl:"data:image/jpeg;base64,AA=="})),
    metadata:{duration:60,width:1920,height:1080,name:"协议测试"},count:4,
    creatorProfile:{fixedCharacter:"阿岚，社区修理师",vertical:"动画",constraints:""}};
  const upstream=await workflow.run(input),variant=upstream.themeVariants.variants[0];
  const fullStory=await workflow.createFullStory({...input,...upstream,variant});
  const plan=await workflow.createAnimationPlan({...input,...upstream,variant,fullStory,animationPlanVersion:"4.0",targetAspectRatio:"16:9",backgroundMusicEnabled:false});
  const video=await workflow.createShotVideoPrompt({plan,shotId:plan.shotPlan[0].shotId,planDigest:"fixture",target:{provider:"Seedance",model:"doubao-seedance-2-0-260128"}});
  const store=new ProductionStateStore({rootDir:path.join(root,"state")});
  const run=await store.createRun({metadata:{purpose:"storyboard-protocol-test"}}), refs={};
  const put=async(id,type,content,dependencies=[])=>{
    const result=await store.commitArtifact({...run,artifactId:id,artifactType:type,content,dependencies:dependencies.map(id=>refs[id]),requestId:`fixture-${id.replaceAll(":","-")}`,expectedCurrentRevision:null});
    refs[id]=lineageRef(result.lineage);return result;
  };
  await put("referenceAnalysis","referenceAnalysis",upstream.referenceAnalysis);
  await put("sourceScriptReconstruction","sourceScriptReconstruction",upstream.sourceScriptReconstruction,["referenceAnalysis"]);
  await put("creativeBrief","creativeBrief",upstream.creativeBrief,["referenceAnalysis","sourceScriptReconstruction"]);
  await put("visualGuardrails","visualGuardrails",upstream.visualGuardrails,["referenceAnalysis","sourceScriptReconstruction","creativeBrief"]);
  await put("themeVariants","themeVariants",upstream.themeVariants,["creativeBrief","visualGuardrails"]);
  await put(`variant:${variant.id}`,"selectedVariant",variant,["themeVariants"]);
  await put(`fullStory:${variant.id}`,"fullStory",fullStory,[`variant:${variant.id}`,"referenceAnalysis","sourceScriptReconstruction","creativeBrief","visualGuardrails"]);
  const payload=await store.sealPackage({...run,payload:{...upstream,creatorProfile:input.creatorProfile,selectedVariant:variant,fullStory}});
  const packagePath=path.join(root,"protocol-fixture.json");await fs.writeFile(packagePath,JSON.stringify(payload));
  const requests=[];let releasePrompt=null, holdPrompt=false;
  const provider=http.createServer(async(req,res)=>{
    if(req.method==="GET") {res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({data:[{id:"qwen3.7-max"},{id:"qwen3.7-plus"}]}));return;}
    let raw="";for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);requests.push(body);
    const prompt=body.messages.find(row=>row.role==="user")?.content || "";
    let value;
    if(prompt.includes("任务：整理本次 Full Story")) value=mockFullStoryCharacterRegistry(fullStoryCharacterRegistryInput(fullStory,input.creatorProfile));
    else if(prompt.includes("任务：将完整 Full Story")) value=storyboardDesignFromPlan(plan);
    else if(prompt.includes("你是分镜修稿编辑")) value={strengths:[],guidance:["协议测试的合成意见，未进行真实模型评审"],items:[]};
    else if(prompt.includes("你是单镜视频提示词撰写者")) {
      if(holdPrompt) await new Promise(resolve=>releasePrompt=resolve);
      value={videoPrompt:video.videoPrompt};
    } else {res.writeHead(400);res.end(JSON.stringify({error:{message:"Unexpected fixture prompt"}}));return;}
    res.writeHead(200,{"content-type":"text/event-stream"});
    res.end(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(value)},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\ndata: [DONE]\n\n`);
  });
  const providerPort=await listen(provider);
  const reservation=http.createServer();const port=await listen(reservation);await new Promise(resolve=>reservation.close(resolve));
  const child=spawn(process.execPath,["--use-env-proxy","server.js"],{cwd:path.resolve(import.meta.dirname,"../.."),env:{...process.env,
    PORT:String(port),QWEN_BASE_URL:`http://127.0.0.1:${providerPort}/v1`,QWEN_API_KEY:"protocol-fixture-key",QWEN_ANIMATION_MODEL:"qwen3.7-max",
    MIMO_BASE_URL:"",DEEPSEEK_API_KEY:"",JIMENG_API_KEY:"",MINIMAX_API_KEY:"",SEEDANCE_API_KEY:"",KLING_API_KEY:"",KLING_ACCESS_KEY:"",KLING_SECRET_KEY:"",
    WORKFLOW_PRODUCTION_STATE_DIR:path.join(root,"state"),WORKFLOW_GROUNDING_KEY:workflow.groundingKey.toString("hex"),WORKFLOW_CHARACTER_BOUNDARY_KEY:workflow.characterBoundaryKey.toString("hex"),
    FULL_STORY_MODEL_OUTPUT_LOG_DIR:path.join(root,"logs/story"),ANIMATION_PLAN_MODEL_OUTPUT_LOG_DIR:path.join(root,"logs/plan"),STAGE_MODEL_OUTPUT_LOG_DIR:path.join(root,"logs/stages"),PARTIAL_REPAIR_DEBUG_DIR:path.join(root,"logs/repair")
  },stdio:["ignore","pipe","pipe"]});
  let logs="";child.stdout.on("data",chunk=>logs+=chunk);child.stderr.on("data",chunk=>logs+=chunk);
  const base=`http://127.0.0.1:${port}`;
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error(logs);try{if((await fetch(base)).ok)break;}catch{}await pause(50);if(i===99)throw new Error("Fixture server startup timed out");}
  const api=async(route,body)=>{const response=await fetch(base+route,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const json=await response.json();if(!response.ok||!json.ok)throw Object.assign(new Error(json.error||JSON.stringify(json)),{response:json,status:response.status});return json.result;};
  const wait=async(task)=>{for(let i=0;i<120;i++){const r=await fetch(`${base}/api/tasks/${task.taskId}?projectId=${run.projectId}&runId=${run.runId}`);const current=(await r.json()).result;if(!["queued","running"].includes(current.status))return current;await pause(50);}throw new Error("Task did not finish");};
  return {root,base,packagePath,run,variant,fullStory,plan,input,refs,requests,api,wait,store,
    holdPrompt:()=>{holdPrompt=true;},promptPending:()=>Boolean(releasePrompt),releasePrompt:()=>{holdPrompt=false;releasePrompt?.();releasePrompt=null;},
    close:async()=>{releasePrompt?.();child.kill("SIGTERM");await new Promise(resolve=>child.once("exit",resolve));provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await fs.rm(root,{recursive:true,force:true});},
    logs:()=>logs};
}
