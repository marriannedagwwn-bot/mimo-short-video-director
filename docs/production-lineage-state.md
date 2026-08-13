# Production Lineage 与持久状态契约

## 1. 解决的问题

该机制解决的是“哪个结果属于哪一版输入”，不是判断模型写出的角色、动作或镜头语义是否正确。

- 角色是否越过 `fixedCharacterBoundary`，仍由现有 Guardrails、Schema 和语义 validation 负责。
- Production Lineage 负责阻止“新 Story + 旧 Animation Plan”“新 Plan + 旧视频”“旧异步响应覆盖新结果”和“不可信导入包与当前状态混合”。

lineage 是服务端确定性签发的 sidecar。任何 LLM 都不能生成、补写或修改 revision、digest、dependency 或 media namespace。

## 2. 身份与冻结点

浏览器每次从视频输入运行主流程时创建一个 Run：

```text
projectId
└── runId
    ├── Stage 状态
    ├── Artifact revisions
    └── Checkpoint
```

每个 Artifact 成功提交就是一个数据冻结点。服务端对 canonical JSON 计算 SHA-256；对象键顺序不影响摘要，数组顺序和真实值变化会影响摘要。同一 artifact 的不同内容使用单调 revision，例如 `fullStory-V1-r2`。

公开 lineage 最小结构：

```json
{
  "schemaVersion": "1.0",
  "artifactId": "animationPlan:V1",
  "artifactType": "animationPlan",
  "revision": "animationPlan-V1-r2",
  "contentDigest": "<sha256>",
  "dependencies": [
    {
      "artifactId": "fullStory:V1",
      "revision": "fullStory-V1-r3",
      "contentDigest": "<sha256>"
    }
  ],
  "status": "current",
  "mediaNamespace": "<project>/<run>/<plan-revision>-<digest-prefix>"
}
```

## 3. 当前依赖图

```text
referenceAnalysis
  └─ sourceScriptReconstruction
      └─ creativeBrief
          └─ visualGuardrails
              └─ themeVariants
                  └─ variant:<variantId>

referenceAnalysis + reconstruction + brief + guardrails
  + themeVariants + selected variant
      └─ fullStory:<variantId>

referenceAnalysis + reconstruction + brief + guardrails
  + selected variant + full story
      └─ animationPlan:<variantId>
          ├─ characterImages:<variantId>:<roleIndex>
          ├─ shotFrame:<variantId>:<shotId>:<kind>（旧 v2）
          └─ shotVideo:<variantId>:<shotId>
              └─ shotVideo:<variantId>:<nextShotId>（仅显式使用上一镜抽帧时）
```

依赖记录的是实际 revision/digest，不只是 `variant.id` 或 `shotId`。上游提交新 revision 后，仍引用旧 revision 的所有下游 Artifact 会递归变为 `stale`。

默认每个 `shotVideo` 只依赖当前 Animation Plan。若某镜请求显式使用 `continuityReferenceMode=previous_shot_frames`，它还必须依赖 Plan 顺序中紧邻上一镜的 current `shotVideo` 精确 revision/digest；服务端回执提供该 source lineage，浏览器提交媒体 Artifact 时冻结它。上一镜重生成或切换候选会签发新 revision，并递归使所有引用旧 revision 的后镜视频 stale。切换后镜自己的候选只是更新同一媒体 Artifact，必须原样保留已有依赖，不能退回为只依赖 Plan。

浏览器恢复和运行时缓存必须按 `variantId + shotId`（旧 v2 帧再加 `frameKind`）区分媒体结果。服务端只将具体下游 Artifact 标为 stale 时，前端只移除对应缓存项；不得清空其他 Variant、上一镜或同 Plan 内仍为 current 的媒体结果。

## 4. 异步请求规则

模型调用开始前，浏览器冻结：

- `projectId` / `runId`
- 目标 `artifactId`
- `requestId`
- `expectedCurrentRevision`
- 完整上游 dependency revisions

模型返回后先检查浏览器内 request token；提交时服务端再检查目标 revision 与所有依赖是否仍为 current。较新的请求、Story 或 Plan 已经出现时，旧响应必须明确失败，不能选择任一版本静默覆盖。

合法反例：JSON 对象只调整键顺序时 digest 不变，应复用当前 revision。非法串线：Variant 仍叫 `V1`，但标题、角色或剧情内容已变化时 digest 必须变化，旧 Story/Plan 不能继续使用。

## 5. 媒体隔离

Animation Plan 每个 revision 都获得唯一 `mediaNamespace`：

```text
<projectId>/<runId>/<planRevision>-<planDigestPrefix>
```

角色图片、旧 v2 镜头帧和视频请求必须携带当前 Plan lineage。服务端在调用 provider 前核对它仍为 current，并将产物写到：

```text
public/generated-images/<mediaNamespace>/
public/generated-videos/<mediaNamespace>/
```

文件名也带 Plan revision 和 digest 前缀。远端生成期间 Plan 若更新，旧任务可能仍在旧目录完成，但前端会拒绝把结果挂到新 Plan。

上一镜抽帧不信任浏览器提交的绝对路径或任意 URL。服务端根据当前 Plan 的 `shotPlan[]` 顺序导出 source shot，读取同一 Run 中 current `shotVideo` Artifact 的选中候选，只把当前 `public/generated-videos/<mediaNamespace>/` 单层目录内、文件名前缀同时绑定当前 Plan 和 source shotId 的普通 mp4 映射回本地文件。旧 namespace、远程 URL、路径穿越、子目录、符号链接和缺失文件必须明确拒绝。通过路径校验后仍须以 `O_NOFOLLOW` 文件句柄读取并冻结到任务私有目录，抽帧回执记录实际读取源字节及各 JPEG 的 SHA-256，避免路径校验与 FFmpeg 打开之间的文件替换使 lineage 与实际输入脱钩。

## 6. Run、Stage、Artifact 与 Checkpoint

默认状态根目录为 `runtime/production-runs/`，可通过服务端环境变量 `WORKFLOW_PRODUCTION_STATE_DIR` 修改。每个 Run 的 manifest 记录：

- Run 元数据和状态；
- Stage 的 `running` / `completed` / `failed` / `stale`；
- Artifact revision、digest、dependencies 和状态；
- 单调 Checkpoint sequence；
- 有界事件记录。

Artifact 内容独立写入原子替换的 JSON 文件。浏览器只在服务端提交成功后更新页面主状态。刷新页面时通过 localStorage 中的 project/run 指针读取最近 checkpoint，只恢复 `current` Artifact。

当前恢复边界：

- 不持久化原始上传视频、浏览器 Object URL 或抽帧源文件；
- 不接管刷新前尚未完成的 provider 请求；
- 不提供跨机器共享存储、任务队列或多用户权限；
- 已完成的 Story、Plan 和已登记媒体可以恢复并继续下游操作。

## 7. v3 测试/规划包

导出流程由服务端确认选中 Variant、Full Story 和可选 Animation Plan 都是当前 Artifact，且 parent lineage 一致，然后添加：

- `packageType: story-production-test-package`
- `packageVersion: 3.0`
- `productionLineage`
- `packageDigest`
- `packageSignature`

签名密钥保存在状态根目录，只代表当前安装实例的本地信任。导入必须依次验证 type、version、digest、HMAC、各 Artifact digest、Variant ID 和 parent lineage。验证成功后建立新的 project/run，重新签发本地 revisions；禁止与浏览器现态 merge，并清空包内媒体选择。

因此 v3 文件是可验证的本地测试/规划包，但不是包含供应商任务状态、跨环境证书链、批量调度和完整 canonical provenance 的最终 Production Package。
