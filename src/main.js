import { activeMessages, importArchiveFile, loadBundledArchive, plainMessageText } from "./data/archive-adapter.js";
import { renderConversation, renderUserEdit } from "./ui/conversation-view.js";
import { hydrateIcons, icon } from "./ui/icons.js";

function element(selector) {
  return document.querySelector(selector);
}

function conversationLabel(conversation) {
  return String(conversation?.title || "未命名聊天").trim() || "未命名聊天";
}

function firstMessageTime(conversation) {
  const first = activeMessages(conversation)[0];
  return Number(first?.createdAt ?? conversation?.create_time ?? 0) || 0;
}

function mergeConversations(conversations) {
  const ordered = [...conversations].sort((left, right) => firstMessageTime(left) - firstMessageTime(right));
  const records = ordered
    .flatMap((conversation) => activeMessages(conversation).map((record) => ({ ...record, source: conversation })))
    .sort((left, right) => Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0));
  const mapping = {};
  let parent = null;
  records.forEach((record, index) => {
    const id = `merged-message-${index}`;
    const message = JSON.parse(JSON.stringify(record.message));
    message.id = id;
    mapping[id] = { id, parent, children: [], message };
    if (parent) mapping[parent].children.push(id);
    parent = id;
  });
  const earliest = ordered[0] ?? {};
  const latest = ordered.at(-1) ?? earliest;
  return {
    id: `merged-${Date.now()}`,
    title: conversationLabel(earliest),
    create_time: firstMessageTime(earliest),
    update_time: Number(latest?.update_time ?? latest?.create_time ?? 0),
    mapping,
    current_node: parent,
  };
}

function entryId(conversation, index) {
  return String(conversation?.id || conversation?.conversation_id || `local-conversation-${index}`);
}

function sortEntries(entries) {
  return [...entries].sort((left, right) => {
    const rightTime = Number(right.conversation?.update_time ?? right.conversation?.create_time ?? 0);
    const leftTime = Number(left.conversation?.update_time ?? left.conversation?.create_time ?? 0);
    return rightTime - leftTime;
  });
}

function hasFileTransfer(transfer) {
  if (!transfer) return false;
  if (transfer.files?.length) return true;

  return Array.from(transfer.types ?? []).some((type) => {
    return type === "Files" || type === "application/x-moz-file";
  });
}

function importedFile(transfer) {
  const files = Array.from(transfer?.files ?? []);
    return files.find((candidate) => /\.(zip|json|js)$/i.test(candidate.name)) ?? files[0] ?? null;
}

function sidebarStartsOpenForArchive(archive) {
  // A complete ZIP is normally a multi-conversation archive, so showing the
  // history rail is useful. Standalone JSON/JS imports are focused views; a
  // one-conversation ZIP follows that same focused presentation.
  return archive?.source === "zip" && archive.conversations.length > 1;
}

function copyText(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);

  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  return copied ? Promise.resolve() : Promise.reject(new Error("clipboard unavailable"));
}

function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportConversationData(conversation) {
  return { ...conversation, is_pinned: Boolean(conversation?.is_pinned ?? conversation?.pinned) };
}

function downloadMarkdown(filename, entry) {
  const title = conversationLabel(entry?.conversation);
  const sections = activeMessages(entry?.conversation).map((record) => {
    const heading = record.role === "user" ? "用户" : "ChatGPT";
    const text = plainMessageText(record);
    return text ? `## ${heading}\n\n${text}` : "";
  }).filter(Boolean);
  const markdown = `# ${title}\n\n${sections.join("\n\n")}\n`;
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadZip(filename, entries) {
  const text = new TextEncoder().encode(JSON.stringify(entries.map((entry) => exportConversationData(entry.conversation)), null, 2));
  const crc = (bytes) => { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ 0xffffffff) >>> 0; };
  const name = new TextEncoder().encode("conversations.json");
  const header = new Uint8Array(30 + name.length + text.length); const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint32(14, crc(text), true); view.setUint32(18, text.length, true); view.setUint32(22, text.length, true); view.setUint16(26, name.length, true); header.set(name, 30); header.set(text, 30 + name.length);
  const central = new Uint8Array(46 + name.length); const cv = new DataView(central.buffer); cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint32(16, crc(text), true); cv.setUint32(20, text.length, true); cv.setUint32(24, text.length, true); cv.setUint16(28, name.length, true); cv.setUint32(42, 0, true); central.set(name, 46);
  const end = new Uint8Array(22); const ev = new DataView(end.buffer); ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true); ev.setUint32(12, central.length, true); ev.setUint32(16, header.length, true);
  const blob = new Blob([header, central, end], { type: "application/zip" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[character]));
}

function searchResultSnippet(value, query, contextLength = 48) {
  const text = String(value ?? "");
  if (!query) return text;

  const matchIndex = text.toLocaleLowerCase("zh-CN").indexOf(query);
  if (matchIndex < 0) return text;

  // Search results use a one-line ellipsis. Showing the message from index 0
  // can therefore hide a match that occurs later in the message.
  const start = Math.max(0, matchIndex - contextLength);
  const end = Math.min(text.length, matchIndex + query.length + contextLength);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function highlightSearchText(root, query) {
  if (!root || !query) return;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(escaped, "ig");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest("mark, code, pre, .cgpt-turn-actions")) continue;
    if (matcher.test(node.nodeValue)) nodes.push(node);
    matcher.lastIndex = 0;
  }
  nodes.forEach((textNode) => {
    const fragment = document.createDocumentFragment();
    let last = 0;
    textNode.nodeValue.replace(matcher, (match, offset) => {
      fragment.append(textNode.nodeValue.slice(last, offset));
      const mark = document.createElement("mark");
      mark.className = "cgpt-message-search-highlight";
      mark.textContent = match;
      fragment.append(mark);
      last = offset + match.length;
      return match;
    });
    fragment.append(textNode.nodeValue.slice(last));
    textNode.replaceWith(fragment);
    matcher.lastIndex = 0;
  });
}

function embeddedStyles() {
  const packaged = document.querySelector("#project-style-source")?.textContent;
  if (packaged) return packaged;
  const chunks = [];
  const collectRules = (sheet) => {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule.type === CSSRule.IMPORT_RULE) {
          if (rule.styleSheet) collectRules(rule.styleSheet);
        } else {
          chunks.push(rule.cssText);
        }
      }
    } catch {
      // Cross-origin stylesheets cannot be read; local project styles are embedded.
    }
  };
  for (const sheet of Array.from(document.styleSheets)) collectRules(sheet);
  return chunks.join("\n");
}

