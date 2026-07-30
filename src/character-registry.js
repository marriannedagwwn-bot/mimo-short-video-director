import { randomUUID } from "node:crypto";
import { canonicalize } from "./frame-dependency.js";
import { CharacterRegistryError } from "./cast-errors.js";
import {
  automaticUsageConstraints,
  confirmedUsageConstraints
} from "./cast-proposal.js";

const SYSTEM_SLOT_IDS = Object.freeze({
  protagonist: "character:system:protagonist",
  "care-recipient": "character:system:care-recipient",
  narrator: "character:system:narrator"
});
const DECLARATION_KEYS = new Set([
  "systemSlot",
  "declarationId",
  "sourceIdentifier",
  "bindingRef",
  "displayName",
  "aliases",
  "entityClass"
]);

export class CharacterRegistryStore {
  constructor({
    idFactory = () => randomUUID(),
    registryId = ""
  } = {}) {
    this.idFactory = typeof idFactory === "function" ? idFactory : () => randomUUID();
    this.registryId = registryId || `registry:${this.idFactory()}`;
    this.bindings = new Map();
    this.retiredCharacterIds = new Set();
    this.activeCharacterIds = new Set();
    this.revision = 0;
    this.snapshotKey = "";
    this.snapshot = null;
  }

  reconcile({
    declarations = [],
    approvedRoles = [],
    proposalBindingNamespace = ""
  } = {}) {
    const validatedDeclarations = validateDeclarations(declarations);
    const validatedApprovals = validateApprovals(approvedRoles);
    const nextBindings = new Map(this.bindings);
    const reservedIds = new Set([
      ...nextBindings.values(),
      ...this.retiredCharacterIds,
      ...Object.values(SYSTEM_SLOT_IDS)
    ]);
    const entries = [];
    const declarationKeyOwners = new Map();

    validatedDeclarations.forEach((declaration, index) => {
      const binding = resolveDeclarationBinding({
        declaration,
        index,
        bindings: nextBindings,
        reservedIds,
        idFactory: this.idFactory,
        declarationKeyOwners
      });
      entries.push(declarationEntry(declaration, binding));
    });

    validatedApprovals.forEach(({ role, policy }, index) => {
      const namespace = String(proposalBindingNamespace || "unscoped");
      const key = `proposal:${namespace}:${role.proposalRef}`;
      const characterId = resolveServerBoundId({
        key,
        bindings: nextBindings,
        reservedIds,
        idFactory: this.idFactory
      });
      entries.push(proposalEntry(role, policy, characterId, index));
    });

    validateUniqueCharacterIds(entries);
    validateAliasAndDeclarationConflicts(entries);
    entries.sort((left, right) => left.characterId.localeCompare(right.characterId));

    const nextActiveIds = new Set(entries.map((entry) => entry.characterId));
    const nextRetired = new Set(this.retiredCharacterIds);
    for (const characterId of this.activeCharacterIds) {
      if (!nextActiveIds.has(characterId)) nextRetired.add(characterId);
    }
    for (const characterId of nextActiveIds) nextRetired.delete(characterId);

    const contentKey = canonicalize({
      entries,
      retiredCharacterIds: [...nextRetired].sort()
    });
    if (this.snapshot && contentKey === this.snapshotKey) {
      return structuredClone(this.snapshot);
    }

    this.bindings = nextBindings;
    this.retiredCharacterIds = nextRetired;
    this.activeCharacterIds = nextActiveIds;
    this.revision += 1;
    this.snapshotKey = contentKey;
    this.snapshot = {
      schemaVersion: "character-registry/v1",
      registryId: this.registryId,
      revision: this.revision,
      frozen: true,
      entries,
      retiredCharacterIds: [...nextRetired].sort()
    };
    return structuredClone(this.snapshot);
  }
}

