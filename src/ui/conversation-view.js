import { activeMessages } from "../data/archive-adapter.js";
import { icon } from "./icons.js";
import { renderMarkdown } from "./markdown.js";

function createElement(tag, className = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function formatDate(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const day = `${date.getMonth() + 1}月${date.getDate()}日${weekdays[date.getDay()]}`;
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return { day, time, key: `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` };
}

function messageTime(timestamp) {
  if (!timestamp) return null;
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  const format = (hour12) => new Intl.DateTimeFormat(undefined, {
    hour: "numeric", minute: "2-digit", hour12,
  }).format(date);
  const time = createElement("time", "cgpt-message-time");
  time.dateTime = iso;
  // The hover text follows the operating system's locale and 12/24-hour
  // preference, while datetime remains machine-readable ISO 8601.
  time.title = new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(date);
  time.innerHTML = `<span data-time-format="12">${format(true)}</span><span data-time-format="24">${format(false)}</span>`;
  return time;
}

function turnAction(action, label, glyph) {
  const button = createElement("button", "cgpt-turn-action");
  button.type = "button";
  button.dataset.action = action;
  button.setAttribute("aria-label", label);
  button.innerHTML = `<span class="cgpt-turn-action-icon" aria-hidden="true">${icon(glyph)}</span><span class="cgpt-action-tooltip" role="tooltip">${label}</span>`;
  return button;
}

function attachmentElement(part, resolver) {
  const resolved = resolver?.resolve(part);
  const anchor = createElement("a", "cgpt-attachment");
  anchor.innerHTML = `<span aria-hidden="true">${icon("projects")}</span><span></span>`;
  anchor.querySelector("span:last-child").textContent = resolved?.name ?? part.name ?? "附件";

  if (resolved) {
    anchor.href = resolved.url;
    anchor.download = resolved.name;
  } else {
    anchor.removeAttribute("href");
    anchor.setAttribute("aria-disabled", "true");
  }
  return anchor;
}

function imageElement(part, resolver) {
  const resolved = resolver?.resolve(part);
  if (!resolved) return attachmentElement(part, resolver);

  const anchor = createElement("a", "cgpt-image-attachment");
  anchor.href = resolved.url;
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  anchor.setAttribute("aria-label", `打开图片：${resolved.name}`);

  const image = document.createElement("img");
  image.src = resolved.url;
  image.alt = resolved.name;
  image.loading = "lazy";
  if (Number.isFinite(part.width)) image.width = part.width;
  if (Number.isFinite(part.height)) image.height = part.height;
  anchor.append(image);
  return anchor;
}

function codeElement(part) {
  const pre = createElement("pre", "cm-content cgpt-code-block");
  const code = document.createElement("code");
  if (part.language) code.dataset.language = part.language;
  const source = String(part.value ?? "");
  const tokenPattern = /(#[^\n]*|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b(?:if|else|elif|for|while|in|and|or|not|def|return|import|from|as|class|try|except|finally|with|print|True|False|None|const|let|var|function|new)\b|==|!=|<=|>=|%|[=+\-*/<>])/g;
  let cursor = 0;
  const appendToken = (value, className = "") => {
    const span = document.createElement("span");
    if (className) span.className = className;
    span.textContent = value;
    code.append(span);
  };
  for (const match of source.matchAll(tokenPattern)) {
    if (match.index > cursor) appendToken(source.slice(cursor, match.index));
    const value = match[0];
    const className = /^(#|\/\/)/.test(value) ? "cm-comment"
      : /^["']/.test(value) ? "cm-string"
        : /^\d/.test(value) ? "cm-number"
          : /^(if|else|elif|for|while|in|and|or|not|def|return|import|from|as|class|try|except|finally|with|print|True|False|None|const|let|var|function|new)$/.test(value) ? "cm-keyword"
            : /^(int|input|print|len|range|str|float|list|dict|[a-zA-Z_][a-zA-Z0-9_]*)$/.test(value) ? "cm-variable"
              : "cm-operator";
    appendToken(value, className);
    cursor = match.index + value.length;
  }
  if (cursor < source.length) appendToken(source.slice(cursor));
  pre.append(code);
  return pre;
}

function userTextElement(value) {
  const text = createElement("div", "cgpt-user-plain-text");
  text.textContent = String(value ?? "");
  return text;
}

export function renderUserEdit(turn, value, { onCancel, onSave } = {}) {
  const message = turn.querySelector('.cgpt-text-message');
  if (!message) return;
  const content = message.querySelector('.cgpt-message-content');
  const actions = message.querySelector('.cgpt-turn-actions');
  const shell = createElement('div', 'cgpt-edit-shell');
  const measure = createElement('span', 'cgpt-edit-measure');
  const textarea = document.createElement('textarea');
  textarea.className = 'cgpt-edit-textarea'; textarea.setAttribute('aria-label', '编辑消息');
  textarea.value = String(value ?? '');
  const sync = () => { measure.textContent = `${textarea.value} `; textarea.style.height = 'auto'; const maxHeight = window.innerHeight * .25; const measuredHeight = measure.offsetHeight; textarea.style.height = `${Math.min(measuredHeight, maxHeight)}px`; textarea.style.overflowY = measuredHeight > maxHeight ? 'auto' : 'hidden'; const disabled = !textarea.value.trim(); save.disabled = disabled; save.toggleAttribute('data-visually-disabled', disabled); save.classList.toggle('cursor-not-allowed', disabled); };
  const grid = createElement('div', 'cgpt-edit-grid'); grid.append(textarea, measure);
  const scroll = createElement('div', 'cgpt-edit-scroll'); scroll.append(grid);
  const controls = createElement('div', 'cgpt-edit-controls');
  const cancel = createElement('button', 'cgpt-edit-button cgpt-edit-button--secondary'); cancel.type='button'; cancel.textContent='取消';
  const save = createElement('button', 'cgpt-edit-button cgpt-edit-button--primary'); save.type='button'; save.textContent='保存';
  cancel.addEventListener('click', () => onCancel?.()); save.addEventListener('click', () => onSave?.(textarea.value));
  controls.append(cancel, save); shell.append(scroll, controls);
  content.replaceWith(shell); actions.hidden = true; textarea.addEventListener('input', sync); sync(); textarea.focus();
  // Focusing a long textarea places the viewport at the caret (the end of
  // the imported reply). Reset the editor viewport so the complete reply
  // starts at the top while remaining fully scrollable.
  textarea.scrollTop = 0;
}

function messageContent(record, resolver) {
  const content = createElement("div", "cgpt-message-content");
  for (const part of record.parts) {
    if (part.type === "text") {
      content.append(record.role === "user" ? userTextElement(part.value) : renderMarkdown(part.value));
    }
    else if (part.type === "code") content.append(codeElement(part));
    else if (part.type === "image") content.append(imageElement(part, resolver));
    else if (part.type === "asset") content.append(attachmentElement(part, resolver));
  }
  return content;
}

function turnActions(record) {
  const actions = createElement("div", `cgpt-turn-actions cgpt-turn-actions--${record.role}`);
  actions.setAttribute("aria-label", record.role === "assistant" ? "回复操作" : "消息操作");
  actions.setAttribute("role", "group");
  actions.append(turnAction(
    record.role === "user" ? "copy-user-message" : "copy-assistant-reply",
    record.role === "user" ? "复制消息" : "复制回复",
    "copy",
  ));

  if (record.role === "user") {
    actions.append(turnAction("edit-turn", "编辑消息", "edit"));
  } else {
    actions.append(turnAction("edit-turn", "编辑回复", "edit"));
    actions.append(turnAction("turn-menu", "更多操作", "dots"));
  }
  return actions;
}

function renderTurn(record, resolver) {
  const article = createElement("article", "cgpt-turn");
  article.dataset.turnId = record.id;
  article.dataset.role = record.role;
  article.dataset.turnIdContainer = record.id;

  const message = createElement("section", `cgpt-text-message cgpt-message--${record.role}`);
  message.dataset.testid = `conversation-turn-${record.id}`;
  message.dataset.turn = record.role;
  message.setAttribute("dir", "auto");
  message.dataset.messageAuthorRole = record.role;
  const title = createElement("h4", "cgpt-sr-only");
  title.textContent = record.role === "user" ? "你说" : "ChatGPT 说";
  const contentWrap = createElement("div", "cgpt-conversation-content");
  contentWrap.dataset.conversationScreenshotContent = "true";
  const content = messageContent(record, resolver);
  const time = messageTime(record.createdAt);
  contentWrap.append(content);
  if (record.role === "user") {
    const userRoot = createElement("div", "cgpt-user-message-root");
    while (content.firstChild) userRoot.append(content.firstChild);
    content.append(userRoot);
    const contentId = `user-message-content-${String(record.id).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    userRoot.id = contentId;
    const collapse = createElement("button", "cgpt-user-message-toggle select-none");
    collapse.type = "button";
    collapse.dataset.action = "toggle-user-message";
    collapse.setAttribute("aria-controls", contentId);
    collapse.setAttribute("aria-expanded", "false");
    const showMore = createElement("span", "cgpt-user-message-toggle-more");
    showMore.textContent = "展开";
    const showLess = createElement("span", "cgpt-user-message-toggle-less");
    showLess.textContent = "收起";
    const toggleIcon = createElement("span", "cgpt-user-message-toggle-icon");
    toggleIcon.innerHTML = icon("chevron");
    collapse.append(showMore, showLess, toggleIcon);
    collapse.hidden = true;
    // The source keeps the toggle inside the user-message bubble, directly
    // after the content, so it inherits the bubble's padding and width.
    content.append(collapse);
    requestAnimationFrame(() => {
      const plainText = userRoot.querySelector(".cgpt-user-plain-text");
      if (!plainText) return;
      const lineHeight = parseFloat(getComputedStyle(plainText).lineHeight) || 26;
      const lineCount = Math.round(plainText.scrollHeight / lineHeight);
      if (lineCount > 11) {
        userRoot.dataset.userMessageCollapsible = "true";
        userRoot.dataset.userMessageCollapsed = "true";
        collapse.setAttribute("aria-controls", contentId);
        collapse.hidden = false;
      }
    });
  }
  if (time && record.role !== "user") contentWrap.append(time);
  contentWrap.append(turnActions(record));
  message.append(title, contentWrap);
  article.append(message);
  return article;
}

function emptyState() {
  const empty = createElement("div", "cgpt-empty");
  empty.textContent = "没有可显示的对话内容。";
  return empty;
}

/** Render only the active ChatGPT branch, matching the official conversation semantics. */
export function renderConversation(container, conversation, resolver) {
  container.replaceChildren();
  if (!conversation) {
    container.append(emptyState());
    return;
  }

  const fragment = document.createDocumentFragment();
  let lastDate = "";
  const records = activeMessages(conversation);

  for (const record of records) {
    const date = formatDate(record.createdAt);
    if (date && date.key !== lastDate) {
      const marker = createElement("div", "cgpt-date-marker");
      marker.setAttribute("aria-label", `${date.day} ${date.time}`);
      marker.setAttribute("role", "separator");
      marker.innerHTML = `<span class="cgpt-date-secondary"><span class="cgpt-date-day">${date.day}</span> <span class="cgpt-date-time">${date.time}</span></span>`;
      fragment.append(marker);
      lastDate = date.key;
    }
    fragment.append(renderTurn(record, resolver));
  }

  container.append(records.length ? fragment : emptyState());
}
