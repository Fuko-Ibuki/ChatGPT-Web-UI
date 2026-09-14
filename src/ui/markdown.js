/* Safe, deliberately small renderer for the Markdown commonly stored in exports. */

function appendText(parent, value) {
  parent.append(document.createTextNode(value));
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

function latexText(value) {
  return String(value).trim()
    .replace(/\\text\{([^{}]*)\}/g, "$1")
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1/$2)")
    .replace(/\\(neq|leq|geq|times|cdot|pm|to|infty)\b/g, (_, command) => ({ neq: "≠", leq: "≤", geq: "≥", times: "×", cdot: "·", pm: "±", to: "→", infty: "∞" }[command]))
    .replace(/\^\{([^{}]*)\}/g, "^$1")
    .replace(/_\{([^{}]*)\}/g, "_$1")
    .replace(/\\([a-zA-Z]+)/g, "$1");
}

function renderLatex(parent, value) {
  const source = String(value)
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/&#x26;|&#38;/gi, "&")
    .replace(/&#x61;/gi, "a")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .trim();
  if (window.katex?.renderToString) {
    try {
      parent.innerHTML = window.katex.renderToString(source, { displayMode: parent.dataset.displayMode === "true", throwOnError: false, strict: "ignore" });
      return;
    } catch { /* fall through to the offline text fallback */ }
  }
  const fraction = source.match(/^\\frac\{([^{}]*)\}\{([^{}]*)\}$/);
  if (fraction) {
    const numerator = document.createElement("span");
    const denominator = document.createElement("span");
    numerator.textContent = latexText(fraction[1]);
    denominator.textContent = latexText(fraction[2]);
    parent.classList.add("cgpt-math-fraction");
    parent.append(numerator, denominator);
    return;
  }
  parent.textContent = latexText(source);
}

function appendInline(parent, value) {
  // Some exports JSON-escape math delimiters twice (\\\\[ ... \\\\]); normalize
  // only delimiter escapes so ordinary LaTeX commands remain untouched.
  value = String(value)
    .replaceAll("\\\\[", "\\[")
    .replaceAll("\\\\]", "\\]")
    .replaceAll("\\\\(", "\\(")
    .replaceAll("\\\\)", "\\)");
  const entityPattern = /entity\["([^"]+)","([^"]+)","([^"]*)"\]/g;
  let entityMatch;
  let entityCursor = 0;
  const entityFragment = document.createDocumentFragment();
  while ((entityMatch = entityPattern.exec(value))) {
    if (entityMatch.index > entityCursor) appendInline(entityFragment, value.slice(entityCursor, entityMatch.index));
    const entity = document.createElement("a");
    entity.className = "cgpt-entity-link";
    entity.textContent = entityMatch[2];
    entity.title = entityMatch[3] || entityMatch[2];
    entity.href = `#entity/${encodeURIComponent(entityMatch[2])}`;
    entityFragment.append(entity);
    entityCursor = entityPattern.lastIndex;
  }
  if (entityCursor) {
    if (entityCursor < value.length) appendInline(entityFragment, value.slice(entityCursor));
    parent.append(entityFragment);
    return;
  }
  const expression = /(\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]|\[([^\]]+)\]\(([^\s)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\n]+)\*|_([^_\n]+)_)/g;
  let cursor = 0;
  let match;

  while ((match = expression.exec(value))) {
    if (match.index > cursor) appendText(parent, value.slice(cursor, match.index));

    if (match[2] !== undefined || match[3] !== undefined) {
      const math = document.createElement("span");
      const isDisplay = match[3] !== undefined;
      if (isDisplay) {
        math.setAttribute("role", "math");
        math.setAttribute("data-math-source", (match[2] ?? match[3]).trim());
        math.setAttribute("data-client-katex-layout", "");
        math.dataset.displayMode = "true";
        math.style.display = "block";
      }
      renderLatex(math, match[2] ?? match[3]);
      parent.append(math);
    } else if (match[4] !== undefined) {
      const link = document.createElement("a");
      const href = safeUrl(match[5]);
      link.textContent = match[4];
      if (href) {
        link.href = href;
        link.target = "_blank";
        link.rel = "noreferrer";
      }
      parent.append(link);
    } else if (match[6] !== undefined) {
      const strong = document.createElement("strong");
      appendText(strong, match[6]);
      parent.append(strong);
    } else if (match[7] !== undefined) {
      const code = document.createElement("code");
      appendText(code, match[7]);
      parent.append(code);
    } else {
      const emphasis = document.createElement("em");
      appendText(emphasis, match[8] ?? match[9]);
      parent.append(emphasis);
    }

    cursor = expression.lastIndex;
  }

  if (cursor < value.length) appendText(parent, value.slice(cursor));
}

