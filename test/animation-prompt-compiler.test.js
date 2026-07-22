import test from "node:test";
import assert from "node:assert/strict";
import {
  AnimationPromptCompilerError,
  COMPILED_ANIMATION_SHOT_ALIAS_FIELDS,
  compileAnimationShotPrompts,
  isStructuredAnimationShot,
  normalizeAnimationShotPrompts
} from "../src/animation-prompt-compiler.js";

function frame(overrides = {}) {
  return {
    timeAndWeather: "傍晚，晴",
    characters: [{
      name: "小白子",
      screenPosition: "画面左侧",
      bodyOrientation: "面向木箱",
      pose: "蹲姿",
      actionState: "双手扶住箱盖",
      handPropState: "右手接触箱盖，左手悬停",
      gaze: "看向箱内",
      emotionState: "好奇",
      expression: "睁大眼睛"
    }],
    environment: {
      sceneId: "LOC-BOX",
      foreground: "木箱边缘",
      midground: "小白子与木箱",
      background: "被夕阳照亮的阁楼",
      atmosphere: "细小浮尘"
    },
    camera: {
      shotSize: "中近景",
      height: "胸口高度",
      angle: "轻微俯拍",
      viewDirection: "从右向左",
      lensFeel: "自然透视",
      depthOfField: "浅景深",
      composition: "角色与木箱形成对角线"
    },
    lighting: {
      source: "窗外夕阳",
      direction: "右后方逆光",
      colorAndContrast: "暖橙色，中等反差"
    },
    styleModifiers: ["Q 版二维动画", "干净线条"],
    continuityLocks: ["猫耳与蓬松猫尾巴保持一致", "木箱位置不变"],
    ...overrides
  };
}

function motion(overrides = {}) {
  return {
    mode: "continuous_action",
    primaryAction: "小白子缓慢打开木箱",
    cameraMove: {
      mode: "continuous",
      technique: "缓慢推近",
      path: "沿镜头轴线前移",
      speed: "medium",
      motivation: "突出箱内发现"
    },
    emotionArc: {
      from: "谨慎",
      visibleProgression: "眉眼逐渐舒展",
      to: "惊喜"
    },
    environmentChange: "浮尘被箱盖带起",
    lightingChange: "箱内反射一线暖光",
    timingBeats: [{
      fromPercent: 0,
      toPercent: 100,
      action: "箱盖持续打开",
      camera: "持续推近",
      emotion: "由谨慎转为惊喜",
      environment: "浮尘缓慢上升",
      soundCue: "木轴轻响"
    }],
    audio: {
      dialogue: [],
      ambience: "阁楼微弱风声",
      soundEffects: ["木箱铰链声"],
      musicCue: "无"
    },
    preserve: ["角色身份不漂移", "木箱结构不变"],
    endStateRef: "endFrame",
    stopCondition: "箱盖完全打开时停止",
    postRetime: {
      recommended: false,
      speedCurve: "保持原速",
      reason: "动作节奏已经完整"
    },
    ...overrides
  };
}

function structuredShot(overrides = {}) {
  return {
    shotId: "A01",
    startFrame: frame(),
    endFrame: frame({
      characters: [{
        ...frame().characters[0],
        pose: "半蹲姿",
        actionState: "抬起已打开的箱盖",
        handPropState: "右手握住箱盖边缘，左手扶住木箱",
        gaze: "看向箱内玻璃片",
        emotionState: "惊喜",
        expression: "嘴角上扬"
      }],
      continuityLocks: ["猫耳与蓬松猫尾巴保持一致", "木箱已打开"]
    }),
    motion: motion(),
    ...overrides
  };
}

