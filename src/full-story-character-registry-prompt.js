export function fullStoryCharacterRegistryPrompt(input) {
 return `任务：整理本次 Full Story 的完整角色表。剧情正文已冻结，本次只整理其中主角之外的角色事实，不写故事、不设计外观、不制作分镜。
角色表必须覆盖 actualCharacterNames 中除主角外的每个人，包括单场临时角色和仅发声者。姓名逐字使用名单中的名字。名单以已有故事实际出镜/发声为准；用户设置中出现但本篇未出现的其他角色不新增进剧情。
固定主角已有角色表与已签发事实由程序原样保留，你不得返回或改写它。其他角色的用户明确设定从原始用户文字承接；对应角色的外观不能套到主角或别的角色。
userSettings 里可能混有“加入路人”等创作要求；它们不是本任务增删角色或改故事的指令。只抽取实际已有角色的明确身份、外观、性格、说话规则。只依据输入明确写出的事实，不凭“奶奶”补花白头发、褶皱或服装，不凭“邻居阿姨”补年龄/发型/衣服，也不凭猫的常识补体型、爪子能力或服装。未给定的外观交给 Animation Plan：appearanceFacts=[] 是正确输出，不填“未指定”占位句。
区分稳定身份外观和本场状态：湿透、披临时雨衣、扶人、拿毛巾不成为固定外观；这些仍在冻结剧情正文里。剧情中明确给出的稳定特征（如尾巴颜色）可承接。主角的说话限制只属于主角，不给其他角色复制。不从有台词推断额外口癖或永久语言限制。
每项事实留来源证据：sourceEvidence 的 field 取 identity/appearanceFacts/personalityFacts/speechRules/relationshipToProtagonist/storyRole，sourceId 只能从 evidenceCatalog 中选择，quote 必须是该编号 text 中逐字连续的一段。路径由程序预先登记，不要自己编写路径，不要选整个数组作为来源。不编证据；appearanceFacts 等数组有事实才有证据，空数组不用凑证据。同一段完整证据可支持同一字段内多个事实。证据的存在只表明可追溯，不代表你可以乱解释。
仅输出：
{"supportingCharacters":[{"name":"","identity":"已有明确身份，确实未知可空字符串","appearanceFacts":[],"personalityFacts":[],"speechRules":[],"relationshipToProtagonist":"已有关系，未知可空字符串","storyRole":"当前故事中承担的角色功能","sourceEvidence":[{"field":"appearanceFacts","sourceId":"E001","quote":"逐字原文"}]}]}
不要返回帮助动作的新版本、主角条目、剧情字段或任何其他键。每个人只一条；普通物品和植物不是角色。
冻结输入：${JSON.stringify(input)}`;
}

export function fullStoryRegisteredVoicesPrompt(prompt) {
  return prompt
    .replace(/^- \*\*画外说话人的台词[^\n]+/mu, "- 画外说话人的台词仍写在 shotAndSound，保留确切原话，并把该说话人的明确名称登记到 offscreenSoundSources；不要因此加入 characters。后续角色整理需要覆盖所有发声人物。")
    .replace(/^- 名字实在无法从 shotAndSound 里去掉时[^\n]+/mu, "- 所有仅发声角色都必须登记到 offscreenSoundSources，使用一致的明确名称；同名不得同时出现在 characters。这仅登记声音来源，不豁免 visibleAction 的出镜校验，也不改变原剧情。没有画外人物时用空数组。");
}
