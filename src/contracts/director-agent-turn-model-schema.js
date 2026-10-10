// 导演助手一轮回复发给模型做约束解码的 Schema（MiMo response_format: json_schema）。
// 与候选、评审同一个做法：从服务端严格 Schema 派生，不另写一份；严格 Schema 与
// 「编号必须在这一轮的动作清单里」那道核对仍是唯一裁决方（src/director-agent.js）。
//
// 只用在 MiMo 上实测过的关键字（type、properties、required、additionalProperties、enum、
// minLength，见 storyboard-design-model-schema.js 顶部）。pattern 不能发：MiMo 把它当成
// 全串匹配；maxLength 没实测过，长度上限留在服务端严格 Schema 里。
import { directorAgentTurnStrictSchema } from "./contract-validator.js";
import { DIRECTOR_AGENT_NO_ACTION } from "../../public/director-agent-actions.js";

export const DIRECTOR_AGENT_TURN_MODEL_SCHEMA_NAME = "director_agent_turn";

// 与 directorAgentTurnPrompt 输出模板同序：先定动作，再写回复。
export const DIRECTOR_AGENT_TURN_MODEL_FIELD_ORDER = Object.freeze(["actionKey", "reply"]);

// strictSchema 只供测试注入「结构变了的严格 Schema」，生产调用一律用默认值。
export function directorAgentTurnModelSchema(offeredKeys, strictSchema = directorAgentTurnStrictSchema()) {
  if (!Array.isArray(offeredKeys) || offeredKeys.some((key) => typeof key !== "string" || !key)) {
    throw new TypeError("导演助手模型 Schema 的动作清单必须是非空字符串数组");
  }
  const properties = strictSchema?.properties;
  const required = strictSchema?.required;
  if (!properties || !Array.isArray(required)
    || DIRECTOR_AGENT_TURN_MODEL_FIELD_ORDER.some((key) => !properties[key] || !required.includes(key))
    || Object.keys(properties).length !== DIRECTOR_AGENT_TURN_MODEL_FIELD_ORDER.length) {
    throw new Error("导演助手严格 Schema 的结构变了，模型 Schema 无法照旧派生；请同步修改 director-agent-turn-model-schema.js");
  }
  return {
    type: "object",
    additionalProperties: false,
    required: [...DIRECTOR_AGENT_TURN_MODEL_FIELD_ORDER],
    properties: {
      // 枚举就是这一轮的动作清单加 none：模型写不出清单外的编号。
      actionKey: { type: "string", enum: [...new Set([...offeredKeys, DIRECTOR_AGENT_NO_ACTION])] },
      reply: { type: "string", minLength: 1 }
    }
  };
}