async function inlineCssUrls(css) {
  const urls = [...new Set([...css.matchAll(/url\((['"]?)([^'")]+)\1\)/g)].map((match) => match[2]))]
    .filter((url) => url && !url.startsWith("data:") && !url.startsWith("#"));
  const replacements = await Promise.all(urls.map(async (url) => {
    try {
      const response = await fetch(new URL(url, document.baseURI));
      if (!response.ok) return [url, url];
      const blob = await response.blob();
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      return [url, data];
    } catch {
      return [url, url];
    }
  }));
  return replacements.reduce((result, [from, to]) => result.split(from).join(to), css);
}

async function inlineExportAssets(root) {
  const elements = Array.from(root.querySelectorAll("[src], [href]"));
  await Promise.all(elements.map(async (candidate) => {
    const attribute = candidate.hasAttribute("src") ? "src" : "href";
    const value = candidate.getAttribute(attribute);
    if (!value?.startsWith("blob:")) return;

    const response = await fetch(value);
    const blob = await response.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    candidate.setAttribute(attribute, dataUrl);
  }));
}

async function inlineProjectSprites(root) {
  const uses = [...root.querySelectorAll('use[href^="./reference/"]')];
  const sources = new Map();
  let embeddedSprites = {};
  try { embeddedSprites = JSON.parse(root.querySelector("#project-sprite-source")?.textContent || "{}"); } catch {}
  for (const use of uses) {
    const href = use.getAttribute("href");
    const [path, fragment] = href.split("#");
    if (!sources.has(path)) sources.set(path, embeddedSprites[path] || fetch(path).then((response) => {
      if (!response.ok) throw new Error(`无法内联 SVG 资源：${path}`);
      return response.text();
    }));
    use.dataset.inlineSprite = fragment || "";
  }
  const sprites = await Promise.all([...sources.entries()].map(async ([path, promise]) => [path, await promise]));
  const spriteContainer = root.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  spriteContainer.setAttribute("aria-hidden", "true");
  spriteContainer.style.display = "none";
  for (const [, markup] of sprites) {
    const sprite = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
    for (const child of [...sprite.children]) spriteContainer.append(root.ownerDocument.importNode(child, true));
  }
  root.querySelector("body").prepend(spriteContainer);
  for (const use of uses) {
    const fragment = use.dataset.inlineSprite;
    use.setAttribute("href", `#${fragment}`);
    delete use.dataset.inlineSprite;
  }
}

async function downloadHtml(filename, entry, state) {
  const title = conversationLabel(entry?.conversation);
  const clone = document.documentElement.cloneNode(true);
  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon?.href) {
    try {
      const response = await fetch(favicon.href);
      if (response.ok) {
        const blob = await response.blob();
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        const embeddedIcon = document.createElement("link");
        embeddedIcon.rel = "icon";
        embeddedIcon.dataset.exportFavicon = "true";
        embeddedIcon.type = blob.type || "image/x-icon";
        embeddedIcon.href = dataUrl;
        clone.querySelector("head")?.append(embeddedIcon);
      }
    } catch {}
  }
  // Freeze the rendered icon markup into the exported document. This covers
  // the compact/mobile sidebar toggle before its runtime hydrates.
  hydrateIcons(clone);
  // The picker is a required runtime node. Keep it (it is visually hidden)
  // so the self-contained application can bootstrap and still import later.
  clone.querySelectorAll("link[rel=\"stylesheet\"], link[rel=\"icon\"]:not([data-export-favicon]), script[src]").forEach((node) => node.remove());
  clone.querySelectorAll("#menu, #drop-target").forEach((node) => {
    node.hidden = true;
    if (node.id === "menu") node.replaceChildren();
  });
  await inlineExportAssets(clone);
  await inlineProjectSprites(clone);
  clone.querySelectorAll("#project-runtime-source, #project-style-source, #project-sprite-source").forEach((node) => node.remove());

  const data = {
    activeId: entry.id,
    conversations: [exportConversationData(entry.conversation)],
    assets: [],
  };
  const assetKeys = new Set();
  for (const conversation of [entry.conversation]) {
    for (const record of activeMessages(conversation)) {
      for (const part of record.parts ?? []) {
        if (!part || !["asset", "image"].includes(part.type)) continue;
        const resolved = state.archive?.resolver?.resolve(part);
        if (!resolved || assetKeys.has(`${part.pointer || ""}|${part.name || ""}`)) continue;
        const response = await fetch(resolved.url);
        if (!response.ok) continue;
        const blob = await response.blob();
        const assetData = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        assetKeys.add(`${part.pointer || ""}|${part.name || ""}`);
        data.assets.push({ pointer: part.pointer || "", name: part.name || "", resolvedName: resolved.name, mimeType: resolved.mimeType, data: assetData });
      }
    }
  }
  const dataScript = document.createElement("script");
  dataScript.type = "application/json";
  dataScript.id = "embedded-archive-data";
  dataScript.textContent = JSON.stringify(data).replace(/</g, "\\u003c");
  clone.querySelector("body").append(dataScript);

  const embeddedRuntime = document.querySelector("#project-runtime-source")?.textContent;
  const runtimeScripts = embeddedRuntime
    ? [{ textContent: embeddedRuntime, src: "" }]
    : [...document.querySelectorAll("script[src], script[data-export-runtime]")];
  for (const sourceScript of runtimeScripts) {
    const source = sourceScript.src
      ? await (async () => {
        const runtimeResponse = await fetch(sourceScript.src);
        if (!runtimeResponse.ok) throw new Error(`无法读取项目运行脚本：${sourceScript.src}`);
        return runtimeResponse.text();
      })()
      : sourceScript.textContent;
    const runtimeScript = document.createElement("script");
    runtimeScript.dataset.exportRuntime = "true";
    runtimeScript.textContent = source
      .replace(/\.\/reference\/[^"']+?\.svg#/g, "#");
    clone.querySelector("body").append(runtimeScript);
  }

  const styles = await inlineCssUrls(embeddedStyles());
  const html = `<!doctype html>${clone.outerHTML
    .replace("</head>", `<style>${styles}</style></head>`)
    .replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(title)} · ChatGPT</title>`)}`;
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function updateMessageText(conversation, messageId, value) {
  const mapping = conversation?.mapping;
  if (!mapping || typeof mapping !== "object") return false;
  for (const node of Object.values(mapping)) {
    if (node?.message?.id !== messageId) continue;
    const content = node.message.content && typeof node.message.content === "object"
      ? node.message.content
      : (node.message.content = {});
    content.parts = [value];
    content.content = value;
    return true;
  }
  return false;
}

function removeMessage(conversation, messageId) {
  const mapping = conversation?.mapping;
  if (!mapping || typeof mapping !== "object") return false;
  const key = Object.keys(mapping).find((candidate) => mapping[candidate]?.message?.id === messageId);
  if (!key) return false;
  delete mapping[key];
  return true;
}

function removeAssistantTurn(conversation, record) {
  const mapping = conversation?.mapping;
  if (!mapping || !record?.nodeId) return false;
  const assistantKey = record.nodeId;
  const assistantNode = mapping[assistantKey];
  if (assistantNode?.message?.author?.role !== "assistant") return false;

  // System/tool nodes can sit between visible turns. Follow the branch back to
  // the closest preceding user turn instead of assuming the direct parent is
  // always the user message we render above this reply.
  let userKey = assistantNode.parent ?? "";
  const visited = new Set([assistantKey]);
  while (userKey && mapping[userKey] && !visited.has(userKey)) {
    visited.add(userKey);
    if (mapping[userKey]?.message?.author?.role === "user") break;
    userKey = mapping[userKey]?.parent ?? "";
  }
  const userNode = userKey ? mapping[userKey] : null;
  if (userNode?.message?.author?.role !== "user") return false;

  const previousKey = userNode?.parent ?? "";
  const childKeys = Object.keys(mapping).filter((key) => mapping[key]?.parent === assistantKey);
  childKeys.forEach((key) => { mapping[key].parent = previousKey; });
  delete mapping[assistantKey];
  if (userKey) delete mapping[userKey];
  if (conversation.current_node === assistantKey || conversation.current_node === userKey) {
    conversation.current_node = childKeys[0] ?? previousKey;
  }
  return true;
}

const AVATAR_PALETTE = [
  "#8b5cf6", "#ec4899", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6",
];

const ARCHIVE_STORE = "local-archive-viewer";
const ARCHIVE_KEY = "active-import";

function archiveDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ARCHIVE_STORE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("archives");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function persistedArchiveFile() {
  try {
    const database = await archiveDatabase();
    const record = await new Promise((resolve, reject) => {
      const request = database.transaction("archives", "readonly").objectStore("archives").get(ARCHIVE_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    if (!record?.blob || !record?.name) return null;
    return new File([record.blob], record.name, { type: record.type || "", lastModified: record.lastModified || Date.now() });
  } catch (error) {
    console.warn("无法恢复本地导入", error);
    return null;
  }
}

async function persistArchiveFile(file) {
  try {
    const database = await archiveDatabase();
    await new Promise((resolve, reject) => {
      const request = database.transaction("archives", "readwrite").objectStore("archives").put({
        blob: file,
        name: file.name,
        type: file.type,
        lastModified: file.lastModified,
      }, ARCHIVE_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    database.close();
  } catch (error) {
    console.warn("无法保存本地导入", error);
  }
}

async function clearPersistedArchive() {
  try {
    const database = await archiveDatabase();
    await new Promise((resolve, reject) => {
      const request = database.transaction("archives", "readwrite").objectStore("archives").delete(ARCHIVE_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    database.close();
  } catch (error) {
    console.warn("无法清除本地导入", error);
  }
}

function mountEmptyState(thread, message) {
  const state = document.createElement("div");
  state.className = "cgpt-empty";
  const copy = document.createElement("p");
  copy.textContent = message;
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = "import";
  button.textContent = "导入 ChatGPT 导出";
  state.append(copy, button);
  thread.replaceChildren(state);
}

export function bootstrap() {
  const ui = {
    app: element("#app"),
    sidebar: element("#sidebar-shell"),
    mainShell: element(".cgpt-main-shell"),
    backdrop: element("#sidebar-backdrop"),
    history: element("#history-list"),
    pinnedHistory: element("#pinned-list"),
    historyScrollport: element(".cgpt-history-scrollport"),
    historyProgress: element(".cgpt-sidebar-history-progress > span"),
    pinnedSection: element("#pinned-section"),
    recentSection: element("#recent-section"),
    thread: element("#thread"),
    scrollRoot: element("#scroll-root"),
    scrollToBottom: element("#scroll-to-bottom"),
    threadToc: element("#thread-toc"),
    menu: element("#menu"),
    selectionToolbarAnchor: element("#selection-toolbar-anchor"),
    toast: element("#toast"),
    picker: element("#archive-picker"),
    dropTarget: element("#drop-target"),
    composer: element("#composer"),
    composerContainer: element(".cgpt-composer-container"),
    threadFooter: element(".cgpt-thread-footer"),
    importPage: element("#import-page"),
    importStatus: element("#import-status"),
    importZone: element("#import-dropzone"),
    thinking: element('.cgpt-thinking-button[data-action="thinking"]'),
    footerActions: element('[data-testid="composer-footer-actions"]'),
    voice: element('[data-action="voice"]'),
    prompt: element("#prompt"),
    send: element("#send"),
    composerSurface: element("[data-composer-surface]"),
    composerExpand: element('[data-action="toggle-composer-expand"]'),
    sidebarToggle: element("#sidebar-toggle"),
    collapsedToggle: element("#collapsed-sidebar-toggle"),
    sidebarClose: element('[data-action="close-sidebar"]'),
    pinnedButton: element('[data-action="open-pinned"]'),
    recentButton: element('[data-action="open-more"]'),
  };

  const requiredUi = [
    "app", "sidebar", "backdrop", "history", "pinnedHistory", "thread", "scrollRoot",
    "menu", "selectionToolbarAnchor", "toast", "picker", "dropTarget", "composer",
    "prompt", "send", "composerSurface", "sidebarToggle", "sidebarClose",
  ];
  if (requiredUi.some((key) => !ui[key])) {
    console.error("本地查看器初始化失败，缺少节点：", requiredUi.filter((key) => !ui[key]));
    return;
  }
  hydrateIcons(document);
  const selectionState = { textarea: null, start: 0, end: 0 };
  const linkSelectionOverlay = document.createElement("div");
  linkSelectionOverlay.className = "cgpt-link-selection-overlay";
  linkSelectionOverlay.hidden = true;
  document.body.append(linkSelectionOverlay);
  const updateLinkSelectionOverlay = () => {
    const textarea = selectionState.textarea;
    if (!textarea || textarea.dataset.linkSelectionActive !== "true") {
      linkSelectionOverlay.hidden = true;
      return;
    }
    const styles = getComputedStyle(textarea);
    const bounds = textarea.getBoundingClientRect();
    linkSelectionOverlay.style.left = `${bounds.left - textarea.scrollLeft}px`;
    linkSelectionOverlay.style.top = `${bounds.top - textarea.scrollTop}px`;
    linkSelectionOverlay.style.width = `${textarea.clientWidth}px`;
    linkSelectionOverlay.style.height = `${textarea.clientHeight}px`;
    linkSelectionOverlay.style.boxSizing = styles.boxSizing;
    linkSelectionOverlay.style.padding = styles.padding;
    linkSelectionOverlay.style.border = styles.border;
    linkSelectionOverlay.style.font = styles.font;
    linkSelectionOverlay.style.letterSpacing = styles.letterSpacing;
    linkSelectionOverlay.style.lineHeight = styles.lineHeight;
    linkSelectionOverlay.replaceChildren(
      document.createTextNode(textarea.value.slice(0, selectionState.start)),
      Object.assign(document.createElement("span"), { textContent: textarea.value.slice(selectionState.start, selectionState.end) }),
      document.createTextNode(textarea.value.slice(selectionState.end)),
    );
    linkSelectionOverlay.hidden = false;
  };
  const selectionTextareas = () => [ui.prompt, ...document.querySelectorAll(".cgpt-edit-textarea")].filter(Boolean);
  const hideSelectionToolbar = () => {
    ui.selectionToolbarAnchor.hidden = true;
    if (selectionState.textarea) delete selectionState.textarea.dataset.linkSelectionActive;
    linkSelectionOverlay.hidden = true;
  };
  const showSelectionToolbar = (textarea) => {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (start === end) return hideSelectionToolbar();
    const selected = textarea.value.slice(start, end);
    const leadingStars = selected.match(/^\*+/)?.[0].length ?? 0;
    const trailingStars = selected.match(/\*+$/)?.[0].length ?? 0;
    const markerCount = leadingStars > 0 && leadingStars === trailingStars
      && selected.length > leadingStars * 2 ? leadingStars : 0;
    ["bold", "italic"].forEach((format) => {
      const item = ui.selectionToolbarAnchor.querySelector(`[data-selection-format="${format}"]`);
      const isBold = markerCount >= 2;
      const isItalic = markerCount === 1 || markerCount >= 3;
      const active = format === "bold" ? isBold : isItalic;
      item.setAttribute("aria-pressed", String(active));
      item.dataset.state = active ? "on" : "off";
    });
    const linkEditor = ui.selectionToolbarAnchor.querySelector(".cgpt-selection-link-editor");
    const linkPreview = ui.selectionToolbarAnchor.querySelector(".cgpt-selection-link-preview");
    const styleMenu = ui.selectionToolbarAnchor.querySelector(".cgpt-selection-style-menu");
    linkEditor.hidden = true;
    linkPreview.hidden = true;
    styleMenu.hidden = true;
    const styleAnchor = ui.selectionToolbarAnchor.querySelector(".cgpt-style-menu-anchor");
    if (styleAnchor) styleAnchor.hidden = false;
    ui.selectionToolbarAnchor.querySelectorAll(".cgpt-selection-toolbar > button").forEach((item) => { item.hidden = false; item.dataset.open = "false"; });
    selectionState.textarea = textarea; selectionState.start = start; selectionState.end = end;
    const before = textarea.value.slice(0, start);
    const styles = getComputedStyle(textarea);
    const mirror = showSelectionToolbar.mirror ?? (showSelectionToolbar.mirror = document.createElement("div"));
    mirror.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;white-space:pre-wrap;overflow-wrap:break-word;word-break:break-word;";
    const textareaBounds = textarea.getBoundingClientRect();
    mirror.style.left = `${textareaBounds.left - textarea.scrollLeft}px`;
    mirror.style.top = `${textareaBounds.top - textarea.scrollTop}px`;
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.style.boxSizing = styles.boxSizing;
    mirror.style.padding = styles.padding;
    mirror.style.border = styles.border;
    mirror.style.font = styles.font;
    mirror.style.letterSpacing = styles.letterSpacing;
    mirror.style.lineHeight = styles.lineHeight;
    const marker = document.createElement("span");
    marker.textContent = textarea.value.slice(start, start + 1) || "\u200b";
    const endMarker = document.createElement("span");
    endMarker.textContent = "\u200b";
    mirror.replaceChildren(
      document.createTextNode(before),
      marker,
      document.createTextNode(textarea.value.slice(start + 1, end)),
      endMarker,
    );
    document.body.append(mirror);
    const markerBounds = marker.getBoundingClientRect();
    const endMarkerBounds = endMarker.getBoundingClientRect();
    mirror.remove();
    const bounds = textarea.getBoundingClientRect();
    const left = markerBounds.left;
    const top = markerBounds.top - 44;
    const selectionTopOutside = markerBounds.top < bounds.top || markerBounds.top > bounds.bottom;
    const anchorContainer = textarea.classList.contains("cgpt-edit-textarea")
      ? textarea.closest(".cgpt-turn")
      : (ui.composerContainer || textarea.closest(".cgpt-composer-container"));
    const composerBounds = anchorContainer?.getBoundingClientRect();
    if (selectionTopOutside && composerBounds) {
      ui.selectionToolbarAnchor.dataset.composerAnchored = "true";
      ui.selectionToolbarAnchor.style.left = `${composerBounds.left + composerBounds.width / 2}px`;
      ui.selectionToolbarAnchor.style.top = `${composerBounds.top - 44}px`;
    } else {
      delete ui.selectionToolbarAnchor.dataset.composerAnchored;
      ui.selectionToolbarAnchor.style.left = `${Math.max(8, Math.min(window.innerWidth - 320, left))}px`;
      ui.selectionToolbarAnchor.style.top = `${Math.max(8, top)}px`;
    }
    ui.selectionToolbarAnchor.hidden = false;
  };
  document.addEventListener("selectionchange", () => {
    const textarea = document.activeElement;
    if (selectionTextareas().includes(textarea)) {
      if (textarea.selectionStart === textarea.selectionEnd) hideSelectionToolbar();
      else showSelectionToolbar(textarea);
    }
  });
  // A click on the composer surface (or any other non-editor element) can
  // collapse the native range without producing a textarea selectionchange.
  // Clear the floating controls at the same interaction boundary instead of
  // leaving a stale toolbar visible.
  document.addEventListener("pointerdown", (event) => {
    if (ui.selectionToolbarAnchor.contains(event.target)) return;
    if (selectionTextareas().includes(event.target)) return;
    hideSelectionToolbar();
  }, true);
  document.addEventListener("pointerup", (event) => {
    if (ui.selectionToolbarAnchor.contains(event.target)) return;
    window.setTimeout(() => {
      const selectedTextarea = selectionTextareas().find((textarea) => textarea.selectionStart !== textarea.selectionEnd);
      if (selectedTextarea) showSelectionToolbar(selectedTextarea);
      else hideSelectionToolbar();
    }, 0);
  }, true);
  const refreshSelectionToolbar = () => {
    if (selectionState.textarea && selectionState.textarea.selectionStart !== selectionState.textarea.selectionEnd) {
      showSelectionToolbar(selectionState.textarea);
    }
  };
  document.addEventListener("scroll", refreshSelectionToolbar, true);
  window.addEventListener("resize", refreshSelectionToolbar);
  ui.selectionToolbarAnchor.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".cgpt-selection-link-editor input")) event.preventDefault();
  });
  ui.selectionToolbarAnchor.addEventListener("click", (event) => {
    const button = event.target.closest("[data-selection-format]");
    const textarea = selectionState.textarea;
    if (!button || !textarea) return;
    if (button.dataset.selectionFormat === "text") {
      const menu = ui.selectionToolbarAnchor.querySelector(".cgpt-selection-style-menu");
      menu.hidden = !menu.hidden;
      button.dataset.open = String(!menu.hidden);
      const anchor = button.closest(".cgpt-style-menu-anchor");
      if (!menu.hidden && anchor) {
        anchor.removeAttribute("data-menu-side");
        const menuBounds = menu.getBoundingClientRect();
        const buttonBounds = button.getBoundingClientRect();
        if (buttonBounds.bottom + menuBounds.height + 8 > window.innerHeight) {
          anchor.dataset.menuSide = "top";
        }
      }
      return;
    }
    if (button.dataset.selectionFormat === "link") {
      const editor = ui.selectionToolbarAnchor.querySelector(".cgpt-selection-link-editor");
      const input = editor.querySelector("input");
      input.value = "";
      editor.querySelector("[data-selection-link-apply]").disabled = true;
      editor.hidden = false;
      textarea.dataset.linkSelectionActive = "true";
      updateLinkSelectionOverlay();
      button.closest(".cgpt-selection-toolbar")?.querySelector(".cgpt-style-menu-anchor")?.setAttribute("hidden", "");
      ui.selectionToolbarAnchor.querySelectorAll(".cgpt-selection-toolbar > button").forEach((item) => { item.hidden = true; });
      textarea.setSelectionRange(selectionState.start, selectionState.end);
      window.requestAnimationFrame(() => {
        textarea.setSelectionRange(selectionState.start, selectionState.end);
        input.focus({ preventScroll: true });
      });
      return;
    }
    const selected = textarea.value.slice(selectionState.start, selectionState.end);
    const format = button.dataset.selectionFormat;
    let replacement = selected;
    let nextStart = selectionState.start;
    let nextEnd = selectionState.start;
    if (format === "bold" || format === "italic") {
      const leadingStars = selected.match(/^\*+/)?.[0].length ?? 0;
      const trailingStars = selected.match(/\*+$/)?.[0].length ?? 0;
      const markerCount = leadingStars > 0
        && leadingStars === trailingStars
        && selected.length > leadingStars * 2
        ? leadingStars
        : 0;
      const boldWrapped = markerCount >= 2;
      const italicWrapped = markerCount === 1 || markerCount >= 3;
      const plain = markerCount ? selected.slice(markerCount, -markerCount) : selected;
      const nextBold = format === "bold" ? !boldWrapped : boldWrapped;
      const nextItalic = format === "italic" ? !italicWrapped : italicWrapped;
      replacement = `${nextBold ? "**" : ""}${nextItalic ? "*" : ""}${plain}${nextItalic ? "*" : ""}${nextBold ? "**" : ""}`;
      nextStart = selectionState.start;
      nextEnd = nextStart + replacement.length;
    } else if (format === "link") {
      replacement = `[${selected}](url)`;
      nextStart = selectionState.start;
      nextEnd = nextStart + replacement.length;
    }
    textarea.setRangeText(replacement, selectionState.start, selectionState.end, "select");
    textarea.setSelectionRange(nextStart, nextEnd);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    delete textarea.dataset.linkSelectionActive;
    linkSelectionOverlay.hidden = true;
    delete button.dataset.active;
    showSelectionToolbar(textarea);
  });
  ui.selectionToolbarAnchor.querySelector(".cgpt-selection-style-menu").addEventListener("click", (event) => {
    const button = event.target.closest("[data-selection-style]");
    const textarea = selectionState.textarea;
    if (!button || !textarea) return;
    const selected = textarea.value.slice(selectionState.start, selectionState.end);
    const style = button.dataset.selectionStyle;
    const prefix = { h1: "# ", h2: "## ", h3: "### ", ol: "1. ", ul: "- " }[style] ?? "";
    const content = selected.replace(/^(?:#{1,3}\s+|\d+[.)]\s+|[-*+]\s+)/, "");
    const replacement = `${prefix}${content}`;
    textarea.setRangeText(replacement, selectionState.start, selectionState.end, "select");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    const textButton = ui.selectionToolbarAnchor.querySelector('[data-selection-format="text"]');
    const styleLabels = { text: "文本", h1: "标题 1", h2: "标题 2", h3: "标题 3", ol: "编号列表", ul: "项目符号列表" };
    textButton?.querySelector("span")?.replaceChildren(document.createTextNode(styleLabels[style] ?? "文本"));
    ui.selectionToolbarAnchor.querySelectorAll("[data-selection-style]").forEach((item) => item.setAttribute("aria-checked", String(item === button)));
    ui.selectionToolbarAnchor.querySelector(".cgpt-selection-style-menu").hidden = true;
    ui.selectionToolbarAnchor.querySelector(".cgpt-style-menu-anchor")?.removeAttribute("data-menu-side");
    ui.selectionToolbarAnchor.querySelector('[data-selection-format="text"]').dataset.open = "false";
    showSelectionToolbar(textarea);
  });
  ui.selectionToolbarAnchor.querySelector("[data-selection-link-apply]").addEventListener("click", () => {
    const textarea = selectionState.textarea;
    const url = ui.selectionToolbarAnchor.querySelector(".cgpt-selection-link-editor input").value.trim();
    if (!textarea || !url) return;
    let linkStart = selectionState.start;
    let linkEnd = selectionState.end;
    const containingLink = /\[.*\]\([^)]*\)/g;
    let candidate;
    while ((candidate = containingLink.exec(textarea.value))) {
      const end = candidate.index + candidate[0].length;
      if (candidate.index <= selectionState.start && end >= selectionState.end) {
        linkStart = candidate.index;
        linkEnd = end;
      }
    }
    const selected = textarea.value.slice(linkStart, linkEnd);
    let linkText = selected;
    let existingLink = linkText.match(/^\[(.*)\]\(([^()]*)\)$/);
    while (existingLink) {
      linkText = existingLink[1];
      existingLink = linkText.match(/^\[(.*)\]\(([^()]*)\)$/);
    }
    const replacement = `[${linkText}](${url})`;
    textarea.setRangeText(replacement, linkStart, linkEnd, "select");
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(linkStart, linkStart + replacement.length);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    const preview = ui.selectionToolbarAnchor.querySelector(".cgpt-selection-link-preview");
    preview.querySelector("[data-link-preview]").textContent = replacement;
    ui.selectionToolbarAnchor.querySelector(".cgpt-selection-link-editor").hidden = true;
    preview.hidden = false;
  });
  ui.selectionToolbarAnchor.querySelector("[data-link-edit]").addEventListener("click", () => {
    const preview = ui.selectionToolbarAnchor.querySelector(".cgpt-selection-link-preview");
    const editor = ui.selectionToolbarAnchor.querySelector(".cgpt-selection-link-editor");
    const value = preview.querySelector("[data-link-preview]").textContent.match(/\((.*)\)$/)?.[1] ?? "";
    editor.querySelector("input").value = value;
    editor.querySelector("button").disabled = !value;
    preview.hidden = true;
    editor.hidden = false;
    if (selectionState.textarea) selectionState.textarea.dataset.linkSelectionActive = "true";
  });
  ui.selectionToolbarAnchor.querySelector(".cgpt-selection-link-editor input").addEventListener("input", (event) => {
    event.currentTarget.nextElementSibling.disabled = !event.currentTarget.value.trim();
  });
  ui.selectionToolbarAnchor.querySelector(".cgpt-selection-link-editor input").addEventListener("focus", () => {
    const textarea = selectionState.textarea;
    if (!textarea) return;
    const restore = () => {
      if (selectionState.textarea === textarea && textarea.dataset.linkSelectionActive === "true") {
        textarea.setSelectionRange(selectionState.start, selectionState.end);
      }
    };
    restore();
    window.requestAnimationFrame(restore);
  });
  document.querySelectorAll('.cgpt-composer-pill-remove[data-icon="cross"]').forEach((el) => {
    el.removeAttribute('data-icon');
    el.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" focusable="false"><path d="M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.4"></path></svg>';
  });

  const desktopLayout = window.matchMedia("(min-width: 768px)");

  const state = {
    activeId: "",
    archive: null,
    entries: [],
    filter: "",
    menuTurn: null,
    menuHistoryEntry: null,
    menuAnchor: null,
    subMenu: null,
    preserveMenuAfterRename: false,
    importRequestId: 0,
    mergeRequested: false,
    mergedArchive: false,
    sidebar: {
      // Start desktop layouts with the history rail collapsed. Users can
      // reopen it through the rail toggle; imported archives may still apply
      // their own focused/multi-conversation preference below.
      desktopCollapsed: true,
      mobileOpen: false,
    },
    toastTimer: 0,
  };
  const updatePinnedVisibility = (visibleEntries = state.entries) => {
    const hasPinned = visibleEntries.some(({ conversation }) => Boolean(conversation?.is_pinned ?? conversation?.pinned));
    const hasRecent = visibleEntries.some(({ conversation }) => !Boolean(conversation?.is_pinned ?? conversation?.pinned));
    ui.pinnedButton.hidden = !hasPinned;
    ui.pinnedSection.hidden = !hasPinned;
    ui.recentButton.hidden = !hasRecent;
    ui.recentSection.hidden = !hasRecent;
    if (state.menuAnchor && (state.menuAnchor === ui.pinnedButton || state.menuAnchor === ui.recentButton) && state.menuAnchor.hidden) closeMenu();
  };
  const updateHistoryProgress = () => {
    const scrollport = ui.historyScrollport;
    if (!scrollport || !ui.historyProgress) return;
    const range = scrollport.scrollHeight - scrollport.clientHeight;
    const thumbHeight = range > 0 ? Math.max(10, scrollport.clientHeight * scrollport.clientHeight / scrollport.scrollHeight) : 0;
    ui.historyProgress.style.height = `${thumbHeight}px`;
    ui.historyProgress.style.transform = `translateY(${range > 0 ? (scrollport.clientHeight - thumbHeight) * scrollport.scrollTop / range : 0}px)`;
    ui.historyProgress.parentElement.toggleAttribute("data-visible", range > 0);
  };

  const notify = (message) => {
    window.clearTimeout(state.toastTimer);
    ui.toast.textContent = message;
    ui.toast.dataset.open = "true";
    state.toastTimer = window.setTimeout(() => {
      delete ui.toast.dataset.open;
    }, 2200);
  };

  const setImportMode = (visible, message = "") => {
    ui.app.dataset.uiState = visible ? "import" : "archive";
    ui.importPage.hidden = !visible;
    if (message) ui.importStatus.textContent = message;
  };

  const updateScrollToBottom = () => {
    const { scrollTop, scrollHeight, clientHeight } = ui.scrollRoot;
    const distanceToBottom = scrollHeight - clientHeight - scrollTop;
    ui.scrollToBottom.hidden = !(scrollHeight > clientHeight && distanceToBottom > 80);
  };

  const updateThreadTocVisibility = () => {
    if (ui.threadToc.hidden) return;
    const messageBounds = [...ui.thread.querySelectorAll(".cgpt-turn")]
      .map((turn) => turn.getBoundingClientRect())
      .reduce((bounds, current) => {
        if (!bounds) return current;
        return {
          left: Math.min(bounds.left, current.left),
          right: Math.max(bounds.right, current.right),
          top: Math.min(bounds.top, current.top),
          bottom: Math.max(bounds.bottom, current.bottom),
        };
      }, null);
    const tocLeft = window.innerWidth - 16 - 36;
    const tocRight = window.innerWidth - 16;
    ui.threadToc.toggleAttribute(
      "data-toc-overlaps-thread",
      Boolean(messageBounds && tocLeft < messageBounds.right && tocRight > messageBounds.left),
    );
  };

  const revealTocItem = (list, item) => {
    if (!list || !item) return;
    const styles = getComputedStyle(list);
    const paddingTop = parseFloat(styles.paddingTop) || 0;
    const paddingBottom = parseFloat(styles.paddingBottom) || 0;
    const listBounds = list.getBoundingClientRect();
    const itemBounds = item.getBoundingClientRect();
    const itemTop = list.scrollTop + itemBounds.top - listBounds.top;
    const itemBottom = itemTop + itemBounds.height;
    const visibleTop = list.scrollTop + paddingTop;
    const visibleBottom = list.scrollTop + list.clientHeight - paddingBottom;
    if (itemTop < visibleTop) list.scrollTop = Math.max(0, itemTop - paddingTop);
    else if (itemBottom > visibleBottom) list.scrollTop = Math.max(0, itemBottom - list.clientHeight + paddingBottom);
  };

  const renderThreadToc = () => {
    const prompts = [...ui.thread.querySelectorAll('.cgpt-turn[data-role="user"]')];
    ui.threadToc.replaceChildren();
    ui.threadToc.hidden = prompts.length < 5;
    if (prompts.length < 5) return;

    const rail = document.createElement("div");
    rail.className = "cgpt-thread-toc-rail";
    const railTrack = document.createElement("div");
    railTrack.className = "cgpt-thread-toc-track";
    const list = document.createElement("div");
    list.className = "cgpt-thread-toc-menu";
    const jumpToTurn = (turn) => {
      const previousBehavior = ui.scrollRoot.style.scrollBehavior;
      ui.scrollRoot.style.scrollBehavior = "auto";
      const rootBounds = ui.scrollRoot.getBoundingClientRect();
      const turnBounds = turn.getBoundingClientRect();
      ui.scrollRoot.scrollTop += turnBounds.top - rootBounds.top - 16;
      ui.scrollRoot.style.scrollBehavior = previousBehavior;
    };
    prompts.forEach((turn, index) => {
      const label = turn.querySelector('.cgpt-message-content')?.innerText?.trim().replace(/\s+/g, " ") || `Prompt ${index + 1}`;
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "cgpt-thread-toc-dot";
      dot.setAttribute("aria-label", `Prompt ${index + 1}`);
      dot.dataset.tocItemIndex = String(index);
      dot.addEventListener("click", () => jumpToTurn(turn));
      railTrack.append(dot);

      const itemShell = document.createElement("li");
      const item = document.createElement("button");
      item.type = "button";
      item.className = "cgpt-thread-toc-item";
      const itemContent = document.createElement("div");
      itemContent.className = "cgpt-thread-toc-item-content";
      itemContent.textContent = label;
      itemContent.title = label;
      const itemFlex = document.createElement("div");
      itemFlex.className = "cgpt-thread-toc-item-flex";
      itemFlex.append(itemContent);
      item.append(itemFlex);
      item.dataset.tocItemIndex = String(index);
      item.dataset.fill = "";
      item.addEventListener("click", () => jumpToTurn(turn));
      itemShell.append(item);
      list.append(itemShell);
    });
    rail.append(railTrack);
    ui.threadToc.append(rail, list);
    const revealCurrentTocItem = () => {
      const current = list.querySelector(".cgpt-thread-toc-item[data-active]");
      revealTocItem(list, current);
    };
    ui.threadToc.onmouseenter = revealCurrentTocItem;
    ui.threadToc.onfocusin = revealCurrentTocItem;
    updateThreadTocVisibility();
  };

  const updateThreadToc = () => {
    const prompts = [...ui.thread.querySelectorAll('.cgpt-turn[data-role="user"]')];
    if (ui.threadToc.hidden || !prompts.length) return;
    let active = 0;
    prompts.forEach((turn, index) => { if (turn.getBoundingClientRect().top - ui.scrollRoot.getBoundingClientRect().top <= 48) active = index; });
    ui.threadToc.querySelectorAll('[data-toc-item-index]').forEach((item) => {
      const selected = Number(item.dataset.tocItemIndex) === active;
      item.toggleAttribute("data-toc-active", selected);
      if (item.classList.contains("cgpt-thread-toc-item")) item.toggleAttribute("data-active", selected);
    });
    revealTocItem(ui.threadToc.querySelector(".cgpt-thread-toc-menu"), ui.threadToc.querySelector(`.cgpt-thread-toc-item[data-toc-item-index="${active}"]`));
    const track = ui.threadToc.querySelector(".cgpt-thread-toc-track");
    if (track) {
      const rowStep = 10;
      const viewport = ui.threadToc.querySelector(".cgpt-thread-toc-rail")?.clientHeight ?? 0;
      const maxOffset = Math.max(0, prompts.length * rowStep - viewport + 8);
      const offset = Math.min(maxOffset, Math.max(0, active * rowStep - Math.max(0, viewport / 2 - 5)));
      track.style.transform = `translate3d(0, -${offset}px, 0)`;
    }
  };

  const closeMenu = () => {
    ui.menu.hidden = true;
    ui.menu.setAttribute("role", "menu");
    ui.menu.removeAttribute("aria-modal");
    ui.menu.removeAttribute("aria-labelledby");
    ui.menu.replaceChildren();
    state.subMenu?.remove();
    state.subMenu = null;
    state.menuTurn = null;
    state.menuHistoryEntry = null;
    if (state.menuAnchor) {
      state.menuAnchor.dataset.open = "false";
      state.menuAnchor.setAttribute("aria-expanded", "false");
      state.menuAnchor = null;
    }
  };

  const renderSidebarState = () => {
    const desktop = desktopLayout.matches;
    const sidebarVisible = desktop ? !state.sidebar.desktopCollapsed : state.sidebar.mobileOpen;

    if (desktop) {
      delete ui.sidebar.dataset.open;
      ui.backdrop.hidden = true;
      if (state.sidebar.desktopCollapsed) ui.app.dataset.sidebarCollapsed = "true";
      else delete ui.app.dataset.sidebarCollapsed;
    } else {
      delete ui.app.dataset.sidebarCollapsed;
      if (state.sidebar.mobileOpen) ui.sidebar.dataset.open = "true";
      else delete ui.sidebar.dataset.open;
      ui.backdrop.hidden = !state.sidebar.mobileOpen;
    }

    ui.sidebar.inert = !sidebarVisible;
    ui.sidebar.setAttribute("aria-hidden", String(!sidebarVisible));
    ui.app.dataset.sidebarOpen = String(sidebarVisible);
    ui.mainShell.inert = !desktop && state.sidebar.mobileOpen;
    ui.mainShell.setAttribute("aria-hidden", String(!desktop && state.sidebar.mobileOpen));
    ui.sidebarToggle.setAttribute("aria-expanded", String(sidebarVisible));
    ui.sidebarToggle.setAttribute(
      "aria-label",
      desktop
        ? (sidebarVisible ? "收起侧边栏" : "展开侧边栏")
        : (sidebarVisible ? "关闭侧边栏" : "打开侧边栏"),
    );
    if (ui.collapsedToggle) {
      ui.collapsedToggle.setAttribute("aria-expanded", String(sidebarVisible));
      ui.collapsedToggle.setAttribute("aria-label", sidebarVisible ? "收起侧边栏" : "打开侧边栏");
    }
    window.requestAnimationFrame(() => {
      updateThreadTocVisibility();
      window.setTimeout(updateThreadTocVisibility, 320);
    });
  };

  const setSidebarOpen = (open, { restoreFocus = false } = {}) => {
    const sidebarHadFocus = ui.sidebar.contains(document.activeElement);
    closeMenu();
    if (desktopLayout.matches) {
      state.sidebar.desktopCollapsed = !open;
      state.sidebar.mobileOpen = false;
      if (!open && (restoreFocus || sidebarHadFocus)) ui.sidebarToggle.focus();
      renderSidebarState();
      if (open) window.requestAnimationFrame(() => ui.sidebarClose.focus());
      return;
    }

    state.sidebar.mobileOpen = open;
    if (!open && (restoreFocus || sidebarHadFocus)) ui.sidebarToggle.focus();
    renderSidebarState();
    if (open) window.requestAnimationFrame(() => ui.sidebarClose.focus());
  };

  const applyImportSidebarPreference = () => {
    state.sidebar.desktopCollapsed = true;
    state.sidebar.mobileOpen = false;
    closeMenu();
    renderSidebarState();
  };

  const activeEntry = () => state.entries.find((entry) => entry.id === state.activeId) ?? null;
  const updateBrowserTab = (entry) => {
    const title = entry ? conversationLabel(entry.conversation) : "ChatGPT";
    document.title = title;
    if (entry) localStorage.setItem("cgpt-last-conversation-title", title);
    else localStorage.removeItem("cgpt-last-conversation-title");
  };

  const renderHistory = () => {
    const fragment = document.createDocumentFragment();
    const entries = sortEntries(state.entries);

    for (const entry of entries) {
      const item = document.createElement("div");
      item.className = "cgpt-history-entry";
      item.setAttribute("role", "listitem");
      if (entry.id === state.activeId) item.dataset.current = "true";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "cgpt-history-item";
      button.dataset.conversationId = entry.id;
      button.setAttribute("aria-label", conversationLabel(entry.conversation));
      if (entry.id === state.activeId) button.setAttribute("aria-current", "page");

      const label = document.createElement("span");
      label.textContent = conversationLabel(entry.conversation);
      button.append(label);

      const more = document.createElement("button");
      more.type = "button";
      more.className = "cgpt-history-menu-trigger";
      more.dataset.action = "history-menu";
      more.dataset.historyId = entry.id;
      more.setAttribute("aria-label", `${conversationLabel(entry.conversation)} 的更多选项`);
      more.innerHTML = icon("dots");
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "cgpt-history-pin-trigger";
      pin.dataset.action = "toggle-pin";
      pin.dataset.conversationId = entry.id;
      const pinned = Boolean(entry.conversation?.is_pinned ?? entry.conversation?.pinned);
      pin.setAttribute("aria-label", `${pinned ? "取消置顶" : "置顶"} ${conversationLabel(entry.conversation)}`);
      pin.innerHTML = icon(pinned ? "unpin-sm" : "pin-sm");
      const trailing = document.createElement("span");
      trailing.className = "cgpt-history-trailing";
      const actions = document.createElement("span");
      actions.className = "cgpt-history-actions";
      const pinIcon = document.createElement("span");
      pinIcon.className = "cgpt-history-action-icon";
      pinIcon.innerHTML = pin.innerHTML;
      pin.replaceChildren(pinIcon);
      const moreIcon = document.createElement("span");
      moreIcon.className = "cgpt-history-action-icon";
      moreIcon.innerHTML = more.innerHTML;
      more.replaceChildren(moreIcon);
      actions.append(pin, more);
      trailing.append(actions);
      item.append(button, trailing);
      item.dataset.pinned = String(Boolean(entry.conversation?.is_pinned ?? entry.conversation?.pinned));
      fragment.append(item);
    }
    const recentFragment = document.createDocumentFragment();
    const pinnedFragment = document.createDocumentFragment();
    [...fragment.children].forEach((item) => (item.dataset.pinned === "true" ? pinnedFragment : recentFragment).append(item));
    ui.pinnedHistory.replaceChildren(pinnedFragment);
    ui.history.replaceChildren(recentFragment);
    updatePinnedVisibility(entries);
  };

  const selectConversation = (id, { closeSidebar = false, targetMessageId = "", targetQuery = "" } = {}) => {
    const entry = state.entries.find((candidate) => candidate.id === id);
    if (!entry) return;

    state.activeId = entry.id;
    renderHistory();
    requestAnimationFrame(updateHistoryProgress);
    renderConversation(ui.thread, entry.conversation, state.archive?.resolver);
    renderThreadToc();
    updateBrowserTab(entry);
    if (closeSidebar) setSidebarOpen(false, { restoreFocus: true });

    window.requestAnimationFrame(() => {
      const previousBehavior = ui.scrollRoot.style.scrollBehavior;
      ui.scrollRoot.style.scrollBehavior = "auto";
      if (targetMessageId) {
        const target = ui.thread.querySelector(`.cgpt-turn[data-turn-id="${CSS.escape(targetMessageId)}"]`);
        if (target) {
          target.scrollIntoView({ block: "center", behavior: "auto" });
          const messageContent = target.querySelector(".cgpt-message-content");
          highlightSearchText(messageContent, targetQuery || state.filter.trim());
          messageContent?.querySelector(".cgpt-message-search-highlight")?.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
          messageContent?.classList.add("cgpt-search-target-highlight");
          window.setTimeout(() => {
            messageContent?.classList.remove("cgpt-search-target-highlight");
            messageContent?.querySelectorAll(".cgpt-message-search-highlight").forEach((mark) => mark.replaceWith(document.createTextNode(mark.textContent)));
          }, 3200);
        }
      } else {
        ui.scrollRoot.scrollTop = ui.scrollRoot.scrollHeight;
      }
      ui.scrollRoot.style.scrollBehavior = previousBehavior;
      updateScrollToBottom(); updateThreadToc();
    });
  };

  const setArchive = (archive, notice) => {
    const previous = state.archive;
    state.archive = archive;
    state.entries = archive.conversations.map((conversation, index) => ({
      id: entryId(conversation, index),
      conversation,
    }));
    state.activeId = sortEntries(state.entries)[0]?.id ?? "";
    state.filter = "";
    updatePinnedVisibility();
    previous?.dispose?.();
    setImportMode(false);
    renderHistory();

    if (state.activeId) selectConversation(state.activeId);
    else { mountEmptyState(ui.thread, "这个导出中没有可显示的会话。"); updateBrowserTab(null); }
    if (notice) notify(notice);
  };

  const placeMenu = (anchor) => {
    const bounds = anchor.getBoundingClientRect();
    ui.menu.hidden = false;
    const width = ui.menu.offsetWidth;
    const height = ui.menu.offsetHeight;
    const railMenu = anchor.dataset.action === "open-more" || anchor.dataset.action === "open-pinned";
    const preferredLeft = railMenu ? bounds.right : (anchor.dataset.action === "turn-menu" ? bounds.left : bounds.right - width);
    const left = Math.max(8, Math.min(preferredLeft, window.innerWidth - width - 8));
    const above = bounds.top - height - 6;
    const below = bounds.bottom + 6;
    // Radix Popper's default side is bottom; collision handling flips to top
    // only when the available space below cannot contain the menu.
    const top = railMenu
      ? Math.max(8, Math.min(bounds.top + (bounds.height - 36) / 2 - 10, window.innerHeight - height - 8))
      : (below + height <= window.innerHeight - 8 ? below : Math.max(8, above));
    ui.menu.style.left = `${left}px`;
    ui.menu.style.top = `${top}px`;
  };

  const openMenu = (anchor, items) => {
    const railMenu = anchor.dataset.action === "open-more" || anchor.dataset.action === "open-pinned";
    ui.menu.className = "cgpt-menu";
    ui.menu.toggleAttribute("data-rail-menu", railMenu);
    ui.menu.style.transform = "";
    ui.menu.style.width = "";
    ui.menu.style.height = "";
    ui.menu.style.height = "";
    ui.menu.style.maxHeight = "";
    ui.menu.style.overflowY = "";
    ui.menu.setAttribute("role", "menu");
    ui.menu.removeAttribute("aria-modal");
    ui.menu.removeAttribute("aria-labelledby");
    if (state.menuAnchor && state.menuAnchor !== anchor) {
      state.menuAnchor.dataset.open = "false";
      state.menuAnchor.setAttribute("aria-expanded", "false");
    }
    state.menuAnchor = anchor;
    anchor.dataset.open = "true";
    anchor.setAttribute("aria-expanded", "true");
    ui.menu.replaceChildren();
    for (const item of items) {
      if (item.separator) {
        ui.menu.append(document.createElement("hr"));
        continue;
      }
      if (item.labelOnly) {
        const label = document.createElement("div");
        label.className = "cgpt-menu-label";
        label.setAttribute("role", "menuitem");
        label.textContent = item.label;
        ui.menu.append(label);
        continue;
      }
      const button = document.createElement(item.action === "select-history-menu" ? "div" : "button");
      if (item.action !== "select-history-menu") button.type = "button";
      button.dataset.action = item.action;
      if (item.action === "select-history-menu") {
        button.className = "cgpt-menu-history-item";
        const label = document.createElement("span");
        label.textContent = item.label;
        button.append(label);
        const trailing = document.createElement("span");
        trailing.className = "cgpt-menu-history-actions";
        const pin = document.createElement("button");
        const menuEntry = state.entries.find((candidate) => candidate.id === item.value);
        const menuPinned = Boolean(menuEntry?.conversation?.is_pinned ?? menuEntry?.conversation?.pinned);
        pin.type = "button"; pin.dataset.action = "toggle-pin"; pin.dataset.conversationId = item.value; pin.setAttribute("aria-label", `${menuPinned ? "取消置顶" : "置顶"} ${item.label}`); pin.innerHTML = icon(menuPinned ? "unpin-sm" : "pin-sm");
        pin.style.alignItems = "center"; pin.style.justifyContent = "center";
        pin.querySelector("svg")?.style.setProperty("display", "block");
        pin.querySelector("svg")?.style.setProperty("align-self", "center");
        pin.querySelector("svg")?.style.setProperty("margin", "0");
        const more = document.createElement("button");
        more.type = "button"; more.dataset.action = "history-menu"; more.dataset.historyId = item.value; more.setAttribute("aria-label", `打开“${item.label}”的对话选项`); more.innerHTML = icon("dots");
        more.style.alignItems = "center"; more.style.justifyContent = "center";
        more.querySelector("svg")?.style.setProperty("display", "block");
        more.querySelector("svg")?.style.setProperty("align-self", "center");
        more.querySelector("svg")?.style.setProperty("margin", "0");
        const pinIcon = document.createElement("span");
        pinIcon.className = "cgpt-menu-action-icon";
        pinIcon.append(pin.querySelector("svg"));
        pin.replaceChildren(pinIcon);
        const moreIcon = document.createElement("span");
        moreIcon.className = "cgpt-menu-action-icon";
        moreIcon.append(more.querySelector("svg"));
        more.replaceChildren(moreIcon);
        const actions = document.createElement("span");
        actions.className = "cgpt-menu-history-actions-inner";
        actions.append(pin, more);
        trailing.replaceChildren(actions);
        button.append(trailing);
      }
      if (item.color) button.dataset.color = item.color;
      if (item.value) button.dataset.value = item.value;
      if (item.action === "select-history-menu" && item.value === state.activeId) {
        button.dataset.selected = "true";
        button.setAttribute("aria-current", "page");
      }
      if (item.icon) {
        const glyph = document.createElement("span");
        glyph.setAttribute("aria-hidden", "true");
        glyph.innerHTML = icon(item.icon);
        button.append(glyph);
      }
      if (item.action !== "select-history-menu") button.append(document.createTextNode(item.label));
      ui.menu.append(button);
    }
    if (items.some((item) => item.action === "select-history-menu")) {
      ui.menu.dataset.historyMenu = "true";
    } else {
      delete ui.menu.dataset.historyMenu;
    }
    placeMenu(anchor);
    if (ui.menu.dataset.historyMenu === "true" && ui.menu.scrollHeight > ui.menu.clientHeight) {
      const overflow = ui.menu.scrollHeight - ui.menu.clientHeight;
      const firstChild = ui.menu.firstElementChild;
      if (firstChild) firstChild.style.marginTop = `-${overflow}px`;
    }
  };

  const openSearch = (anchor) => {
    ui.menu.replaceChildren();
    const composerWidth = ui.composerContainer?.getBoundingClientRect().width;
    const composerBounds = ui.composerContainer?.getBoundingClientRect();
    if (composerWidth) ui.menu.style.setProperty("--cgpt-search-dialog-width", `${composerWidth}px`);
    if (composerBounds) ui.menu.style.setProperty("--cgpt-search-dialog-center", `${composerBounds.left + composerBounds.width / 2}px`);
    ui.menu.setAttribute("role", "dialog");
    ui.menu.setAttribute("aria-modal", "true");
    ui.menu.setAttribute("aria-labelledby", "global-search-modal-title");
    const panel = document.createElement("div");
    panel.className = "cgpt-search-dialog";
    panel.setAttribute("role", "search");
    const title = document.createElement("h2");
    title.id = "global-search-modal-title";
    title.className = "cgpt-sr-only";
    title.textContent = "全局搜索";
    const header = document.createElement("div");
    header.className = "cgpt-search-header";
    const input = document.createElement("input");
    input.type = "search";
    input.id = "global-search-modal-input";
    input.name = "global-search";
    input.autocomplete = "off";
    input.placeholder = "搜索…";
    input.value = state.filter;
    input.setAttribute("aria-label", "搜索");
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "cgpt-search-clear";
    clear.dataset.action = "clear-search";
    clear.textContent = "清除";
    const divider = document.createElement("span");
    divider.className = "cgpt-search-divider";
    divider.setAttribute("aria-hidden", "true");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "cgpt-search-close";
    close.dataset.action = "close-search";
    close.setAttribute("aria-label", "关闭全局搜索");
    const closeHint = document.createElement("div");
    closeHint.id = "global-search-close-hint";
    closeHint.setAttribute("role", "tooltip");
    closeHint.className = "cgpt-search-close-tooltip";
    closeHint.textContent = "关闭搜索";
    close.setAttribute("aria-describedby", closeHint.id);
    close.innerHTML = icon("cross");
    const syncClear = () => {
      const visible = Boolean(input.value);
      clear.hidden = !visible;
      divider.hidden = !visible;
    };
    const closeWrap = document.createElement("div");
    closeWrap.className = "cgpt-search-close-wrap";
    closeWrap.append(closeHint, close);
    header.append(input, clear, divider, closeWrap);
    const results = document.createElement("div");
    results.className = "cgpt-search-results";
    results.dataset.testid = "global-search-results-scroller";
    const renderResults = () => {
      results.replaceChildren();
      const query = input.value.trim().toLocaleLowerCase("zh-CN");
      const escapeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const highlight = (value, className) => {
        const text = String(value ?? "");
        if (!query) return escapeHtml(text);
        return escapeHtml(text).replace(new RegExp(`(${escapeQuery})`, "ig"), `<mark class="${className}">$1</mark>`);
      };
      const entries = sortEntries(state.entries).map((entry) => {
        const title = conversationLabel(entry.conversation);
        const records = query ? activeMessages(entry.conversation) : [];
        const match = records.find((record) => plainMessageText(record).toLocaleLowerCase("zh-CN").includes(query));
        const snippet = match ? searchResultSnippet(plainMessageText(match), query) : "";
        return { ...entry, title, snippet, match };
      }).filter((entry) => !query || entry.title.toLocaleLowerCase("zh-CN").includes(query) || entry.snippet.toLocaleLowerCase("zh-CN").includes(query));
      let listParent;
      if (query) {
        const filterBar = document.createElement("div");
        filterBar.className = "cgpt-search-filter-bar";
        filterBar.setAttribute("aria-label", "搜索结果类型筛选");
        filterBar.setAttribute("role", "tablist");
        ["全部", "聊天", "图片", "文档", "项目"].forEach((label, index) => {
          const tab = document.createElement("button");
          tab.type = "button";
          tab.className = `interactive-button-secondary cgpt-search-filter-tab ${index === 0 ? "cgpt-search-filter-tab-selected cgpt-search-first-filter-tab" : "cgpt-search-filter-tab-unselected"}`;
          tab.setAttribute("role", "tab");
          tab.setAttribute("aria-selected", String(index === 0));
          tab.tabIndex = 0;
          tab.textContent = label;
          filterBar.append(tab);
        });
        results.append(filterBar);
        listParent = results;
      } else {
        const zeroState = document.createElement("div");
        zeroState.className = "cgpt-search-zero-state";
        const section = document.createElement("section");
        section.className = "cgpt-search-zero-state-section";
        const title = document.createElement("h3");
        title.className = "cgpt-search-zero-state-title";
        title.textContent = "最近聊天";
        section.append(title);
        zeroState.append(section);
        results.append(zeroState);
        listParent = section;
      }
      const list = document.createElement("ol");
      entries.forEach((entry) => {
        const row = document.createElement("a");
        row.href = `#c/${encodeURIComponent(entry.id)}`;
        row.className = "cgpt-search-result";
        row.dataset.conversationId = entry.id;
        row.addEventListener("click", (event) => {
          event.preventDefault();
          state.filter = "";
          renderHistory();
          selectConversation(entry.id, { closeSidebar: false, targetMessageId: query && entry.match?.id ? entry.match.id : "", targetQuery: query });
          closeMenu();
        });
        row.dataset.messageId = query && entry.match?.id ? entry.match.id : "";
        const date = entry.conversation?.update_time || entry.conversation?.create_time ? new Date(Number(entry.conversation.update_time ?? entry.conversation.create_time) * 1000).toLocaleDateString() : "";
        row.innerHTML = `<span class="cgpt-search-result-preview-trigger" data-testid="global-search-result-preview-trigger"><span class="cgpt-search-outlined-result-icon">${icon("chat")}</span></span><span class="cgpt-search-result-text"><span class="cgpt-search-result-title"><span class="cgpt-search-result-title-text">${highlight(entry.title, "cgpt-search-title-highlight")}</span></span>${query && entry.snippet ? `<span class="cgpt-search-result-subtitle">${highlight(entry.snippet, "cgpt-search-subtitle-highlight")}</span>` : ""}</span>${query ? `<span class="cgpt-search-result-date">${escapeHtml(date)}</span>` : ""}`;
        list.append(row);
      });
      listParent.append(list);
    };
    input.addEventListener("input", () => {
      state.filter = input.value;
      renderHistory();
      renderResults();
      syncClear();
    });
    syncClear();
    renderResults();
    panel.append(title, header, results);
    ui.menu.append(panel);
    placeMenu(anchor);
    window.requestAnimationFrame(() => input.focus());
  };

  const hideDropTarget = () => {
    ui.dropTarget.hidden = true;
    delete ui.importZone.dataset.dragActive;
  };

  const importFile = async (file) => {
    hideDropTarget();
    if (!file) return;

    const requestId = ++state.importRequestId;

    if (ui.app.dataset.uiState === "import") {
      ui.importStatus.textContent = `正在读取 ${file.name}…`;
    }
    try {
      const archive = await importArchiveFile(file);
      if (requestId !== state.importRequestId) {
        archive.dispose?.();
        return;
      }
      applyImportSidebarPreference(archive);
      const merging = state.mergeRequested;
      if (merging) {
        const previous = state.archive || {
          conversations: state.entries.map((entry) => entry.conversation),
          resolver: null,
          dispose() {},
        };
        const previousResolver = previous.resolver;
        const nextResolver = archive.resolver;
        state.archive = {
          conversations: [mergeConversations([...previous.conversations, ...archive.conversations])],
          resolver: {
            resolve(key) { return nextResolver?.resolve?.(key) || previousResolver?.resolve?.(key) || null; },
          },
          dispose() { archive.dispose?.(); previous.dispose?.(); },
        };
        state.entries = state.archive.conversations.map((conversation, index) => ({ id: entryId(conversation, index), conversation }));
        state.activeId = state.entries[0]?.id ?? "";
        state.filter = "";
        updatePinnedVisibility();
        setImportMode(false);
        renderHistory();
        if (state.activeId) selectConversation(state.activeId);
        if (merging) {
          state.mergedArchive = true;
          notify(`已在当前窗口合并 ${file.name}`);
        }
      } else if (state.archive) {
        const previous = state.archive;
        const previousResolver = previous.resolver;
        const nextResolver = archive.resolver;
        state.archive = {
          conversations: [...previous.conversations, ...archive.conversations],
          resolver: {
            resolve(key) { return nextResolver?.resolve?.(key) || previousResolver?.resolve?.(key) || null; },
          },
          dispose() { archive.dispose?.(); previous.dispose?.(); },
        };
        state.entries = state.archive.conversations.map((conversation, index) => ({ id: entryId(conversation, index), conversation }));
        state.activeId = sortEntries(state.entries)[0]?.id ?? "";
        state.filter = "";
        updatePinnedVisibility();
        setImportMode(false);
        renderHistory();
        if (state.activeId) selectConversation(state.activeId);
      } else {
        setArchive(archive);
        state.mergedArchive = false;
      }
      state.mergeRequested = false;
      void persistArchiveFile(file);
    } catch (error) {
      if (requestId !== state.importRequestId) return;
      console.error(error);
      const message = `导入失败：${error.message || "无法读取文件"}`;
      if (ui.app.dataset.uiState === "import") ui.importStatus.textContent = message;
      notify(message);
    } finally {
      if (requestId === state.importRequestId) {
        ui.picker.value = "";
        hideDropTarget();
      }
    }
  };

  const performAction = (action, target) => {
    switch (action) {
      case "open-sidebar":
        setSidebarOpen(desktopLayout.matches ? true : !state.sidebar.mobileOpen);
        break;
      case "toggle-pinned-section": {
        const collapsed = ui.pinnedSection.hasAttribute("data-collapsed");
        ui.pinnedSection.toggleAttribute("data-collapsed", !collapsed);
        target.setAttribute("aria-expanded", String(collapsed));
        target.querySelector("use")?.setAttribute("href", `./reference/sprites-shell-097001e7.svg#chevron-${collapsed ? "down" : "right"}-sm`);
        break;
      }
      case "toggle-recent-section": {
        const heading = target.closest(".cgpt-history-heading");
        const collapsed = heading?.hasAttribute("data-collapsed");
        heading?.toggleAttribute("data-collapsed", !collapsed);
        target.setAttribute("aria-expanded", String(collapsed));
        target.querySelector("use")?.setAttribute("href", `./reference/sprites-shell-097001e7.svg#chevron-${collapsed ? "down" : "right"}-sm`);
        break;
      }
      case "close-sidebar":
        setSidebarOpen(false, { restoreFocus: true });
        break;
      case "scroll-to-bottom":
        ui.scrollRoot.scrollTo({ top: ui.scrollRoot.scrollHeight, behavior: "smooth" });
        break;
      case "toggle-composer-expand": {
        const expanded = ui.composerSurface.hasAttribute("data-manual-expanded");
        ui.composerSurface.toggleAttribute("data-manual-expanded", !expanded);
        if (expanded) {
          ui.prompt.style.height = "24px";
          ui.composerSurface.toggleAttribute("data-expanded", ui.prompt.scrollHeight > 24);
        } else {
          ui.composerSurface.toggleAttribute("data-expanded", true);
        }
        syncComposerState();
        ui.composerExpand.innerHTML = icon(expanded ? "expand" : "collapse");
        ui.composerExpand.setAttribute("aria-expanded", String(!expanded));
        ui.composerExpand.setAttribute("aria-pressed", String(!expanded));
        ui.composerExpand.setAttribute("aria-label", expanded ? "展开" : "收起");
        break;
      }
      case "import":
        state.mergeRequested = false;
        state.mergedArchive = false;
        ui.picker.click();
        break;
      case "search":
        openSearch(target);
        break;
      case "close-search":
        closeMenu();
        break;
      case "clear-search": {
        const input = ui.menu.querySelector("#global-search-modal-input");
        if (input) {
          input.value = "";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.focus();
        }
        break;
      }
      case "conversation-menu":
        if (state.menuAnchor === target) {
          closeMenu();
          break;
        }
        openMenu(target, [
          { action: "merge", label: "合并" },
          { action: "import", label: "导入" },
          { action: "close-archive", color: "danger", label: "退出" },
        ]);
        break;
      case "merge":
        state.mergeRequested = true;
        closeMenu();
        ui.picker.click();
        break;
      case "history-menu": {
        const entry = state.entries.find((candidate) => candidate.id === target.dataset.historyId);
        if (!entry) break;
        if (state.menuAnchor === ui.recentButton || state.menuAnchor === ui.pinnedButton) {
          target.closest(".cgpt-menu-history-item")?.setAttribute("data-selected", "true");
          state.subMenu?.remove();
          const submenu = document.createElement("div");
          submenu.className = "cgpt-menu cgpt-history-submenu";
          submenu.setAttribute("role", "menu");
          [{ action: "rename-conversation", icon: "edit", label: "重命名" }, { action: "delete-conversation", icon: "trash", color: "danger", label: "删除" }].forEach((item) => {
            const button = document.createElement("button"); button.type = "button"; button.dataset.action = item.action; button.dataset.value = entry.id;
            if (item.color) button.dataset.color = item.color;
            const glyph = document.createElement("span"); glyph.innerHTML = icon(item.icon); glyph.style.display = "inline-flex"; glyph.style.width = "20px"; glyph.style.height = "20px"; glyph.style.alignItems = "center"; glyph.style.justifyContent = "center"; glyph.firstElementChild?.style.setProperty("display", "block"); button.append(glyph, document.createTextNode(item.label)); submenu.append(button);
          });
          document.body.append(submenu); state.subMenu = submenu;
          const bounds = target.getBoundingClientRect();
          // Radix aligns the secondary menu to the trigger's icon rather than
          // merely aligning both button boxes. Render at the conventional
          // anchor first, then correct using the two *actual* SVG centres.
          submenu.style.top = `${bounds.bottom}px`;
          submenu.style.left = `${bounds.left}px`;
          const triggerIcon = target.querySelector("svg")?.getBoundingClientRect();
          const submenuIcon = submenu.querySelector("svg")?.getBoundingClientRect();
          const triggerCentre = triggerIcon ? triggerIcon.left + triggerIcon.width / 2 : bounds.left + bounds.width / 2;
          const submenuCentre = submenuIcon ? submenuIcon.left + submenuIcon.width / 2 : bounds.left + 18;
          const desiredLeft = submenu.getBoundingClientRect().left + (triggerCentre - submenuCentre);
          submenu.style.left = `${Math.max(8, Math.min(desiredLeft, window.innerWidth - submenu.offsetWidth - 8))}px`;
          break;
        }
        state.menuHistoryEntry = entry;
        openMenu(target, [
          { action: "rename-conversation", icon: "edit", label: "重命名", value: entry.id },
          { action: "delete-conversation", icon: "trash", color: "danger", label: "删除", value: entry.id },
        ]);
        break;
      }
      case "turn-menu":
        state.menuTurn = target.closest(".cgpt-turn");
        {
          const record = activeMessages(activeEntry()?.conversation).find((item) => item.id === state.menuTurn?.dataset.turnId);
          if (record?.role !== "assistant") {
            state.menuTurn = null;
            break;
          }
          const date = record?.createdAt ? new Date(record.createdAt * 1000) : null;
          const time = date && !Number.isNaN(date.getTime()) ? `${date.getMonth() + 1}月${date.getDate()}日，${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}` : "回复时间未知";
        openMenu(target, [
          { labelOnly: true, label: time },
          { action: "delete-turn", icon: "trash", color: "danger", label: "删除" },
        ]);
        }
        break;
      case "turn-time":
        closeMenu();
        break;
      case "delete-turn": {
        const turn = state.menuTurn;
        const entry = activeEntry();
        const record = entry && turn ? activeMessages(entry.conversation).find((item) => item.id === turn.dataset.turnId) : null;
        if (entry && record?.role === "assistant" && window.confirm("确定删除这条回复及上一条用户消息吗？") && removeAssistantTurn(entry.conversation, record)) {
          renderConversation(ui.thread, entry.conversation, state.archive?.resolver);
          renderThreadToc();
          updateScrollToBottom();
          updateThreadToc();
        }
        closeMenu();
        break;
      }
      case "copy-user-message":
      case "copy-assistant-reply": {
        const turn = target.closest(".cgpt-turn") ?? state.menuTurn;
        const text = turn?.querySelector(".cgpt-message-content")?.innerText ?? "";
        if (!text.trim()) {
          notify("没有可复制的文本");
          break;
        }
        const isUserMessage = target.dataset.action === "copy-user-message";
        const originalLabel = target.getAttribute("aria-label") || (isUserMessage ? "复制消息" : "复制回复");
        copyText(text).then(() => {
          const tooltip = turn?.querySelector('.cgpt-action-tooltip');
          const copiedLabel = isUserMessage ? "消息已复制" : "回复已复制";
          target.setAttribute("aria-label", copiedLabel);
          if (tooltip) tooltip.textContent = copiedLabel;
          const iconHolder = target.querySelector(".cgpt-turn-action-icon");
          if (iconHolder) iconHolder.innerHTML = icon("check");
          window.setTimeout(() => {
            if (!target.isConnected) return;
            target.setAttribute("aria-label", originalLabel);
            if (tooltip) tooltip.textContent = originalLabel;
            if (iconHolder) iconHolder.innerHTML = icon("copy");
          }, 2000);
        }).catch(() => {});
        closeMenu();
        break;
      }
      case "toggle-user-message": {
        const wrap = target.closest(".cgpt-message-content")?.querySelector(".cgpt-user-message-root");
        if (!wrap?.dataset.userMessageCollapsible) break;
        const collapsed = wrap.dataset.userMessageCollapsed === "true";
        wrap.dataset.userMessageCollapsed = String(!collapsed);
        target.querySelector(".cgpt-user-message-toggle-more")?.toggleAttribute("hidden", collapsed);
        target.querySelector(".cgpt-user-message-toggle-less")?.toggleAttribute("hidden", !collapsed);
        target.setAttribute("aria-expanded", String(collapsed));
        break;
      }
      case "copy-history-title": {
        const entry = state.entries.find((candidate) => candidate.id === target.dataset.value) ?? state.menuHistoryEntry;
        const title = conversationLabel(entry?.conversation);
        copyText(title).then(() => notify("已复制标题")).catch(() => notify("无法访问剪贴板"));
        closeMenu();
        break;
      }
      case "edit-turn": {
        closeMenu();
        const turn = target.closest(".cgpt-turn");
        const entry = activeEntry();
        const record = entry && turn ? activeMessages(entry.conversation).find((item) => item.id === turn.dataset.turnId) : null;
        const rawContent = record?.message?.content;
        const rawParts = Array.isArray(rawContent?.parts) ? rawContent.parts : [];
        const current = rawParts
          .map((part) => typeof part === "string" ? part : part?.text ?? part?.content ?? "")
          .filter((value) => typeof value === "string" && value.length)
          .join("\n")
          || (typeof rawContent?.content === "string" ? rawContent.content : "")
          || record?.parts?.filter((part) => part.type === "text" || part.type === "code").map((part) => part.value).join("\n")
          || "";
        if (!record) break;
        const editScrollTop = ui.scrollRoot.scrollTop;
        const restoreAfterEdit = () => {
          const previousBehavior = ui.scrollRoot.style.scrollBehavior;
          const previousAnchor = ui.scrollRoot.style.getPropertyValue("overflow-anchor");
          ui.scrollRoot.style.scrollBehavior = "auto";
          ui.scrollRoot.style.overflowAnchor = "none";
          renderConversation(ui.thread, entry.conversation, state.archive?.resolver);
          renderThreadToc();
          syncComposerState();
          ui.scrollRoot.scrollTop = editScrollTop;
          requestAnimationFrame(() => {
            ui.scrollRoot.scrollTop = editScrollTop;
            requestAnimationFrame(() => {
              ui.scrollRoot.scrollTop = editScrollTop;
              ui.scrollRoot.style.scrollBehavior = previousBehavior;
              if (previousAnchor) ui.scrollRoot.style.setProperty("overflow-anchor", previousAnchor);
              else ui.scrollRoot.style.removeProperty("overflow-anchor");
              updateScrollToBottom();
              updateThreadToc();
            });
          });
        };
        renderUserEdit(turn, current, {
          onCancel: restoreAfterEdit,
          onSave: (next) => {
            updateMessageText(entry.conversation, record.message?.id ?? record.id, next);
            restoreAfterEdit();
          }
        });
        break;
      }
      case "new-chat":
        break;
      case "share":
        if (state.menuAnchor === target) {
          closeMenu();
          break;
        }
        openMenu(target, [
          { action: "export-zip", label: "导出 ZIP" },
          { action: "export-markdown", label: "导出 MD" },
          { action: "export-conversation", label: "导出 JSON" },
          { action: "export-html", label: "导出 HTML" },
        ]);
        break;
      case "share-turn":
        notify("本地档案不会创建或上传分享链接");
        closeMenu();
        break;
      case "export-conversation": {
        const entry = state.entries.find((candidate) => candidate.id === target.dataset.value) ?? state.menuHistoryEntry ?? activeEntry();
        if (entry) {
          if (state.mergedArchive) {
            const earliest = state.archive.conversations[0];
            const filename = `${conversationLabel(earliest).replace(/[\\/:*?"<>|]/g, "_") || "merged-conversations"}.json`;
            downloadJson(filename, state.archive.conversations.map(exportConversationData));
          } else {
            downloadJson(`${conversationLabel(entry.conversation).replace(/[\\/:*?"<>|]/g, "_")}.json`, exportConversationData(entry.conversation));
          }
        }
        closeMenu();
        break;
      }
      case "export-markdown": {
        const entry = state.entries.find((candidate) => candidate.id === target.dataset.value) ?? state.menuHistoryEntry ?? activeEntry();
        if (entry) {
          downloadMarkdown(`${conversationLabel(entry.conversation).replace(/[\\/:*?"<>|]/g, "_")}.md`, entry);
        }
        closeMenu();
        break;
      }
      case "export-zip": {
        if (state.entries.length) downloadZip("Conversations.zip", state.entries);
        closeMenu();
        break;
      }
      case "export-html": {
        const entry = state.entries.find((candidate) => candidate.id === target.dataset.value) ?? state.menuHistoryEntry ?? activeEntry();
        if (entry) {
          closeMenu();
          void downloadHtml(`${conversationLabel(entry.conversation).replace(/[\\/:*?"<>|]/g, "_")}.html`, entry, state)
            .catch((error) => {
              console.error(error);
              notify(`导出失败：${error.message || "无法生成单文件 HTML"}`);
            });
        }
        break;
      }
      case "rename-conversation": {
        const entry = state.entries.find((candidate) => candidate.id === target.dataset.value) ?? activeEntry();
        if (!entry) break;
        const editingRailHistoryMenu = state.menuAnchor === ui.recentButton || state.menuAnchor === ui.pinnedButton;
        const sidebarRow = [...document.querySelectorAll(".cgpt-history-item[data-conversation-id]")]
          .find((item) => item.dataset.conversationId === entry.id);
        if (sidebarRow && !editingRailHistoryMenu) {
          closeMenu();
          const row = sidebarRow.closest(".cgpt-history-entry");
          const actions = row?.querySelector(".cgpt-history-trailing");
          sidebarRow.replaceChildren();
          sidebarRow.className = "cgpt-history-item cgpt-history-item-editing";
          sidebarRow.setAttribute("aria-disabled", "true");
          sidebarRow.dataset.editing = "true";
          const editContent = document.createElement("div");
          editContent.className = "flex min-w-0 grow items-center";
          const editorInput = document.createElement("input");
          editorInput.type = "text";
          editorInput.name = "title-editor";
          editorInput.setAttribute("aria-label", "聊天标题");
          editorInput.className = "w-full border-none bg-transparent p-0 text-sm focus:ring-0 text-token-text-primary";
          editorInput.value = conversationLabel(entry.conversation);
          editContent.append(editorInput);
          sidebarRow.append(editContent);
          if (actions) actions.hidden = true;
          let finished = false;
          const finish = (save) => {
            if (finished) return;
            finished = true;
            if (save) {
              const next = editorInput.value.trim();
              if (next) entry.conversation.title = next;
            }
            renderHistory();
            if (entry.id === state.activeId) updateBrowserTab(entry);
          };
          editorInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") { event.preventDefault(); finish(true); }
            if (event.key === "Escape") { event.preventDefault(); finish(false); }
          });
          editorInput.addEventListener("blur", () => {
            window.setTimeout(() => {
              if (row?.contains(document.activeElement)) return;
              finish(true);
            }, 0);
          });
          window.requestAnimationFrame(() => { editorInput.focus(); editorInput.select(); });
          break;
        }
        state.subMenu?.remove();
        state.subMenu = null;
        const historyItem = ui.menu.querySelector(`[data-value="${CSS.escape(entry.id)}"]`);
        if (!historyItem) break;
        historyItem.replaceChildren();
        historyItem.className = "cgpt-menu-history-item cgpt-menu-history-item-editing";
        historyItem.setAttribute("tabindex", "-1");
        historyItem.setAttribute("data-disabled", "");
        historyItem.setAttribute("data-active", "");
        historyItem.setAttribute("data-fill", "");
        historyItem.removeAttribute("data-action");
        const editContent = document.createElement("div");
        editContent.className = "flex min-w-0 grow items-center";
        const editorInput = document.createElement("input");
        editorInput.type = "text";
        editorInput.name = "title-editor";
        editorInput.setAttribute("aria-label", "聊天标题");
        editorInput.className = "w-full border-none bg-transparent p-0 text-sm focus:ring-0 text-token-text-primary cgpt-menu-history-title-editor";
        editorInput.value = conversationLabel(entry.conversation);
        editContent.append(editorInput);
        historyItem.append(editContent);
        let renameFinished = false;
        const commitRename = () => {
          if (renameFinished) return;
          renameFinished = true;
          const next = editorInput.value.trim();
          if (next) {
            entry.conversation.title = next;
            if (entry.id === state.activeId) updateBrowserTab(entry);
          }
          renderHistory();
          const menuAnchor = state.menuAnchor;
          if (menuAnchor && !menuAnchor.hidden) {
            const pinnedOnly = menuAnchor === ui.pinnedButton;
            const menuEntries = sortEntries(state.entries).filter(({ conversation }) => pinnedOnly
              ? Boolean(conversation?.is_pinned ?? conversation?.pinned)
              : !Boolean(conversation?.is_pinned ?? conversation?.pinned)).slice(0, 10);
            openMenu(menuAnchor, [{ labelOnly: true, label: pinnedOnly ? "置顶" : "最近聊天" }, ...menuEntries.map((candidate) => ({ action: "select-history-menu", label: conversationLabel(candidate.conversation), value: candidate.id }))]);
            ui.menu.querySelector(`.cgpt-menu-history-item[data-value="${CSS.escape(entry.id)}"]`)?.setAttribute("data-selected", "true");
          }
        };
        editorInput.addEventListener("keydown", (event) => {
          if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); commitRename(); }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            renameFinished = true;
            renderHistory();
            const menuAnchor = state.menuAnchor;
            if (menuAnchor && !menuAnchor.hidden) {
              const pinnedOnly = menuAnchor === ui.pinnedButton;
              const menuEntries = sortEntries(state.entries).filter(({ conversation }) => pinnedOnly
                ? Boolean(conversation?.is_pinned ?? conversation?.pinned)
                : !Boolean(conversation?.is_pinned ?? conversation?.pinned)).slice(0, 10);
              openMenu(menuAnchor, [{ labelOnly: true, label: pinnedOnly ? "置顶" : "最近聊天" }, ...menuEntries.map((candidate) => ({ action: "select-history-menu", label: conversationLabel(candidate.conversation), value: candidate.id }))]);
              ui.menu.querySelector(`.cgpt-menu-history-item[data-value="${CSS.escape(entry.id)}"]`)?.setAttribute("data-selected", "true");
            }
          }
        });
        editorInput.addEventListener("blur", (event) => { event.stopPropagation(); state.preserveMenuAfterRename = true; commitRename(); }, { once: true });
        window.requestAnimationFrame(() => { editorInput.focus(); editorInput.select(); });
        break;
      }
      case "delete-conversation": {
        const entry = state.entries.find((candidate) => candidate.id === target.dataset.value) ?? state.menuHistoryEntry ?? activeEntry();
        if (!entry) break;
        if (!window.confirm("确定删除该对话吗？")) break;
        state.entries = state.entries.filter((candidate) => candidate.id !== entry.id);
        if (state.activeId === entry.id) {
          state.activeId = sortEntries(state.entries)[0]?.id ?? "";
          if (state.activeId) selectConversation(state.activeId);
          else {
            mountEmptyState(ui.thread, "没有可显示的对话内容。");
            ui.threadToc.hidden = true;
            ui.threadToc.replaceChildren();
            updateBrowserTab(null);
          }
        }
        renderHistory();
        notify("已从本地查看器移除；原始文件未改写");
        closeMenu();
        break;
      }
      case "close-archive":
        if (!window.confirm("确定退回至主页吗？")) break;
        state.archive?.dispose?.();
        state.archive = null;
        state.entries = [];
        state.activeId = "";
        renderHistory();
        updateBrowserTab(null);
        setImportMode(true, "已退出。请拖入或选择新的导出文件。");
        void clearPersistedArchive();
        closeMenu();
        break;
      case "archive-notice":
      case "delete-notice":
      case "organize":
        closeMenu();
        break;
      case "thinking": {
        const pressed = ui.thinking.getAttribute("aria-pressed") === "true";
        const nextPressed = !pressed;
        ui.thinking.setAttribute("aria-pressed", String(nextPressed));
        ui.footerActions.removeAttribute("data-dismissed");
        ui.footerActions.toggleAttribute("data-thinking-enabled", nextPressed);
        break;
      }
      case "remove-thinking":
        ui.footerActions.setAttribute("data-dismissed", "true");
        ui.footerActions.removeAttribute("data-thinking-enabled");
        ui.thinking.setAttribute("aria-pressed", "false");
        break;
      case "voice":
        ui.voice.setAttribute("aria-pressed", String(ui.voice.getAttribute("aria-pressed") !== "true"));
        break;
      case "open-images":
      case "open-library":
      case "open-scheduled":
      case "open-plugins":
      case "open-projects":
        break;
      case "toggle-pin": {
        const entry = state.entries.find((candidate) => candidate.id === target.dataset.conversationId);
        if (entry) {
          const currentlyPinned = Boolean(entry.conversation.is_pinned ?? entry.conversation.pinned);
          if (!currentlyPinned && state.entries.filter(({ conversation }) => Boolean(conversation?.is_pinned ?? conversation?.pinned)).length >= 10) {
            ui.menu.replaceChildren();
            ui.menu.setAttribute("role", "dialog");
            ui.menu.className = "cgpt-menu cgpt-pin-limit-dialog";
            const header = document.createElement("header");
            header.className = "cgpt-pin-limit-header";
            header.innerHTML = "<h2><span class=\"text-heading-2\">最多只能置顶 10 个项目</span></h2>";
            const body = document.createElement("div");
            body.className = "cgpt-pin-limit-body";
            body.innerHTML = "<p>请先取消固定一项，再固定另一项</p>";
            const ok = document.createElement("button");
            ok.type = "button"; ok.className = "cgpt-pin-limit-confirm btn btn-primary btn-large";
            const okContent = document.createElement("div");
            okContent.className = "cgpt-pin-limit-confirm-content";
            okContent.textContent = "确定";
            ok.append(okContent);
            ok.addEventListener("click", closeMenu);
            const dialogActions = document.createElement("div");
            dialogActions.className = "cgpt-pin-limit-actions";
            dialogActions.append(ok);
            body.append(dialogActions);
            const dialogPanel = document.createElement("div");
            dialogPanel.className = "cgpt-pin-limit-panel";
            dialogPanel.setAttribute("role", "dialog");
            dialogPanel.append(header, body);
            ui.menu.append(dialogPanel); ui.menu.hidden = false;
            const sidebarBounds = ui.sidebar.getBoundingClientRect();
            const composerBounds = ui.composerContainer.getBoundingClientRect();
            ui.menu.style.left = "0";
            ui.menu.style.top = "0";
            ui.menu.style.width = "100vw";
            ui.menu.style.height = "100vh";
            ui.menu.style.transform = "none";
            dialogPanel.style.position = "fixed";
            dialogPanel.style.left = `${composerBounds.left + composerBounds.width / 2}px`;
            dialogPanel.style.top = `${sidebarBounds.top + sidebarBounds.height / 2}px`;
            dialogPanel.style.transform = "translate(-50%, -50%)";
            break;
          }
          entry.conversation.is_pinned = !Boolean(entry.conversation.is_pinned ?? entry.conversation.pinned);
          const menuAnchor = state.menuAnchor;
          const reopenRailHistoryMenu = menuAnchor === ui.pinnedButton || menuAnchor === ui.recentButton;
          renderHistory();
          closeMenu();
          if (reopenRailHistoryMenu) {
            const pinnedOnly = menuAnchor === ui.pinnedButton;
            const menuEntries = sortEntries(state.entries).filter(({ conversation }) => pinnedOnly
              ? Boolean(conversation?.is_pinned ?? conversation?.pinned)
              : !Boolean(conversation?.is_pinned ?? conversation?.pinned)).slice(0, 10);
            closeMenu();
            if (menuEntries.length && !menuAnchor.hidden) {
              openMenu(menuAnchor, [{ labelOnly: true, label: pinnedOnly ? "置顶" : "最近聊天" }, ...menuEntries.map((candidate) => ({ action: "select-history-menu", label: conversationLabel(candidate.conversation), value: candidate.id }))]);
            }
          }
        }
        break;
      }
      case "open-pinned":
      case "open-more": {
        const pinnedOnly = target.dataset.action === "open-pinned";
        const entries = sortEntries(state.entries).filter(({ conversation }) => pinnedOnly
          ? Boolean(conversation?.is_pinned ?? conversation?.pinned)
          : !Boolean(conversation?.is_pinned ?? conversation?.pinned)).slice(0, 10);
        openMenu(target, [{ labelOnly: true, label: pinnedOnly ? "置顶" : "最近聊天" }, ...entries.map((entry) => ({ action: "select-history-menu", label: conversationLabel(entry.conversation), value: entry.id }))]);
        break;
      }
      case "select-history-menu": {
        selectConversation(target.dataset.value, { closeSidebar: false });
        closeMenu();
        break;
      }
      case "profile":
      case "upgrade":
        break;
      default:
        break;
    }
  };

  document.addEventListener("click", (event) => {
    if (state.preserveMenuAfterRename) {
      state.preserveMenuAfterRename = false;
      return;
    }
    const editingHistoryItem = event.target.closest(".cgpt-history-item-editing");
    if (editingHistoryItem) return;
    const historyButton = event.target.closest(".cgpt-history-item[data-conversation-id]");
    if (historyButton) {
      closeMenu();
      selectConversation(historyButton.dataset.conversationId, { closeSidebar: !desktopLayout.matches });
      return;
    }

    const actionTarget = event.target.closest("[data-action]");
    if (actionTarget) {
      performAction(actionTarget.dataset.action, actionTarget);
      return;
    }

    if (!ui.menu.hidden && !ui.menu.contains(event.target)) closeMenu();
  });

  const repositionOpenMenu = () => {
    if (state.menuAnchor && !ui.menu.hidden) placeMenu(state.menuAnchor);
  };
  ui.scrollRoot.addEventListener("scroll", repositionOpenMenu, { passive: true });
  window.addEventListener("resize", repositionOpenMenu, { passive: true });

  ui.backdrop.addEventListener("click", () => setSidebarOpen(false, { restoreFocus: true }));
  ui.scrollRoot.addEventListener("scroll", updateScrollToBottom, { passive: true });
  ui.historyScrollport.addEventListener("scroll", updateHistoryProgress, { passive: true });
  window.addEventListener("resize", updateHistoryProgress, { passive: true });
  ui.picker.addEventListener("change", () => importFile(ui.picker.files?.[0]));
  let composerSyncFrame = 0;
  const scheduleComposerSync = () => {
    if (composerSyncFrame) return;
    composerSyncFrame = window.requestAnimationFrame(() => {
      composerSyncFrame = 0;
      syncComposerState();
    });
  };
  const syncComposerState = () => {
    const hasText = Boolean(ui.prompt.value.trim());
    // Measure from the natural height. Resetting to 24px before every
    // measurement makes repeated input events visibly oscillate between the
    // collapsed and grown states.
    ui.prompt.style.height = "auto";
    const intrinsicHeight = ui.prompt.scrollHeight;
    // The expanded grid makes the primary column wider. If this state were
    // derived from the *current* scrollHeight on every keystroke, a line that
    // wraps in the collapsed column could unwrap after expansion, immediately
    // collapse, wrap again, and flicker. Latch the automatic layout state for
    // the lifetime of a non-empty draft instead.
    const autoExpanded = hasText && (
      ui.composerSurface.hasAttribute("data-auto-expanded") || intrinsicHeight > 24
    );
    // Unlike the expanded layout, the mode-button visibility must not latch:
    // it disappears again when the current draft no longer reaches its
    // display threshold.
    const canExpand = hasText && intrinsicHeight >= 96;
    if (!hasText && ui.composerSurface.hasAttribute("data-manual-expanded")) {
      ui.composerSurface.removeAttribute("data-manual-expanded");
      ui.composerSurface.removeAttribute("data-auto-expanded");
      ui.composerSurface.removeAttribute("data-can-expand");
      ui.composerSurface.removeAttribute("data-expanded");
      ui.composerExpand.innerHTML = icon("expand");
      ui.composerExpand.setAttribute("aria-expanded", "false");
      ui.composerExpand.setAttribute("aria-pressed", "false");
      ui.composerExpand.setAttribute("aria-label", "展开");
    }
    ui.send.disabled = !hasText;
    ui.send.setAttribute("aria-disabled", String(!hasText));
    ui.composerSurface.toggleAttribute("data-has-text", hasText);
    // Positioning is handled by the source-like controls anchor in CSS.
    ui.composerExpand.style.removeProperty("top");
    // Manual expand uses the bounded grid track; do not write the collapsed
    // auto-resize height (237px) into the editor.
    if (ui.composerSurface.hasAttribute("data-manual-expanded")) {
      ui.prompt.style.height = "auto";
      ui.prompt.style.overflowY = "auto";
      updateComposerMask();
      updateScrollToBottom();
      return;
    }
    if (autoExpanded) {
      const autoMaxHeight = 237.297;
      ui.prompt.style.height = `${Math.min(Math.max(intrinsicHeight, 24), autoMaxHeight)}px`;
      ui.prompt.style.overflowY = intrinsicHeight > autoMaxHeight ? "auto" : "hidden";
    } else {
      ui.prompt.style.height = "24px";
      ui.prompt.style.overflowY = "hidden";
    }
    // Commit layout state only after the textarea has its stable measured
    // height. Toggling these attributes first changes the grid width, which
    // changes scrollHeight again and can make the composer oscillate.
    ui.composerSurface.toggleAttribute("data-auto-expanded", autoExpanded);
    ui.composerSurface.toggleAttribute(
      "data-expanded",
      autoExpanded || ui.composerSurface.hasAttribute("data-manual-expanded"),
    );
    ui.composerSurface.toggleAttribute("data-can-expand", canExpand);
    updateComposerMask();
    updateScrollToBottom();
  };
  const updateComposerMask = () => {
    const scrollable = ui.prompt.scrollHeight > ui.prompt.clientHeight + 1;
    ui.composerSurface.toggleAttribute("data-input-scrollable", scrollable);
    ui.composerSurface.toggleAttribute("data-input-scrolled", scrollable && ui.prompt.scrollTop > 1);
    ui.composerSurface.toggleAttribute("data-input-scroll-bottom", scrollable && ui.prompt.scrollTop + ui.prompt.clientHeight < ui.prompt.scrollHeight - 1);
  };
  ui.prompt.addEventListener("scroll", updateComposerMask, { passive: true });
  ui.scrollRoot.addEventListener("scroll", () => { updateScrollToBottom(); updateThreadToc(); }, { passive: true });
  ui.prompt.addEventListener("input", scheduleComposerSync);
  ui.prompt.addEventListener("paste", scheduleComposerSync);
  ui.prompt.addEventListener("cut", scheduleComposerSync);
  window.addEventListener("resize", syncComposerState, { passive: true });
  window.addEventListener("resize", updateThreadTocVisibility, { passive: true });
  const composerResizeObserver = new ResizeObserver(() => {
    // The source composer anchors this control to the surface with fixed
    // top/end insets. Do not derive `top` from the textarea: multiline and
    // expanded states change its height and would make the toggle drift.
    ui.composerExpand.style.removeProperty("top");
    updateScrollToBottom();
  });
  composerResizeObserver.observe(ui.prompt);
  composerResizeObserver.observe(ui.composerSurface);
  syncComposerState();
  ui.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    if (ui.send.disabled) return;
  });

  const beginFileDrag = (event) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    ui.dropTarget.hidden = false;
    ui.importZone.dataset.dragActive = "true";
  };
  const continueFileDrag = (event) => {
    // Edge does not always expose `Files` in `types` during dragover. Prevent
    // its default navigation regardless, then show the target when detectable.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    if (hasFileTransfer(event.dataTransfer)) ui.dropTarget.hidden = false;
  };
  const leaveFileDrag = (event) => {
    // Ignore transitions between descendants; only hide when the pointer
    // actually leaves the document. This also avoids a stale drag overlay.
    if (!event.relatedTarget || !document.documentElement.contains(event.relatedTarget)) {
      hideDropTarget();
      delete ui.importZone.dataset.dragActive;
    }
  };
  const dropFile = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const file = importedFile(event.dataTransfer);
    hideDropTarget();
    delete ui.importZone.dataset.dragActive;
    if (file) importFile(file);
    else if (hasFileTransfer(event.dataTransfer)) notify("请拖入 .zip、.json 或 JSON 数据文件");
  };

  // Capture phase wins over the browser's built-in file-opening behavior.
  document.addEventListener("dragenter", beginFileDrag, true);
  document.addEventListener("dragover", continueFileDrag, true);
  document.addEventListener("dragleave", leaveFileDrag, true);
  document.addEventListener("drop", dropFile, true);
  window.addEventListener("blur", hideDropTarget);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") hideDropTarget();
  });
  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      const active = document.activeElement;
      const editing = active?.matches?.("input, textarea, select, [contenteditable='true']");
      if (!editing) {
        event.preventDefault();
        closeMenu();
        openSearch(document.querySelector('[data-action="search"]') || ui.sidebarToggle);
      }
      return;
    }
    if (event.key !== "Escape") return;
    closeMenu();
    if (!desktopLayout.matches) setSidebarOpen(false, { restoreFocus: true });
  });
  desktopLayout.addEventListener("change", () => {
    const sidebarHadFocus = ui.sidebar.contains(document.activeElement);
    state.sidebar.mobileOpen = false;
    renderSidebarState();
    if (sidebarHadFocus && !desktopLayout.matches) ui.sidebarToggle.focus();
  });
  const composerTooltip = element("#composer-tooltip");
  const positionComposerTooltip = (trigger) => {
    if (!composerTooltip) return;
    const panel = document.createElement("div");
    panel.className = "cgpt-tooltip-panel";
    const label = document.createElement("span");
    label.textContent = trigger.dataset.tooltip || "";
    panel.append(label);
    if (trigger.dataset.shortcut) {
      const shortcut = document.createElement("span");
      shortcut.className = "cgpt-tooltip-shortcut";
      for (const key of trigger.dataset.shortcut.split(/\s+/)) {
        const kbd = document.createElement("kbd");
        const keyText = document.createElement("span");
        keyText.textContent = key;
        kbd.append(keyText);
        shortcut.append(kbd);
      }
      panel.append(shortcut);
    }
    composerTooltip.replaceChildren(panel);
    const anchor = trigger.getBoundingClientRect();
    const panelBounds = composerTooltip.firstElementChild?.getBoundingClientRect();
    const height = panelBounds?.height || 28;
    const width = panelBounds?.width || 120;
    const gap = 8;
    // Composer controls sit at the viewport bottom; keep their shared hint above
    // the control bar so it cannot be hidden by the footer or viewport edge.
    const side = anchor.top >= height + gap ? "top" : "bottom";
    composerTooltip.dataset.side = side;
    const rawLeft = anchor.left + anchor.width / 2;
    const rawTop = side === "top" ? anchor.top - height - gap : anchor.bottom + gap;
    const margin = 8;
    const left = Math.min(Math.max(rawLeft, width / 2 + margin), window.innerWidth - width / 2 - margin);
    const top = Math.min(Math.max(rawTop, margin), window.innerHeight - height - margin);
    composerTooltip.style.left = `${left}px`;
    composerTooltip.style.top = `${top}px`;
    composerTooltip.dataset.open = "true";
  };
  document.querySelectorAll(".cgpt-composer-tooltip-trigger").forEach((trigger) => {
    trigger.addEventListener("pointerenter", () => positionComposerTooltip(trigger));
    trigger.addEventListener("mouseenter", () => positionComposerTooltip(trigger));
    trigger.addEventListener("focus", () => positionComposerTooltip(trigger));
    trigger.addEventListener("click", () => {
      composerTooltip.dataset.open = "false";
      trigger.blur();
    });
    trigger.addEventListener("blur", () => { composerTooltip.dataset.open = "false"; });
    trigger.addEventListener("pointerleave", () => { if (document.activeElement !== trigger) composerTooltip.dataset.open = "false"; });
  });
  window.addEventListener("beforeunload", () => state.archive?.dispose?.(), { once: true });

  renderSidebarState();

  const restoreArchive = async () => {
    const embedded = document.querySelector("#embedded-archive-data");
    if (embedded) {
      try {
        const data = JSON.parse(embedded.textContent || "{}");
        if (Array.isArray(data.conversations) && data.conversations.length) {
          await importFile(new File([JSON.stringify(data.conversations)], "embedded-conversations.json", { type: "application/json" }));
          if (Array.isArray(data.assets) && data.assets.length && state.archive) {
            const assets = data.assets;
            state.archive.resolver = {
              resolve(part) {
                const asset = assets.find((candidate) =>
                  (candidate.pointer && candidate.pointer === part?.pointer) ||
                  (candidate.name && candidate.name === part?.name));
                return asset?.data ? { key: asset.pointer || asset.name, name: asset.resolvedName || asset.name, url: asset.data, mimeType: asset.mimeType } : null;
              },
            };
          }
          const embeddedActiveId = data.activeId && state.entries.some((entry) => entry.id === data.activeId)
            ? data.activeId
            : state.activeId;
          if (embeddedActiveId) selectConversation(embeddedActiveId);
          return;
        }
      } catch (error) {
        console.warn("无法恢复导出的嵌入会话", error);
      }
    }
    const cachedFile = await persistedArchiveFile();
    if (cachedFile) {
      await importFile(cachedFile);
      return;
    }
    const bundledRequestId = state.importRequestId;
    loadBundledArchive()
      .then((archive) => {
        if (bundledRequestId !== state.importRequestId || state.archive) {
          archive.dispose?.();
          return;
        }
        setArchive(archive);
      })
      .catch((error) => {
        if (bundledRequestId !== state.importRequestId || state.archive) return;
        console.warn(error);
        setImportMode(true, "未找到自动加载的导出。请拖入 ChatGPT 导出，或选择文件。");
      });
  };
  void restoreArchive();
}
