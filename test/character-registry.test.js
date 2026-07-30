import test from "node:test";
import assert from "node:assert/strict";
import { CharacterRegistryError } from "../src/cast-errors.js";
import { CharacterRegistryStore } from "../src/character-registry.js";
import {
  automaticUsageConstraints,
  evaluateCastProposalPolicy
} from "../src/cast-proposal.js";

function declaration(overrides = {}) {
  return {
    displayName: "角色",
    aliases: [],
    entityClass: "persistent-character",
    ...overrides
  };
}

function role(overrides = {}) {
  return {
    proposalRef: "cast-proposal-1",
    entityClass: "single-scene-functional",
    identityMode: "generic-label",
    proposedDisplayName: "快递员",
    proposedAliases: [],
    scopePolicy: "scene-limited",
    maxSceneCount: 1,
    narrativeImportance: "functional",
    relationshipMode: "transient",
    dialoguePolicy: "one-functional-line",
    shotEmphasis: "normal",
    continuityRequired: false,
    requiresReferenceAsset: false,
    sceneHint: "送包裹",
    ...overrides
  };
}

function registryStore() {
  let counter = 0;
  return new CharacterRegistryStore({
    registryId: "registry:test",
    idFactory: () => `uuid-${++counter}`
  });
}

function byName(registry, displayName) {
  return registry.entries.find((entry) => entry.displayName === displayName);
}

test("Character ID 按系统槽位、declarationId、source identifier、持久 binding 顺序签发", () => {
  const store = registryStore();
  const registry = store.reconcile({
    declarations: [
      declaration({
        systemSlot: "protagonist",
        declarationId: "ignored-by-system-slot",
        sourceIdentifier: "ignored-source",
        displayName: "主角"
      }),
      declaration({
        declarationId: "decl-2",
        sourceIdentifier: "source-2",
        displayName: "被照料者"
      }),
      declaration({
        sourceIdentifier: "source-helper",
        displayName: "帮助者"
      }),
      declaration({ displayName: "服务端绑定角色" })
    ]
  });

  assert.equal(byName(registry, "主角").characterId, "character:system:protagonist");
  assert.equal(byName(registry, "主角").idSource, "system-slot");
  assert.equal(
    byName(registry, "被照料者").characterId,
    `character:declaration:${Buffer.from("decl-2").toString("base64url")}`
  );
  assert.equal(byName(registry, "被照料者").idSource, "declaration-id");
  assert.equal(
    byName(registry, "帮助者").characterId,
    `character:source:${Buffer.from("source-helper").toString("base64url")}`
  );
  assert.equal(byName(registry, "帮助者").idSource, "source-identifier");
  assert.match(byName(registry, "服务端绑定角色").characterId, /^character:uuid:/u);
  assert.match(byName(registry, "服务端绑定角色").bindingRef, /^binding:/u);
});

test("helper 重排、插入、删除不会改变已有 ID，删除 ID 也不会分配给新角色", () => {
  const store = registryStore();
  const first = store.reconcile({
    declarations: [
      declaration({ declarationId: "a", displayName: "A" }),
      declaration({ sourceIdentifier: "b", displayName: "B" }),
      declaration({ displayName: "C" })
    ]
  });
  const firstIds = Object.fromEntries(first.entries.map((entry) => [entry.displayName, entry.characterId]));
  const cBinding = byName(first, "C").bindingRef;

  const reordered = store.reconcile({
    declarations: [
      declaration({ bindingRef: cBinding, displayName: "C" }),
      declaration({ declarationId: "a", displayName: "A" }),
      declaration({ sourceIdentifier: "inserted", displayName: "D" }),
      declaration({ sourceIdentifier: "b", displayName: "B" })
    ]
  });
  for (const name of ["A", "B", "C"]) {
    assert.equal(byName(reordered, name).characterId, firstIds[name]);
  }

  const afterDelete = store.reconcile({
    declarations: [
      declaration({ bindingRef: cBinding, displayName: "C" }),
      declaration({ declarationId: "a", displayName: "A" }),
      declaration({ displayName: "E" })
    ]
  });
  assert.equal(byName(afterDelete, "A").characterId, firstIds.A);
  assert.equal(byName(afterDelete, "C").characterId, firstIds.C);
  assert.notEqual(byName(afterDelete, "E").characterId, firstIds.B);
  assert.ok(afterDelete.retiredCharacterIds.includes(firstIds.B));
});

test("Registry 拒绝 declarationId、alias 以及 alias/declarationId 冲突", () => {
  assert.throws(
    () => registryStore().reconcile({
      declarations: [
        declaration({ declarationId: "same", displayName: "甲" }),
        declaration({ declarationId: "same", displayName: "乙" })
      ]
    }),
    (error) => error instanceof CharacterRegistryError
      && error.code === "REGISTRY_DECLARATION_ID_CONFLICT"
  );
  assert.throws(
    () => registryStore().reconcile({
      declarations: [
        declaration({ declarationId: "a", displayName: "甲", aliases: ["共同别名"] }),
        declaration({ declarationId: "b", displayName: "共同别名" })
      ]
    }),
    (error) => error instanceof CharacterRegistryError
      && error.code === "REGISTRY_ALIAS_CONFLICT"
  );
  assert.throws(
    () => registryStore().reconcile({
      declarations: [
        declaration({ declarationId: "courier", displayName: "甲" }),
        declaration({ declarationId: "b", displayName: "courier" })
      ]
    }),
    (error) => error instanceof CharacterRegistryError
      && error.code === "REGISTRY_ALIAS_DECLARATION_ID_CONFLICT"
  );
});

test("自动批准 Registry 条目保存服务端签发的完整使用约束", () => {
  const candidate = role();
  const decision = evaluateCastProposalPolicy(candidate);
  const registry = registryStore().reconcile({
    approvedRoles: [{
      role: candidate,
      policy: decision.usageConstraints
    }],
    proposalBindingNamespace: "proposal-digest"
  });
  const entry = registry.entries[0];

  assert.deepEqual(
    Object.fromEntries(Object.keys(automaticUsageConstraints(candidate)).map(
      (key) => [key, entry[key]]
    )),
    automaticUsageConstraints(candidate)
  );
  assert.equal(entry.proposalRef, "cast-proposal-1");
  assert.match(entry.characterId, /^character:uuid:/u);
  assert.equal(entry.idSource, "server-uuid");
});