export function validateDeclarations(declarations) {
  if (!Array.isArray(declarations)) {
    throw registryError(
      "Character declarations 必须是数组",
      "REGISTRY_DECLARATIONS_INVALID"
    );
  }
  return declarations.map((source, index) => {
    const path = `/declarations/${index}`;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw registryError(`${path} 必须是对象`, "REGISTRY_DECLARATION_INVALID", path);
    }
    const unknown = Object.keys(source).filter((key) => !DECLARATION_KEYS.has(key));
    if (unknown.length) {
      throw registryError(
        `${path} 包含未知字段：${unknown.join("、")}`,
        "REGISTRY_DECLARATION_UNKNOWN_FIELD",
        `${path}/${escapeJsonPointerToken(unknown[0])}`
      );
    }
    const systemSlot = optionalBoundedString(source.systemSlot, `${path}/systemSlot`, 64);
    if (systemSlot && !(systemSlot in SYSTEM_SLOT_IDS)) {
      throw registryError(
        `${path}/systemSlot 不在固定系统槽位中`,
        "REGISTRY_SYSTEM_SLOT_INVALID",
        `${path}/systemSlot`
      );
    }
    const declarationId = optionalBoundedString(source.declarationId, `${path}/declarationId`, 128);
    const sourceIdentifier = optionalBoundedString(source.sourceIdentifier, `${path}/sourceIdentifier`, 256);
    const bindingRef = optionalBoundedString(source.bindingRef, `${path}/bindingRef`, 160);
    const displayName = requiredBoundedString(source.displayName, `${path}/displayName`, 120);
    const aliases = validateAliases(source.aliases || [], `${path}/aliases`);
    const entityClass = optionalBoundedString(source.entityClass, `${path}/entityClass`, 64)
      || "persistent-character";
    return {
      systemSlot,
      declarationId,
      sourceIdentifier,
      bindingRef,
      displayName,
      aliases,
      entityClass
    };
  });
}

function validateApprovals(approvedRoles) {
  if (!Array.isArray(approvedRoles)) {
    throw registryError("approvedRoles 必须是数组", "REGISTRY_APPROVALS_INVALID");
  }
  return approvedRoles.map((approval, index) => {
    if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
      throw registryError(
        `/approvedRoles/${index} 必须是对象`,
        "REGISTRY_APPROVAL_INVALID",
        `/approvedRoles/${index}`
      );
    }
    const role = approval.role;
    const policy = approval.policy;
    if (!role || typeof role !== "object" || !String(role.proposalRef || "").trim()) {
      throw registryError(
        `/approvedRoles/${index}/role 无效`,
        "REGISTRY_APPROVAL_INVALID",
        `/approvedRoles/${index}/role`
      );
    }
    if (!policy || !["automatic", "user-confirmed"].includes(policy.approvalMode)) {
      throw registryError(
        `/approvedRoles/${index}/policy 无效`,
        "REGISTRY_APPROVAL_INVALID",
        `/approvedRoles/${index}/policy`
      );
    }
    return { role: structuredClone(role), policy: structuredClone(policy) };
  });
}