function appendParagraph(parent, lines) {
  if (!lines.length) return;
  const paragraph = document.createElement("p");
  // ChatGPT's Markdown renderer treats ordinary source newlines as soft
  // breaks.  Rendering each exported line as <br> inflated long replies by
  // nearly 2x compared with the original conversation.
  lines.forEach((line, index) => {
    const hardBreak = / {2}$/.test(line);
    if (index) paragraph.append(hardBreak ? document.createElement("br") : document.createTextNode(" "));
    appendInline(paragraph, line.replace(/ {2}$/, ""));
  });
  parent.append(paragraph);
}

function appendList(parent, lines, ordered) {
  const list = document.createElement(ordered ? "ol" : "ul");
  for (const line of lines) {
    const item = document.createElement("li");
    appendInline(item, line);
    list.append(item);
  }
  parent.append(list);
}

function splitTableRow(line) {
  const value = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return value.split("|").map((cell) => cell.trim());
}

function isTableDivider(line) {
  return splitTableRow(line).every((cell) => /^:?-{3,}:?$/.test(cell));
}

function appendTable(parent, headerLine, rows) {
  const container = document.createElement("div");
  container.className = "cgpt-table-container";
  const wrapper = document.createElement("div");
  wrapper.className = "cgpt-table-wrapper";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const cell of splitTableRow(headerLine)) {
    const th = document.createElement("th");
    appendInline(th, cell);
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  for (const line of rows) {
    const tr = document.createElement("tr");
    for (const cell of splitTableRow(line)) {
      const td = document.createElement("td");
      appendInline(td, cell);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrapper.append(table);

  const controls = document.createElement("div");
  controls.className = "cgpt-table-controls";
  const controlsInner = document.createElement("div");
  controlsInner.className = "cgpt-table-controls-inner";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "cgpt-table-copy";
  copy.setAttribute("aria-label", "复制表格");
  copy.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M15.1 1.785c1.693 0 3.065 1.373 3.065 3.066v6.033a3.066 3.066 0 0 1-3.065 3.065H14v1.102a3.066 3.066 0 0 1-3.066 3.064H4.9a3.066 3.066 0 0 1-3.065-3.064V9.017A3.066 3.066 0 0 1 4.9 5.952h1.102V4.85A3.066 3.066 0 0 1 9.067 1.785H15.1ZM4.9 7.282a1.735 1.735 0 0 0-1.735 1.735v6.034c0 .958.777 1.734 1.735 1.734h6.034a1.735 1.735 0 0 0 1.734-1.734V9.017a1.735 1.735 0 0 0-1.734-1.735H4.9ZM9.067 3.115c-.958 0-1.735.777-1.735 1.735v1.102h3.602a3.066 3.066 0 0 1 3.066 3.065v3.601h1.101c.958 0 1.735-.776 1.735-1.734V4.85a1.735 1.735 0 0 0-1.735-1.735H9.067Z"/></svg>';
  const tooltip = document.createElement("span");
  tooltip.className = "cgpt-table-tooltip";
  tooltip.textContent = "复制表格";
  tooltip.setAttribute("role", "tooltip");
  copy.append(tooltip);
  let copiedTimer = 0;
  const restoreCopyState = () => {
    window.clearTimeout(copiedTimer);
    copiedTimer = 0;
    delete copy.dataset.copied;
  };
  copy.addEventListener("click", async () => {
    const text = [splitTableRow(headerLine), ...rows.map(splitTableRow)].map((cells) => cells.join("\t")).join("\n");
    try { await navigator.clipboard.writeText(text); } catch {
      const area = document.createElement("textarea"); area.value = text; area.style.position = "fixed"; area.style.opacity = "0"; document.body.append(area); area.select(); document.execCommand("copy"); area.remove();
    }
    copy.dataset.copied = "true";
  });
  copy.addEventListener("pointerenter", () => window.clearTimeout(copiedTimer));
  copy.addEventListener("pointerleave", () => {
    if (copy.dataset.copied === "true") copiedTimer = window.setTimeout(restoreCopyState, 1200);
  });
  controlsInner.append(copy);
  controls.append(controlsInner);
  wrapper.append(controls);
  container.append(wrapper); parent.append(container);
}

/** Convert export Markdown into DOM nodes without evaluating supplied HTML. */
export function renderMarkdown(value) {
  const fragment = document.createDocumentFragment();
  // Display math is allowed to span several source lines. Collapse only the
  // whitespace inside \[...\] so the delimiter pair reaches KaTeX intact.
  const normalized = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, formula) => `\\[${formula.replace(/\n/g, " ")}\\]`);
  const lines = normalized.split("\n");
  let paragraph = [];
  let list = [];
  let listOrdered = false;
  let code = null;
  let codeLanguage = "";
  let quote = [];

  const flushParagraph = () => {
    appendParagraph(fragment, paragraph);
    paragraph = [];
  };
  const flushList = () => {
    appendList(fragment, list, listOrdered);
    list = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    const blockquote = document.createElement("blockquote");
    // Match the exported page's Markdown shape: blockquote > p.
    appendParagraph(blockquote, quote);
    fragment.append(blockquote);
    quote = [];
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const nextLine = lines[lineIndex + 1];
    if (code === null && line.includes("|") && nextLine && nextLine.includes("|") && isTableDivider(nextLine)) {
      flushParagraph(); flushList(); flushQuote();
      const tableRows = [];
      let index = lineIndex + 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) tableRows.push(lines[index++]);
      appendTable(fragment, line, tableRows);
      lineIndex = index - 1;
      continue;
    }
    const fence = line.match(/^```([^`]*)$/);
    if (fence) {
      flushParagraph();
      flushList();
      if (code === null) {
        code = [];
        codeLanguage = fence[1].trim();
      } else {
        const pre = document.createElement("pre");
        const node = document.createElement("code");
        if (codeLanguage) node.dataset.language = codeLanguage;
        node.textContent = code.join("\n");
        pre.append(node);
        fragment.append(pre);
        code = null;
      }
      continue;
    }

    if (code !== null) {
      code.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const displayMath = line.match(/^\\\[([\s\S]*)\\\]$/);
    const quoteMatch = line.match(/^>\s?(.*)$/);
    const thematicBreak = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
    const unordered = line.match(/^[-*+]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);

    if (displayMath) {
      flushParagraph();
      flushList();
      flushQuote();
      const math = document.createElement("span");
      math.setAttribute("role", "math");
      math.setAttribute("role", "math");
      math.setAttribute("aria-label", displayMath[1].trim());
      math.setAttribute("data-math-source", displayMath[1].trim());
      math.setAttribute("data-client-katex-layout", "");
      math.dataset.displayMode = "true";
      math.style.display = "block";
      renderLatex(math, displayMath[1]);
      fragment.append(math);
    } else if (thematicBreak) {
      flushParagraph();
      flushList();
      flushQuote();
      fragment.append(document.createElement("hr"));
    } else if (heading) {
      flushParagraph();
      flushList();
      flushQuote();
      const element = document.createElement(`h${heading[1].length}`);
      appendInline(element, heading[2]);
      fragment.append(element);
    } else if (quoteMatch) {
      flushParagraph();
      flushList();
      quote.push(quoteMatch[1]);
    } else if (unordered || ordered) {
      const orderedList = Boolean(ordered);
      flushQuote();
      if (list.length && orderedList !== listOrdered) flushList();
      listOrdered = orderedList;
      list.push((unordered ?? ordered)[1]);
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
      flushQuote();
    } else {
      flushList();
      flushQuote();
      paragraph.push(line);
    }
  }

  if (code !== null) {
    const pre = document.createElement("pre");
    const node = document.createElement("code");
    node.textContent = code.join("\n");
    pre.append(node);
    fragment.append(pre);
  }
  flushQuote();
  flushParagraph();
  flushList();
  return fragment;
}