test("普通动作镜头按固定顺序编译八个兼容别名", () => {
  const aliases = compileAnimationShotPrompts(structuredShot());

  assert.deepEqual(Object.keys(aliases), COMPILED_ANIMATION_SHOT_ALIAS_FIELDS);
  assert.equal(
    aliases.startFramePrompt,
    "时间与天气：傍晚，晴。角色：小白子（画面位置：画面左侧；身体朝向：面向木箱；姿态：蹲姿；动作状态：双手扶住箱盖；手部与道具状态：右手接触箱盖，左手悬停；视线：看向箱内；情绪状态：好奇；表情：睁大眼睛）。环境：场景 ID：LOC-BOX；前景：木箱边缘；中景：小白子与木箱；背景：被夕阳照亮的阁楼；氛围：细小浮尘。镜头：景别：中近景；机位高度：胸口高度；角度：轻微俯拍；观察方向：从右向左；镜头质感：自然透视；景深：浅景深；构图：角色与木箱形成对角线。光线：光源：窗外夕阳；方向：右后方逆光；色彩与反差：暖橙色，中等反差。风格修饰：Q 版二维动画、干净线条。连续性锁定：猫耳与蓬松猫尾巴保持一致、木箱位置不变。"
  );
  assert.equal(aliases.characterAction, "小白子缓慢打开木箱");
  assert.equal(aliases.cameraMotion, "模式：连续运镜；技法：缓慢推近；路径：沿镜头轴线前移；速度：中速；动机：突出箱内发现");
  assert.equal(aliases.dialogueOrSubtitle, "");
  assert.match(aliases.videoPrompt, /^首帧是准确起点，尾帧是最终视觉目标，只生成两帧之间的连续变化。主动作：小白子缓慢打开木箱。/u);
  assert.match(aliases.videoPrompt, /停止条件：箱盖完全打开时停止。$/u);
  assert.doesNotMatch(aliases.videoPrompt, /continuous_action|endFrame|后期变速|保持原速/u);
  assert.equal(
    aliases.continuityNotes,
    "首帧锁定：猫耳与蓬松猫尾巴保持一致、木箱位置不变。尾帧锁定：猫耳与蓬松猫尾巴保持一致、木箱已打开。运动过程保持：角色身份不漂移、木箱结构不变。尾帧目标：严格达到结构化尾帧状态。停止条件：箱盖完全打开时停止。"
  );
});

test("连续环绕镜头保留明确路径与节拍，但不下发后期变速指导", () => {
  const shot = structuredShot({
    motion: motion({
      mode: "camera_move",
      primaryAction: "小白子举起玻璃幻灯片保持不动",
      cameraMove: {
        mode: "continuous",
        technique: "环绕",
        path: "从角色左前方顺时针绕至右后方 120 度",
        speed: "medium",
        motivation: "展示玻璃片透光变化"
      },
      timingBeats: [
        { fromPercent: 0, toPercent: 45, action: "保持举片", camera: "缓慢环绕", emotion: "专注", environment: "夕阳稳定", soundCue: "轻风" },
        { fromPercent: 45, toPercent: 100, action: "手腕微调", camera: "加速绕至右后方", emotion: "发现图案", environment: "玻璃片亮起", soundCue: "短促铃音" }
      ],
      postRetime: { recommended: true, speedCurve: "45% 后加速至 1.25x", reason: "强化发现时刻" }
    })
  });

  const aliases = compileAnimationShotPrompts(shot);
  assert.equal(aliases.cameraMotion, "模式：连续运镜；技法：环绕；路径：从角色左前方顺时针绕至右后方 120 度；速度：中速；动机：展示玻璃片透光变化");
  assert.match(aliases.videoPrompt, /时间节拍：0%–45%（动作：保持举片；镜头：缓慢环绕；情绪：专注；环境：夕阳稳定；声音：轻风）；45%–100%（动作：手腕微调；镜头：加速绕至右后方；情绪：发现图案；环境：玻璃片亮起；声音：短促铃音）/u);
  assert.match(aliases.videoPrompt, /停止条件：箱盖完全打开时停止。$/u);
  Object.values(aliases).forEach((value) => {
    assert.doesNotMatch(value, /camera_move|后期变速|1\.25x|强化发现时刻/u);
  });
});

test("物体变形镜头只编译显式首尾状态与变化描述", () => {
  const shot = structuredShot({
    startFrame: frame({
      characters: [],
      environment: { sceneId: "LOC-TABLE", foreground: "完整纸鹤", midground: "空桌面", background: "灰墙", atmosphere: "静止" },
      continuityLocks: ["纸鹤为单个完整物体"]
    }),
    endFrame: frame({
      characters: [],
      environment: { sceneId: "LOC-TABLE", foreground: "展开的方形纸", midground: "空桌面", background: "灰墙", atmosphere: "静止" },
      continuityLocks: ["纸张材质和颜色不变"]
    }),
    motion: motion({
      mode: "object_transform",
      primaryAction: "纸鹤沿既有折痕逐步展开成方形纸",
      environmentChange: "仅纸鹤形态改变，桌面不变",
      lightingChange: "无变化",
      endStateRef: "endFrame",
      stopCondition: "四角完全展平后停止",
      preserve: ["纸张材质不变", "纸张颜色不变"]
    })
  });

  const aliases = compileAnimationShotPrompts(shot);
  assert.match(aliases.startFramePrompt, /前景：完整纸鹤/u);
  assert.match(aliases.endFramePrompt, /前景：展开的方形纸/u);
  assert.match(aliases.videoPrompt, /主动作：纸鹤沿既有折痕逐步展开成方形纸/u);
  assert.match(aliases.videoPrompt, /环境变化：仅纸鹤形态改变，桌面不变。光线变化：无变化/u);
  assert.match(aliases.continuityNotes, /尾帧目标：严格达到结构化尾帧状态。停止条件：四角完全展平后停止/u);
  assert.doesNotMatch(aliases.videoPrompt, /折叠方式|自动补全|推测/u);
});