function resolveDeclarationBinding({
  declaration,
  index,
  bindings,
  reservedIds,
  idFactory,
  declarationKeyOwners
}) {
  const path = `/declarations/${index}`;
  const keys = declarationBindingKeys(declaration);
  for (const key of keys) {
    const owner = declarationKeyOwners.get(key);
    if (owner !== undefined) {
      throw registryError(
        `${path} 与 /declarations/${owner} 使用了相同稳定标识`,
        declarationKeyConflictCode(key),
        path
      );
    }
    declarationKeyOwners.set(key, index);
  }

  const boundIds = [...new Set(keys.map((key) => bindings.get(key)).filter(Boolean))];
  if (boundIds.length > 1) {
    throw registryError(
      `${path} 的 declarationId/sourceIdentifier/bindingRef 指向不同已有角色`,
      "REGISTRY_IDENTITY_BINDING_CONFLICT",
      path
    );
  }

  let idSource;
  let characterId;
  let bindingRef = declaration.bindingRef;
  if (declaration.systemSlot) {
    idSource = "system-slot";
    characterId = SYSTEM_SLOT_IDS[declaration.systemSlot];
    if (boundIds.length && boundIds[0] !== characterId) {
      throw registryError(
        `${path} 的固定系统槽位与已有绑定冲突`,
        "REGISTRY_IDENTITY_BINDING_CONFLICT",
        path
      );
    }
  } else if (boundIds.length) {
    characterId = boundIds[0];
    idSource = declaration.declarationId
      ? "declaration-id"
      : declaration.sourceIdentifier ? "source-identifier" : "server-uuid";
  } else if (declaration.declarationId) {
    idSource = "declaration-id";
    characterId = `character:declaration:${encodeStableIdentifier(declaration.declarationId)}`;
  } else if (declaration.sourceIdentifier) {
    idSource = "source-identifier";
    characterId = `character:source:${encodeStableIdentifier(declaration.sourceIdentifier)}`;
  } else {
    idSource = "server-uuid";
    const generated = uniqueUuid(idFactory, reservedIds);
    characterId = `character:uuid:${generated}`;
    bindingRef = bindingRef || `binding:${generated}`;
  }

  if (reservedIds.has(characterId) && !boundIds.includes(characterId)
    && !Object.values(SYSTEM_SLOT_IDS).includes(characterId)) {
    throw registryError(
      `${path} 解析出已被保留的 characterId`,
      "REGISTRY_CHARACTER_ID_COLLISION",
      path
    );
  }
  reservedIds.add(characterId);
  for (const key of declarationBindingKeys({ ...declaration, bindingRef })) {
    const existing = bindings.get(key);
    if (existing && existing !== characterId) {
      throw registryError(
        `${path} 的稳定标识与已有角色冲突`,
        "REGISTRY_IDENTITY_BINDING_CONFLICT",
        path
      );
    }
    bindings.set(key, characterId);
  }
  return { characterId, idSource, bindingRef };
}

function resolveServerBoundId({ key, bindings, reservedIds, idFactory }) {
  const existing = bindings.get(key);
  if (existing) return existing;
  const generated = uniqueUuid(idFactory, reservedIds);
  const characterId = `character:uuid:${generated}`;
  bindings.set(key, characterId);
  reservedIds.add(characterId);
  return characterId;
}

function declarationEntry(declaration, binding) {
  return {
    characterId: binding.characterId,
    idSource: binding.idSource,
    systemSlot: declaration.systemSlot || null,
    declarationId: declaration.declarationId || null,
    sourceIdentifier: declaration.sourceIdentifier || null,
    bindingRef: binding.idSource === "server-uuid" ? binding.bindingRef : null,
    displayName: declaration.displayName,
    aliases: declaration.aliases,
    entityClass: declaration.entityClass,
    approvalMode: "declared",
    isEphemeral: false,
    maxSceneCount: null,
    maxDialogueLines: null,
    maxDialogueCodePoints: null,
    allowedNarrativeImportance: ["ambient", "functional", "supporting", "key"],
    allowCloseUp: true,
    allowPersistentRelationship: true,
    allowReferenceAsset: true,
    assetPolicy: "allowed",
    proposalRef: null
  };
}

function proposalEntry(role, policy, characterId) {
  const constraints = policy.approvalMode === "automatic"
    ? automaticUsageConstraints(role)
    : confirmedUsageConstraints(role);
  return {
    characterId,
    idSource: "server-uuid",
    systemSlot: null,
    declarationId: null,
    sourceIdentifier: null,
    bindingRef: null,
    displayName: role.proposedDisplayName,
    aliases: [...role.proposedAliases],
    entityClass: role.entityClass,
    ...constraints,
    proposalRef: role.proposalRef
  };
}

function validateUniqueCharacterIds(entries) {
  const seen = new Map();
  entries.forEach((entry, index) => {
    const first = seen.get(entry.characterId);
    if (first !== undefined) {
      throw registryError(
        `Registry entries ${first} 和 ${index} 解析为相同 characterId`,
        "REGISTRY_CHARACTER_ID_CONFLICT",
        `/entries/${index}/characterId`
      );
    }
    seen.set(entry.characterId, index);
  });
}

