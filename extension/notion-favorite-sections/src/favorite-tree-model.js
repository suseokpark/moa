(function installFavoriteTreeModel(global) {
  "use strict";

  const namespace = global.NotionFavoriteSections ??= {};

  const SCHEMA_VERSION = 1;
  const SYSTEM_GROUP_ID = "system-group-uncategorized";
  const SYSTEM_SECTION_ID_PREFIX = "system-section-uncategorized-";
  const SYSTEM_GROUP_NAME = "미분류 그룹";
  const SYSTEM_SECTION_NAME = "미분류 섹션";
  const MAX_NAME_LENGTH = 80;
  const MAX_COLOR_LENGTH = 32;
  const MAX_EMOJI_LENGTH = 16;
  const MAX_ID_LENGTH = 160;
  const MAX_GROUP_ID_LENGTH = MAX_ID_LENGTH - SYSTEM_SECTION_ID_PREFIX.length;
  const DEFAULT_DORMANT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
  const EPOCH = "1970-01-01T00:00:00.000Z";
  const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
  const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/gu;

  let generatedIdCounter = 0;

  class FavoriteTreeModelError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "FavoriteTreeModelError";
      this.code = code;
    }
  }

  function fail(code, message) {
    throw new FavoriteTreeModelError(code, message);
  }

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function boundedString(value, fallback, maximum, { trim = true } = {}) {
    if (typeof value !== "string") return fallback;
    const sanitized = value.replace(CONTROL_CHARACTERS, "");
    const text = trim ? sanitized.trim() : sanitized;
    if (!text) return fallback;
    return text.slice(0, maximum);
  }

  function optionalString(value, maximum) {
    if (typeof value !== "string") return "";
    return value.replace(CONTROL_CHARACTERS, "").trim().slice(0, maximum);
  }

  function requireName(value, entityName) {
    if (typeof value !== "string" || !value.trim()) {
      fail("INVALID_NAME", `${entityName} 이름은 비어 있을 수 없습니다.`);
    }

    const name = value.trim();
    if (CONTROL_CHARACTER.test(name)) {
      fail("INVALID_NAME", `${entityName} 이름에는 제어 문자를 사용할 수 없습니다.`);
    }
    if (name.length > MAX_NAME_LENGTH) {
      fail(
        "INVALID_NAME",
        `${entityName} 이름은 ${MAX_NAME_LENGTH}자를 넘을 수 없습니다.`,
      );
    }
    return name;
  }

  function requireDecoration(value, field, maximum) {
    if (value === undefined) return "";
    if (typeof value !== "string") {
      fail("INVALID_DECORATION", `${field} 값은 문자열이어야 합니다.`);
    }
    const normalized = value.trim();
    if (CONTROL_CHARACTER.test(normalized)) {
      fail("INVALID_DECORATION", `${field} 값에는 제어 문자를 사용할 수 없습니다.`);
    }
    if (normalized.length > maximum) {
      fail("INVALID_DECORATION", `${field} 값이 너무 깁니다.`);
    }
    return normalized;
  }

  function generateId(prefix) {
    const uuid = global.crypto?.randomUUID?.();
    if (uuid) return `${prefix}-${uuid}`;
    generatedIdCounter += 1;
    return `${prefix}-${Date.now().toString(36)}-${generatedIdCounter.toString(36)}`;
  }

  function normalizeRequestedId(value, prefix, maximum = MAX_ID_LENGTH) {
    if (value === undefined) return generateId(prefix);
    if (typeof value !== "string" || !value.trim()) {
      fail("INVALID_ID", "ID는 비어 있지 않은 문자열이어야 합니다.");
    }
    const id = value.trim();
    if (CONTROL_CHARACTER.test(id)) {
      fail("INVALID_ID", "ID에는 제어 문자를 사용할 수 없습니다.");
    }
    if (id.length > maximum) {
      fail("INVALID_ID", `ID는 ${maximum}자를 넘을 수 없습니다.`);
    }
    return id;
  }

  function getSystemSectionId(groupId) {
    return `${SYSTEM_SECTION_ID_PREFIX}${groupId}`;
  }

  function normalizePageId(value) {
    if (isRecord(value)) value = value.pageId ?? value.id;
    if (typeof value !== "string") return "";
    const pageId = value.trim();
    if (!pageId || CONTROL_CHARACTER.test(pageId)) return "";

    const compact = pageId.replaceAll("-", "");
    if (/^[0-9a-fA-F]{32}$/.test(compact)) return compact.toLowerCase();
    return pageId.slice(0, MAX_ID_LENGTH);
  }

  function normalizeTimestamp(value, fallback = EPOCH) {
    if (value instanceof Date && !Number.isNaN(value.valueOf())) {
      return value.toISOString();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      const date = new Date(value);
      if (!Number.isNaN(date.valueOf())) return date.toISOString();
    }
    if (typeof value === "string") {
      const date = new Date(value);
      if (!Number.isNaN(date.valueOf())) return date.toISOString();
    }
    return fallback;
  }

  function stableOrder(items) {
    return items
      .map((value, index) => ({ value, index }))
      .sort((left, right) => {
        const leftOrder = Number.isFinite(left.value?.order)
          ? left.value.order
          : left.index;
        const rightOrder = Number.isFinite(right.value?.order)
          ? right.value.order
          : right.index;
        return leftOrder - rightOrder || left.index - right.index;
      })
      .map(({ value }) => value);
  }

  function uniqueId(
    value,
    prefix,
    usedIds,
    forbiddenIds = new Set(),
    maximum = MAX_ID_LENGTH,
  ) {
    let base = boundedString(value, prefix, maximum);
    if (forbiddenIds.has(base)) base = prefix;
    let candidate = base;
    let suffix = 2;
    while (usedIds.has(candidate) || forbiddenIds.has(candidate)) {
      const suffixText = `-${suffix}`;
      candidate = `${base.slice(0, maximum - suffixText.length)}${suffixText}`;
      suffix += 1;
    }
    usedIds.add(candidate);
    return candidate;
  }

  function normalizeFavorite(rawFavorite) {
    const source = isRecord(rawFavorite)
      ? rawFavorite
      : { pageId: rawFavorite };
    const pageId = normalizePageId(source.pageId ?? source.id);
    if (!pageId) return null;
    return {
      pageId,
      order: 0,
      dormant: source.dormant === true,
      updatedAt: normalizeTimestamp(source.updatedAt),
    };
  }

  function makeSystemSection(groupId, rawSection, rawFavorites) {
    return {
      id: getSystemSectionId(groupId),
      name: SYSTEM_SECTION_NAME,
      color: optionalString(rawSection?.color, MAX_COLOR_LENGTH) || "default",
      emoji: optionalString(rawSection?.emoji, MAX_EMOJI_LENGTH),
      collapsed: rawSection?.collapsed === true,
      order: 0,
      system: true,
      favorites: stableOrder(rawFavorites).map(normalizeFavorite).filter(Boolean),
    };
  }

  function normalizeGroup(
    rawGroup,
    { id, system, sections, usedSectionIds, sourceIndex },
  ) {
    const expectedSystemSectionId = getSystemSectionId(id);
    const rawSections = stableOrder(sections);
    const systemSectionCandidates = [];
    const userSectionCandidates = [];

    for (const rawSection of rawSections) {
      if (!isRecord(rawSection)) continue;
      const rawId = typeof rawSection.id === "string" ? rawSection.id.trim() : "";
      if (
        rawSection.system === true ||
        rawId === expectedSystemSectionId ||
        rawId.startsWith(SYSTEM_SECTION_ID_PREFIX)
      ) {
        systemSectionCandidates.push(rawSection);
      } else {
        userSectionCandidates.push(rawSection);
      }
    }

    const normalizedSections = userSectionCandidates.map((rawSection, index) => {
      const sectionId = uniqueId(
        rawSection.id,
        `section-${sourceIndex + 1}-${index + 1}`,
        usedSectionIds,
        new Set([expectedSystemSectionId]),
      );
      return {
        id: sectionId,
        name: boundedString(
          rawSection.name,
          `섹션 ${index + 1}`,
          MAX_NAME_LENGTH,
        ),
        color: optionalString(rawSection.color, MAX_COLOR_LENGTH) || "default",
        emoji: optionalString(rawSection.emoji, MAX_EMOJI_LENGTH),
        collapsed: rawSection.collapsed === true,
        order: index,
        system: false,
        favorites: stableOrder(asArray(rawSection.favorites))
          .map(normalizeFavorite)
          .filter(Boolean),
      };
    });

    const systemSectionSource = systemSectionCandidates[0];
    const systemFavorites = systemSectionCandidates.flatMap((section) =>
      asArray(section.favorites),
    );
    usedSectionIds.add(expectedSystemSectionId);
    normalizedSections.push(
      makeSystemSection(id, systemSectionSource, systemFavorites),
    );

    return {
      id,
      name: system
        ? SYSTEM_GROUP_NAME
        : boundedString(rawGroup?.name, `그룹 ${sourceIndex + 1}`, MAX_NAME_LENGTH),
      color: optionalString(rawGroup?.color, MAX_COLOR_LENGTH) || "default",
      emoji: optionalString(rawGroup?.emoji, MAX_EMOJI_LENGTH),
      collapsed: rawGroup?.collapsed === true,
      order: 0,
      system,
      sections: normalizedSections,
    };
  }

  function deduplicateFavorites(groups) {
    const records = [];
    for (const group of groups) {
      for (const section of group.sections) {
        for (const favorite of section.favorites) {
          records.push({ section, favorite, sequence: records.length });
        }
      }
    }

    const winnerByPageId = new Map();
    for (const record of records) {
      const existing = winnerByPageId.get(record.favorite.pageId);
      if (!existing || (existing.favorite.dormant && !record.favorite.dormant)) {
        winnerByPageId.set(record.favorite.pageId, record);
      }
    }

    for (const group of groups) {
      for (const section of group.sections) {
        section.favorites = section.favorites
          .filter((favorite) => {
            const winner = winnerByPageId.get(favorite.pageId);
            return winner?.section === section && winner.favorite === favorite;
          })
          .map((favorite, order) => ({ ...favorite, order }));
      }
    }
  }

  function reindexWorkspace(workspace) {
    workspace.groups.forEach((group, groupOrder) => {
      group.order = groupOrder;
      group.sections.forEach((section, sectionOrder) => {
        section.order = sectionOrder;
        section.favorites.forEach((favorite, favoriteOrder) => {
          favorite.order = favoriteOrder;
        });
      });
    });
    return workspace;
  }

  function normalizeWorkspace(input) {
    const source = isRecord(input) ? input : {};
    const orderedGroups = stableOrder(asArray(source.groups)).filter(isRecord);
    const systemCandidates = [];
    const userCandidates = [];

    for (const rawGroup of orderedGroups) {
      if (rawGroup.id === SYSTEM_GROUP_ID || rawGroup.system === true) {
        systemCandidates.push(rawGroup);
      } else {
        userCandidates.push(rawGroup);
      }
    }

    const usedGroupIds = new Set([SYSTEM_GROUP_ID]);
    const usedSectionIds = new Set();
    const groups = userCandidates.map((rawGroup, index) => {
      const groupId = uniqueId(
        rawGroup.id,
        `group-${index + 1}`,
        usedGroupIds,
        new Set([SYSTEM_GROUP_ID]),
        MAX_GROUP_ID_LENGTH,
      );
      return normalizeGroup(rawGroup, {
        id: groupId,
        system: false,
        sections: asArray(rawGroup.sections),
        usedSectionIds,
        sourceIndex: index,
      });
    });

    const primarySystemGroup =
      systemCandidates.find((group) => group.id === SYSTEM_GROUP_ID) ??
      systemCandidates[0] ??
      {};
    const mergedSystemSections = systemCandidates.flatMap((group) =>
      asArray(group.sections),
    );
    groups.push(
      normalizeGroup(primarySystemGroup, {
        id: SYSTEM_GROUP_ID,
        system: true,
        sections: mergedSystemSections,
        usedSectionIds,
        sourceIndex: groups.length,
      }),
    );

    deduplicateFavorites(groups);
    const workspace = {
      schemaVersion: SCHEMA_VERSION,
      groups,
    };
    reindexWorkspace(workspace);
    assertValidWorkspace(workspace);
    return workspace;
  }

  function createWorkspace(options = {}) {
    const input = Array.isArray(options) || !isRecord(options) ? {} : options;
    let workspace = normalizeWorkspace(
      isRecord(input) && Array.isArray(input.groups) ? input : {},
    );
    const favorites = Array.isArray(options)
      ? options
      : input.sourceIds ?? input.favorites;
    if (favorites !== undefined) {
      workspace = reconcileFavorites(workspace, favorites, {
        now: input.now,
        dormantRetentionMs: input.dormantRetentionMs,
      });
    }
    return workspace;
  }

  function assertStringField(value, maximum, path, { empty = false } = {}) {
    if (
      typeof value !== "string" ||
      (!empty && !value.trim()) ||
      value.length > maximum
    ) {
      fail("INVALID_WORKSPACE", `${path} 값이 올바르지 않습니다.`);
    }
    if (CONTROL_CHARACTER.test(value)) {
      fail("INVALID_WORKSPACE", `${path}에 제어 문자가 있습니다.`);
    }
  }

  function assertValidWorkspace(workspace) {
    if (!isRecord(workspace)) {
      fail("INVALID_WORKSPACE", "워크스페이스는 객체여야 합니다.");
    }
    if (workspace.schemaVersion !== SCHEMA_VERSION) {
      fail("INVALID_WORKSPACE", `schemaVersion은 ${SCHEMA_VERSION}이어야 합니다.`);
    }
    if (!Array.isArray(workspace.groups) || workspace.groups.length === 0) {
      fail("INVALID_WORKSPACE", "groups에는 시스템 그룹이 있어야 합니다.");
    }

    const groupIds = new Set();
    const sectionIds = new Set();
    const pageIds = new Set();
    let systemGroupCount = 0;

    workspace.groups.forEach((group, groupIndex) => {
      const groupPath = `groups[${groupIndex}]`;
      if (!isRecord(group)) fail("INVALID_WORKSPACE", `${groupPath}가 객체가 아닙니다.`);
      assertStringField(group.id, MAX_ID_LENGTH, `${groupPath}.id`);
      assertStringField(group.name, MAX_NAME_LENGTH, `${groupPath}.name`);
      assertStringField(group.color, MAX_COLOR_LENGTH, `${groupPath}.color`);
      assertStringField(group.emoji, MAX_EMOJI_LENGTH, `${groupPath}.emoji`, {
        empty: true,
      });
      if (groupIds.has(group.id)) {
        fail("INVALID_WORKSPACE", `중복 그룹 ID: ${group.id}`);
      }
      groupIds.add(group.id);
      if (typeof group.collapsed !== "boolean" || typeof group.system !== "boolean") {
        fail("INVALID_WORKSPACE", `${groupPath}의 boolean 필드가 올바르지 않습니다.`);
      }
      if (group.order !== groupIndex) {
        fail("INVALID_WORKSPACE", `${groupPath}.order가 배열 순서와 다릅니다.`);
      }
      if (!Array.isArray(group.sections) || group.sections.length === 0) {
        fail("INVALID_WORKSPACE", `${groupPath}.sections에 시스템 섹션이 없습니다.`);
      }

      if (group.system) {
        systemGroupCount += 1;
        if (group.id !== SYSTEM_GROUP_ID || groupIndex !== workspace.groups.length - 1) {
          fail("INVALID_WORKSPACE", "시스템 그룹은 고정 ID로 마지막에 있어야 합니다.");
        }
        if (group.name !== SYSTEM_GROUP_NAME) {
          fail("INVALID_WORKSPACE", "시스템 그룹 이름이 올바르지 않습니다.");
        }
      } else if (group.id === SYSTEM_GROUP_ID) {
        fail("INVALID_WORKSPACE", "시스템 그룹 ID를 사용자 그룹에 사용할 수 없습니다.");
      } else if (group.id.length > MAX_GROUP_ID_LENGTH) {
        fail(
          "INVALID_WORKSPACE",
          `사용자 그룹 ID는 ${MAX_GROUP_ID_LENGTH}자를 넘을 수 없습니다.`,
        );
      }

      let systemSectionCount = 0;
      group.sections.forEach((section, sectionIndex) => {
        const sectionPath = `${groupPath}.sections[${sectionIndex}]`;
        if (!isRecord(section)) {
          fail("INVALID_WORKSPACE", `${sectionPath}가 객체가 아닙니다.`);
        }
        assertStringField(section.id, MAX_ID_LENGTH, `${sectionPath}.id`);
        assertStringField(section.name, MAX_NAME_LENGTH, `${sectionPath}.name`);
        assertStringField(section.color, MAX_COLOR_LENGTH, `${sectionPath}.color`);
        assertStringField(section.emoji, MAX_EMOJI_LENGTH, `${sectionPath}.emoji`, {
          empty: true,
        });
        if (sectionIds.has(section.id)) {
          fail("INVALID_WORKSPACE", `중복 섹션 ID: ${section.id}`);
        }
        sectionIds.add(section.id);
        if (
          typeof section.collapsed !== "boolean" ||
          typeof section.system !== "boolean"
        ) {
          fail("INVALID_WORKSPACE", `${sectionPath}의 boolean 필드가 올바르지 않습니다.`);
        }
        if (section.order !== sectionIndex) {
          fail("INVALID_WORKSPACE", `${sectionPath}.order가 배열 순서와 다릅니다.`);
        }
        if (!Array.isArray(section.favorites)) {
          fail("INVALID_WORKSPACE", `${sectionPath}.favorites는 배열이어야 합니다.`);
        }

        const expectedSystemSectionId = getSystemSectionId(group.id);
        if (section.system) {
          systemSectionCount += 1;
          if (
            section.id !== expectedSystemSectionId ||
            sectionIndex !== group.sections.length - 1
          ) {
            fail("INVALID_WORKSPACE", "시스템 섹션은 고정 ID로 마지막에 있어야 합니다.");
          }
          if (section.name !== SYSTEM_SECTION_NAME) {
            fail("INVALID_WORKSPACE", "시스템 섹션 이름이 올바르지 않습니다.");
          }
        } else if (
          section.id === expectedSystemSectionId ||
          section.id.startsWith(SYSTEM_SECTION_ID_PREFIX)
        ) {
          fail("INVALID_WORKSPACE", "시스템 섹션 ID를 사용자 섹션에 사용할 수 없습니다.");
        }

        section.favorites.forEach((favorite, favoriteIndex) => {
          const favoritePath = `${sectionPath}.favorites[${favoriteIndex}]`;
          if (!isRecord(favorite)) {
            fail("INVALID_WORKSPACE", `${favoritePath}가 객체가 아닙니다.`);
          }
          assertStringField(favorite.pageId, MAX_ID_LENGTH, `${favoritePath}.pageId`);
          if (normalizePageId(favorite.pageId) !== favorite.pageId) {
            fail("INVALID_WORKSPACE", `${favoritePath}.pageId가 정규화되지 않았습니다.`);
          }
          if (pageIds.has(favorite.pageId)) {
            fail("INVALID_WORKSPACE", `중복 Favorite ID: ${favorite.pageId}`);
          }
          pageIds.add(favorite.pageId);
          if (favorite.order !== favoriteIndex || typeof favorite.dormant !== "boolean") {
            fail("INVALID_WORKSPACE", `${favoritePath}의 순서 또는 dormant가 올바르지 않습니다.`);
          }
          if (
            typeof favorite.updatedAt !== "string" ||
            Number.isNaN(new Date(favorite.updatedAt).valueOf()) ||
            new Date(favorite.updatedAt).toISOString() !== favorite.updatedAt
          ) {
            fail("INVALID_WORKSPACE", `${favoritePath}.updatedAt이 올바르지 않습니다.`);
          }
        });
      });

      if (systemSectionCount !== 1) {
        fail("INVALID_WORKSPACE", `${groupPath}에는 시스템 섹션이 하나만 있어야 합니다.`);
      }
    });

    if (systemGroupCount !== 1) {
      fail("INVALID_WORKSPACE", "시스템 그룹은 하나만 있어야 합니다.");
    }
    return true;
  }

  function parseCreateInput(input, entityName, prefix) {
    const source = typeof input === "string" ? { name: input } : input;
    if (!isRecord(source)) {
      fail("INVALID_INPUT", `${entityName} 생성 옵션이 올바르지 않습니다.`);
    }
    return {
      id: normalizeRequestedId(
        source.id,
        prefix,
        prefix === "group" ? MAX_GROUP_ID_LENGTH : MAX_ID_LENGTH,
      ),
      name: requireName(source.name, entityName),
      color: requireDecoration(source.color, "color", MAX_COLOR_LENGTH) || "default",
      emoji: requireDecoration(source.emoji, "emoji", MAX_EMOJI_LENGTH),
      collapsed: source.collapsed === true,
    };
  }

  function findGroup(workspace, groupId) {
    return workspace.groups.find((group) => group.id === groupId);
  }

  function findSection(workspace, sectionId) {
    for (const group of workspace.groups) {
      const section = group.sections.find((candidate) => candidate.id === sectionId);
      if (section) return { group, section };
    }
    return null;
  }

  function findFavorite(workspace, pageId) {
    const normalizedId = normalizePageId(pageId);
    for (const group of workspace.groups) {
      for (const section of group.sections) {
        const index = section.favorites.findIndex(
          (favorite) => favorite.pageId === normalizedId,
        );
        if (index !== -1) {
          return { group, section, favorite: section.favorites[index], index };
        }
      }
    }
    return null;
  }

  function requireGroup(workspace, groupId) {
    const group = findGroup(workspace, groupId);
    if (!group) fail("GROUP_NOT_FOUND", `그룹을 찾을 수 없습니다: ${groupId}`);
    return group;
  }

  function requireSection(workspace, sectionId) {
    const result = findSection(workspace, sectionId);
    if (!result) fail("SECTION_NOT_FOUND", `섹션을 찾을 수 없습니다: ${sectionId}`);
    return result;
  }

  function finalizeMutation(workspace) {
    reindexWorkspace(workspace);
    assertValidWorkspace(workspace);
    return workspace;
  }

  function mutation(workspace, callback) {
    const next = normalizeWorkspace(workspace);
    callback(next);
    return finalizeMutation(next);
  }

  function createGroup(workspace, input) {
    const attributes = parseCreateInput(input, "그룹", "group");
    if (attributes.id === SYSTEM_GROUP_ID) {
      fail("RESERVED_ID", "시스템 그룹 ID는 사용할 수 없습니다.");
    }
    return mutation(workspace, (next) => {
      if (findGroup(next, attributes.id)) {
        fail("DUPLICATE_ID", `이미 존재하는 그룹 ID: ${attributes.id}`);
      }
      const systemGroupIndex = next.groups.findIndex((group) => group.system);
      next.groups.splice(systemGroupIndex, 0, {
        ...attributes,
        order: systemGroupIndex,
        system: false,
        sections: [makeSystemSection(attributes.id, null, [])],
      });
    });
  }

  function renameGroup(workspace, groupId, name) {
    const normalizedName = requireName(name, "그룹");
    return mutation(workspace, (next) => {
      const group = requireGroup(next, groupId);
      if (group.system) fail("SYSTEM_PROTECTED", "시스템 그룹 이름은 바꿀 수 없습니다.");
      group.name = normalizedName;
    });
  }

  function toggleGroup(workspace, groupId, collapsed) {
    if (collapsed !== undefined && typeof collapsed !== "boolean") {
      fail("INVALID_COLLAPSED", "collapsed는 boolean이어야 합니다.");
    }
    return mutation(workspace, (next) => {
      const group = requireGroup(next, groupId);
      group.collapsed = collapsed ?? !group.collapsed;
    });
  }

  function resolveMoveIndex(items, position, idSelector = (item) => item.id) {
    if (Number.isInteger(position)) {
      return Math.max(0, Math.min(position, items.length));
    }
    if (isRecord(position)) {
      if (Number.isInteger(position.index)) {
        return Math.max(0, Math.min(position.index, items.length));
      }
      if (typeof position.beforeId === "string") {
        const index = items.findIndex((item) => idSelector(item) === position.beforeId);
        if (index === -1) fail("TARGET_NOT_FOUND", `beforeId를 찾을 수 없습니다: ${position.beforeId}`);
        return index;
      }
      if (typeof position.afterId === "string") {
        const index = items.findIndex((item) => idSelector(item) === position.afterId);
        if (index === -1) fail("TARGET_NOT_FOUND", `afterId를 찾을 수 없습니다: ${position.afterId}`);
        return index + 1;
      }
    }
    if (position === undefined) return items.length;
    fail("INVALID_POSITION", "이동 위치가 올바르지 않습니다.");
  }

  function moveGroup(workspace, groupId, position) {
    return mutation(workspace, (next) => {
      const sourceIndex = next.groups.findIndex((group) => group.id === groupId);
      if (sourceIndex === -1) fail("GROUP_NOT_FOUND", `그룹을 찾을 수 없습니다: ${groupId}`);
      if (next.groups[sourceIndex].system) {
        fail("SYSTEM_PROTECTED", "시스템 그룹은 이동할 수 없습니다.");
      }
      const [group] = next.groups.splice(sourceIndex, 1);
      const userGroups = next.groups.filter((candidate) => !candidate.system);
      const targetIndex = resolveMoveIndex(userGroups, position);
      next.groups.splice(targetIndex, 0, group);
    });
  }

  function deleteGroup(workspace, groupId) {
    return mutation(workspace, (next) => {
      const sourceIndex = next.groups.findIndex((group) => group.id === groupId);
      if (sourceIndex === -1) fail("GROUP_NOT_FOUND", `그룹을 찾을 수 없습니다: ${groupId}`);
      const source = next.groups[sourceIndex];
      if (source.system) fail("SYSTEM_PROTECTED", "시스템 그룹은 삭제할 수 없습니다.");

      const systemGroup = requireGroup(next, SYSTEM_GROUP_ID);
      const targetSystemSection = systemGroup.sections.at(-1);
      const sourceSystemSection = source.sections.at(-1);
      targetSystemSection.favorites.push(...sourceSystemSection.favorites);

      const userSections = source.sections.filter((section) => !section.system);
      systemGroup.sections.splice(
        systemGroup.sections.length - 1,
        0,
        ...userSections,
      );
      next.groups.splice(sourceIndex, 1);
    });
  }

  function createSection(workspace, groupId, input) {
    const attributes = parseCreateInput(input, "섹션", "section");
    return mutation(workspace, (next) => {
      const group = requireGroup(next, groupId);
      if (attributes.id.startsWith(SYSTEM_SECTION_ID_PREFIX)) {
        fail("RESERVED_ID", "시스템 섹션 ID는 사용할 수 없습니다.");
      }
      if (findSection(next, attributes.id)) {
        fail("DUPLICATE_ID", `이미 존재하는 섹션 ID: ${attributes.id}`);
      }
      group.sections.splice(group.sections.length - 1, 0, {
        ...attributes,
        order: group.sections.length - 1,
        system: false,
        favorites: [],
      });
    });
  }

  function renameSection(workspace, sectionId, name) {
    const normalizedName = requireName(name, "섹션");
    return mutation(workspace, (next) => {
      const { section } = requireSection(next, sectionId);
      if (section.system) fail("SYSTEM_PROTECTED", "시스템 섹션 이름은 바꿀 수 없습니다.");
      section.name = normalizedName;
    });
  }

  function toggleSection(workspace, sectionId, collapsed) {
    if (collapsed !== undefined && typeof collapsed !== "boolean") {
      fail("INVALID_COLLAPSED", "collapsed는 boolean이어야 합니다.");
    }
    return mutation(workspace, (next) => {
      const { section } = requireSection(next, sectionId);
      section.collapsed = collapsed ?? !section.collapsed;
    });
  }

  function parseSectionMoveTarget(targetGroupId, position) {
    if (isRecord(targetGroupId)) {
      const embeddedPosition =
        targetGroupId.position ??
        (Number.isInteger(targetGroupId.index)
          ? targetGroupId.index
          : typeof targetGroupId.beforeId === "string"
            ? { beforeId: targetGroupId.beforeId }
            : typeof targetGroupId.afterId === "string"
              ? { afterId: targetGroupId.afterId }
              : undefined);
      return {
        groupId: targetGroupId.groupId,
        position: embeddedPosition,
      };
    }
    return { groupId: targetGroupId, position };
  }

  function moveSection(workspace, sectionId, targetGroupId, position) {
    const target = parseSectionMoveTarget(targetGroupId, position);
    return mutation(workspace, (next) => {
      const source = requireSection(next, sectionId);
      if (source.section.system) {
        fail("SYSTEM_PROTECTED", "시스템 섹션은 이동할 수 없습니다.");
      }
      const targetGroup = requireGroup(next, target.groupId);
      const sourceIndex = source.group.sections.indexOf(source.section);
      source.group.sections.splice(sourceIndex, 1);
      const userSections = targetGroup.sections.filter((section) => !section.system);
      const targetIndex = resolveMoveIndex(userSections, target.position);
      targetGroup.sections.splice(targetIndex, 0, source.section);
    });
  }

  function deleteSection(workspace, sectionId) {
    return mutation(workspace, (next) => {
      const { group, section } = requireSection(next, sectionId);
      if (section.system) fail("SYSTEM_PROTECTED", "시스템 섹션은 삭제할 수 없습니다.");
      const target = group.sections.at(-1);
      target.favorites.push(...section.favorites);
      group.sections.splice(group.sections.indexOf(section), 1);
    });
  }

  function parseFavoriteMoveTarget(targetSectionId, position) {
    if (isRecord(targetSectionId)) {
      const embeddedPosition =
        targetSectionId.position ??
        (Number.isInteger(targetSectionId.index)
          ? targetSectionId.index
          : typeof targetSectionId.beforeId === "string"
            ? { beforeId: targetSectionId.beforeId }
            : typeof targetSectionId.afterId === "string"
              ? { afterId: targetSectionId.afterId }
              : undefined);
      return {
        sectionId: targetSectionId.sectionId,
        position: embeddedPosition,
      };
    }
    return { sectionId: targetSectionId, position };
  }

  function moveFavorite(workspace, pageId, targetSectionId, position) {
    const normalizedPageId = normalizePageId(pageId);
    if (!normalizedPageId) fail("INVALID_PAGE_ID", "Favorite pageId가 올바르지 않습니다.");
    const target = parseFavoriteMoveTarget(targetSectionId, position);
    return mutation(workspace, (next) => {
      const source = findFavorite(next, normalizedPageId);
      if (!source) {
        fail("FAVORITE_NOT_FOUND", `Favorite을 찾을 수 없습니다: ${normalizedPageId}`);
      }
      const { section: destination } = requireSection(next, target.sectionId);
      source.section.favorites.splice(source.index, 1);
      const targetIndex = resolveMoveIndex(
        destination.favorites,
        target.position,
        (favorite) => favorite.pageId,
      );
      destination.favorites.splice(targetIndex, 0, source.favorite);
    });
  }

  function addFavorite(workspace, pageId, options = {}) {
    const normalizedPageId = normalizePageId(pageId);
    if (!normalizedPageId) fail("INVALID_PAGE_ID", "Favorite pageId가 올바르지 않습니다.");
    const input = isRecord(options) ? options : {};
    const now = normalizeTimestamp(input.now, new Date().toISOString());

    return mutation(workspace, (next) => {
      const existing = findFavorite(next, normalizedPageId);
      if (existing) {
        existing.favorite.dormant = false;
        existing.favorite.updatedAt = now;
        return;
      }
      const destination =
        input.sectionId === undefined
          ? next.groups.at(-1).sections.at(-1)
          : requireSection(next, input.sectionId).section;
      destination.favorites.push({
        pageId: normalizedPageId,
        order: 0,
        dormant: false,
        updatedAt: now,
      });
    });
  }

  function addFavorites(workspace, pageIds, options = {}) {
    if (!Array.isArray(pageIds)) {
      fail("INVALID_PAGE_IDS", "pageIds는 배열이어야 합니다.");
    }
    if (pageIds.length === 0) {
      fail("EMPTY_PAGE_IDS", "pageIds에는 하나 이상의 Favorite ID가 필요합니다.");
    }
    const input = isRecord(options) ? options : {};
    if (
      typeof input.sectionId !== "string" ||
      !input.sectionId.trim() ||
      CONTROL_CHARACTER.test(input.sectionId) ||
      input.sectionId.trim().length > MAX_ID_LENGTH
    ) {
      fail("INVALID_SECTION_ID", "sectionId가 올바르지 않습니다.");
    }
    const sectionId = input.sectionId.trim();
    const now = normalizeTimestamp(input.now, new Date().toISOString());
    const normalizedPageIds = [];
    const seenPageIds = new Set();
    for (const pageId of pageIds) {
      const normalizedPageId = normalizePageId(pageId);
      if (!normalizedPageId) {
        fail("INVALID_PAGE_ID", "Favorite pageId가 올바르지 않습니다.");
      }
      if (seenPageIds.has(normalizedPageId)) continue;
      seenPageIds.add(normalizedPageId);
      normalizedPageIds.push(normalizedPageId);
    }

    return mutation(workspace, (next) => {
      const { group: destinationGroup, section: destination } = requireSection(
        next,
        sectionId,
      );
      destinationGroup.collapsed = false;
      destination.collapsed = false;
      for (const pageId of normalizedPageIds) {
        const existing = findFavorite(next, pageId);
        if (existing) {
          existing.favorite.dormant = false;
          existing.favorite.updatedAt = now;
          continue;
        }
        destination.favorites.push({
          pageId,
          order: 0,
          dormant: false,
          updatedAt: now,
        });
      }
    });
  }

  function removeFavorite(workspace, pageId) {
    const normalizedPageId = normalizePageId(pageId);
    if (!normalizedPageId) fail("INVALID_PAGE_ID", "Favorite pageId가 올바르지 않습니다.");

    return mutation(workspace, (next) => {
      const existing = findFavorite(next, normalizedPageId);
      if (!existing) {
        fail("FAVORITE_NOT_FOUND", `Favorite을 찾을 수 없습니다: ${normalizedPageId}`);
      }
      existing.section.favorites.splice(existing.index, 1);
    });
  }

  function reconcileInput(sourceIds, options) {
    if (!Array.isArray(sourceIds)) {
      fail("INVALID_SOURCE", "sourceIds는 배열이어야 합니다.");
    }
    const input = isRecord(options) ? options : {};
    const now = normalizeTimestamp(input.now, new Date().toISOString());
    const nowMs = new Date(now).valueOf();
    const retention =
      input.dormantRetentionMs === undefined
        ? DEFAULT_DORMANT_RETENTION_MS
        : input.dormantRetentionMs;
    if (
      retention !== Infinity &&
      (!Number.isFinite(retention) || retention < 0)
    ) {
      fail("INVALID_RETENTION", "dormantRetentionMs는 0 이상의 숫자여야 합니다.");
    }

    const observed = [];
    const observedSet = new Set();
    for (const sourceId of sourceIds) {
      const pageId = normalizePageId(sourceId);
      if (!pageId || observedSet.has(pageId)) continue;
      observedSet.add(pageId);
      observed.push(pageId);
    }
    return { now, nowMs, retention, observed, observedSet };
  }

  function updateManagedFavoriteStatus(workspace, input) {
    for (const group of workspace.groups) {
      for (const section of group.sections) {
        section.favorites = section.favorites.filter((favorite) => {
          if (input.observedSet.has(favorite.pageId)) {
            favorite.dormant = false;
            favorite.updatedAt = input.now;
            return true;
          }
          if (!favorite.dormant) {
            favorite.dormant = true;
            favorite.updatedAt = input.now;
            return input.retention !== 0;
          }
          if (input.retention === Infinity) return true;
          return (
            input.nowMs - new Date(favorite.updatedAt).valueOf() < input.retention
          );
        });
      }
    }
  }

  function reconcileManagedFavorites(workspace, sourceIds, options = {}) {
    const input = reconcileInput(sourceIds, options);
    return mutation(workspace, (next) => updateManagedFavoriteStatus(next, input));
  }

  function reconcileFavorites(workspace, sourceIds, options = {}) {
    const input = reconcileInput(sourceIds, options);

    return mutation(workspace, (next) => {
      const existingIds = new Set();
      for (const group of next.groups) {
        for (const section of group.sections) {
          for (const favorite of section.favorites) {
            existingIds.add(favorite.pageId);
          }
        }
      }

      for (const pageId of input.observed) {
        if (existingIds.has(pageId)) continue;
        next.groups.at(-1).sections.at(-1).favorites.push({
          pageId,
          order: 0,
          dormant: false,
          updatedAt: input.now,
        });
      }
      updateManagedFavoriteStatus(next, input);
    });
  }

  function getCounts(workspace, targetId) {
    const normalized = normalizeWorkspace(workspace);
    const byGroup = {};
    const bySection = {};
    let total = 0;
    let active = 0;
    let dormant = 0;
    let sectionCount = 0;

    for (const group of normalized.groups) {
      const groupCounts = {
        sections: group.sections.length,
        total: 0,
        active: 0,
        dormant: 0,
        bySection: {},
      };
      sectionCount += group.sections.length;
      for (const section of group.sections) {
        const sectionCounts = {
          total: section.favorites.length,
          active: section.favorites.filter((favorite) => !favorite.dormant).length,
          dormant: section.favorites.filter((favorite) => favorite.dormant).length,
        };
        groupCounts.total += sectionCounts.total;
        groupCounts.active += sectionCounts.active;
        groupCounts.dormant += sectionCounts.dormant;
        groupCounts.bySection[section.id] = sectionCounts;
        bySection[section.id] = sectionCounts;
      }
      total += groupCounts.total;
      active += groupCounts.active;
      dormant += groupCounts.dormant;
      byGroup[group.id] = groupCounts;
    }

    if (targetId !== undefined) {
      return byGroup[targetId] ?? bySection[targetId] ?? null;
    }
    return {
      groups: normalized.groups.length,
      sections: sectionCount,
      total,
      active,
      dormant,
      byGroup,
      bySection,
    };
  }

  namespace.model = Object.freeze({
    SCHEMA_VERSION,
    SYSTEM_GROUP_ID,
    SYSTEM_GROUP_NAME,
    SYSTEM_SECTION_NAME,
    SYSTEM_SECTION_ID_PREFIX,
    MAX_NAME_LENGTH,
    DEFAULT_DORMANT_RETENTION_MS,
    FavoriteTreeModelError,
    getSystemSectionId,
    normalizePageId,
    createWorkspace,
    normalizeWorkspace,
    reconcileFavorites,
    reconcileManagedFavorites,
    createGroup,
    renameGroup,
    toggleGroup,
    deleteGroup,
    moveGroup,
    createSection,
    renameSection,
    toggleSection,
    deleteSection,
    moveSection,
    addFavorite,
    addFavorites,
    removeFavorite,
    moveFavorite,
    getCounts,
    assertValidWorkspace,
    findFavorite,
  });
})(globalThis);