test("对白与声音分别编译到 dialogueOrSubtitle 和 soundDesign", () => {
  const shot = structuredShot({
    motion: motion({
      audio: {
        dialogue: [
          { speaker: "小白子", text: "嗷呜", delivery: "轻声、惊喜" },
          { speaker: "旁白", text: "旧照片亮了起来", delivery: "平静" }
        ],
        ambience: "阁楼风声",
        soundEffects: ["玻璃轻碰声", "木板吱呀声"],
        musicCue: "弦乐在 70% 处进入"
      },
      timingBeats: [
        { fromPercent: 0, toPercent: 70, action: "举起玻璃片", camera: "推近", emotion: "期待", environment: "尘埃上升", soundCue: "玻璃轻碰声" },
        { fromPercent: 70, toPercent: 100, action: "保持", camera: "停住", emotion: "惊喜", environment: "光斑出现", soundCue: "弦乐进入" }
      ]
    })
  });

  const aliases = compileAnimationShotPrompts(shot);
  assert.equal(aliases.dialogueOrSubtitle, "小白子：“嗷呜”（轻声、惊喜）；旁白：“旧照片亮了起来”（平静）");
  assert.equal(
    aliases.soundDesign,
    "环境声：阁楼风声；音效：玻璃轻碰声、木板吱呀声；音乐提示：弦乐在 70% 处进入；分段声音：0%–70%：玻璃轻碰声；70%–100%：弦乐进入"
  );
  assert.match(aliases.videoPrompt, /对白：小白子：“嗷呜”（轻声、惊喜）；旁白：“旧照片亮了起来”（平静）/u);
});

test("v2 镜头拒绝任何与确定性编译结果不一致的既有别名", () => {
  const shot = structuredShot();
  const compiled = compileAnimationShotPrompts(shot);
  const normalized = normalizeAnimationShotPrompts({ ...shot, ...compiled }, { promptSchemaVersion: "2.0" });

  assert.notEqual(normalized, shot);
  assert.deepEqual(
    COMPILED_ANIMATION_SHOT_ALIAS_FIELDS.map((field) => normalized[field]),
    COMPILED_ANIMATION_SHOT_ALIAS_FIELDS.map((field) => compiled[field])
  );

  assert.throws(
    () => normalizeAnimationShotPrompts(
      { ...shot, videoPrompt: `${compiled.videoPrompt} 模型自行补充的运镜。` },
      "2.0"
    ),
    (error) => {
      assert.ok(error instanceof AnimationPromptCompilerError);
      assert.equal(error.details.field, "videoPrompt");
      assert.equal(error.details.shotId, "A01");
      assert.equal(error.details.compiled, compiled.videoPrompt);
      return true;
    }
  );
});

test("只有顶层版本为 2.0 才按结构化镜头处理，旧镜头保持同一对象原样透传", () => {
  const legacy = {
    shotId: "A99",
    startFramePrompt: "旧首帧自由文本",
    endFramePrompt: "旧尾帧自由文本",
    videoPrompt: "旧视频提示词",
    cameraMotion: "旧运镜"
  };

  assert.equal(isStructuredAnimationShot(structuredShot(), { promptSchemaVersion: "2.0" }), true);
  assert.equal(isStructuredAnimationShot(structuredShot(), " 2.0 "), true);
  assert.equal(isStructuredAnimationShot(structuredShot(), { promptSchemaVersion: "1.0" }), false);
  assert.equal(isStructuredAnimationShot(structuredShot()), false);
  assert.equal(normalizeAnimationShotPrompts(legacy, { promptSchemaVersion: "1.0" }), legacy);
  assert.equal(normalizeAnimationShotPrompts(legacy), legacy);
  assert.deepEqual(legacy, {
    shotId: "A99",
    startFramePrompt: "旧首帧自由文本",
    endFramePrompt: "旧尾帧自由文本",
    videoPrompt: "旧视频提示词",
    cameraMotion: "旧运镜"
  });
});