function validateAliasAndDeclarationConflicts(entries) {
  const identityOwners = new Map();
  const declarationOwners = new Map();
  entries.forEach((entry, index) => {
    if (entry.declarationId) {
      const normalized = normalizeIdentityTerm(entry.declarationId);
      const existing = declarationOwners.get(normalized);
      if (existing !== undefined && existing !== index) {
        throw registryError(
          `declarationId「${entry.declarationId}」重复`,
          "REGISTRY_DECLARATION_ID_CONFLICT",
          `/entries/${index}/declarationId`
        );
      }
      declarationOwners.set(normalized, index);
    }
  });

  entries.forEach((entry, index) => {
    const terms = [entry.displayName, ...entry.aliases];
    const localTerms = new Set();
    terms.forEach((term, termIndex) => {
      const normalized = normalizeIdentityTerm(term);
      if (localTerms.has(normalized)) return;
      localTerms.add(normalized);
      const declarationOwner = declarationOwners.get(normalized);
      if (declarationOwner !== undefined && declarationOwner !== index) {
        throw registryError(
          `alias/displayName「${term}」与另一角色 declarationId 冲突`,
          "REGISTRY_ALIAS_DECLARATION_ID_CONFLICT",
          `/entries/${index}/${termIndex === 0 ? "displayName" : `aliases/${termIndex - 1}`}`
        );
      }
      const existing = identityOwners.get(normalized);
      if (existing !== undefined && existing !== index) {
        throw registryError(
          `alias/displayName「${term}」被多个角色使用`,
          "REGISTRY_ALIAS_CONFLICT",
          `/entries/${index}/${termIndex === 0 ? "displayName" : `aliases/${termIndex - 1}`}`
        );
      }
      identityOwners.set(normalized, index);
    });
  });
}

function declarationBindingKeys(declaration) {
  return [
    declaration.systemSlot ? `system:${declaration.systemSlot}` : "",
    declaration.declarationId ? `declaration:${declaration.declarationId}` : "",
    declaration.sourceIdentifier ? `source:${declaration.sourceIdentifier}` : "",
    declaration.bindingRef ? `server-binding:${declaration.bindingRef}` : ""
  ].filter(Boolean);
}

function declarationKeyConflictCode(key) {
  if (key.startsWith("declaration:")) return "REGISTRY_DECLARATION_ID_CONFLICT";
  if (key.startsWith("source:")) return "REGISTRY_SOURCE_IDENTIFIER_CONFLICT";
  if (key.startsWith("system:")) return "REGISTRY_SYSTEM_SLOT_CONFLICT";
  return "REGISTRY_BINDING_REF_CONFLICT";
}

function encodeStableIdentifier(value) {
  return Buffer.from(String(value), "utf8").toString("base64url");
}

function uniqueUuid(idFactory, reservedIds) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = String(idFactory() || "").trim();
    if (!candidate) continue;
    if (!reservedIds.has(`character:uuid:${candidate}`)) return candidate;
  }
  throw registryError(
    "无法生成唯一 characterId",
    "REGISTRY_CHARACTER_ID_EXHAUSTED"
  );
}

function validateAliases(value, path) {
  if (!Array.isArray(value)) {
    throw registryError(`${path} 必须是数组`, "REGISTRY_ALIASES_INVALID", path);
  }
  return value.map((alias, index) => requiredBoundedString(alias, `${path}/${index}`, 120));
}

function requiredBoundedString(value, path, maxLength) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || Array.from(normalized).length > maxLength) {
    throw registryError(
      `${path} 必须是 1-${maxLength} code points 的字符串`,
      "REGISTRY_FIELD_INVALID",
      path
    );
  }
  return normalized;
}

function optionalBoundedString(value, path, maxLength) {
  if (value === undefined || value === null || value === "") return "";
  return requiredBoundedString(value, path, maxLength);
}

function normalizeIdentityTerm(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("und");
}

function registryError(message, code, path = "") {
  return new CharacterRegistryError(message, {
    code,
    details: path ? [{ code, path, message }] : []
  });
}

function escapeJsonPointerToken(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}
