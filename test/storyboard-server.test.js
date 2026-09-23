import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createStoryboardRuntime } from "./helpers/storyboard-runtime.js";

test("真实 HTTP / Durable Task：旧剧情生成新版分镜、单镜提示词独立签发与过期阻断", async () => {
  const runtime=await createStoryboardRuntime();
  try {
    const {api,wait,run,variant,requests}=runtime;
    const created=await api("/api/tasks/create",{...run,kind:"animationPlan",input:{variantId:variant.id,creatorProfile:runtime.input.creatorProfile,animationPlanVersion:"4.0",targetAspectRatio:"16:9",backgroundMusicEnabled:false}});
    const task=await wait(created.task);assert.equal(task.status,"completed",JSON.stringify(task.error));
    const state=await api("/api/production/run/load",{...run,includeContent:true});
    const entry=state.latestArtifacts[`animationPlan:${variant.id}`];
    assert.equal(entry.content.promptSchemaVersion,"4.0");assert.equal(requests.length,3);
    assert.deepEqual(state.latestArtifacts[`fullStory:${variant.id}`].content,runtime.fullStory);
    assert.equal(state.latestArtifacts[`fullStory:${variant.id}`].lineage.contentDigest,runtime.refs[`fullStory:${variant.id}`].contentDigest);
    const productionContext={projectId:run.projectId,runId:run.runId,planArtifactId:entry.lineage.artifactId,
      planRevision:entry.lineage.revision,planDigest:entry.lineage.contentDigest,mediaNamespace:entry.lineage.mediaNamespace};
    const promptInput={variantId:variant.id,shotId:"A01",productionContext,videoProvider:"Seedance",videoModel:"doubao-seedance-2-0-260128"};
    const promptCreated=await api("/api/tasks/create",{...run,kind:"shotVideoPrompt",input:promptInput});
    const promptTask=await wait(promptCreated.task);assert.equal(promptTask.status,"completed",JSON.stringify(promptTask.error));assert.equal(requests.length,4);
    const updated=await api("/api/production/run/load",{...run,includeContent:true});
    const prompt=updated.latestArtifacts[`shotVideoPrompt:${variant.id}:A01`];
    assert.equal(prompt.content.planDigest,entry.lineage.contentDigest);
    assert.equal(updated.latestArtifacts[`animationPlan:${variant.id}`].lineage.revision,entry.lineage.revision);
    assert.ok(prompt.lineage.dependencies.some(ref=>ref.contentDigest===entry.lineage.contentDigest));
    await assert.rejects(()=>api("/api/tasks/create",{...run,kind:"shotVideoPrompt",input:{...promptInput,productionContext:{...productionContext,planDigest:"0".repeat(64)}}}));
    assert.equal(requests.length,4);
    const persisted=await fs.readFile(path.join(runtime.root,"state",run.projectId,run.runId,"tasks/index.json"),"utf8");
    assert.equal(persisted.includes(prompt.content.videoPrompt),false);
    assert.equal(persisted.includes("任务：将完整 Full Story"),false);
    await assert.rejects(()=>api("/api/tasks/create",{...run,kind:"shotVideoBatch",input:{...promptInput}}),/逐镜/);
    runtime.holdPrompt();
    const delayed=await api("/api/tasks/create",{...run,kind:"shotVideoPrompt",input:{...promptInput,videoModel:"doubao-seedance-2-0-fast-260128"}});
    for(let i=0;i<100&&!runtime.promptPending();i++) await new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(runtime.promptPending());
    await api("/api/production/artifact/commit",{...run,artifactId:entry.lineage.artifactId,artifactType:"animationPlan",
      expectedCurrentRevision:entry.lineage.revision,requestId:"fixture-plan-change",dependencies:entry.lineage.dependencies,
      content:{...entry.content,title:"协议测试：新版分镜"},createMediaNamespace:true});
    runtime.releasePrompt();
    const conflicted=await wait(delayed.task);assert.equal(conflicted.status,"conflicted",JSON.stringify(conflicted.error));
    const final=await api("/api/production/run/load",{...run,includeContent:true});
    assert.equal(final.latestArtifacts[`shotVideoPrompt:${variant.id}:A01`].lineage.status,"stale");
  } finally { await runtime.close(); }
});
