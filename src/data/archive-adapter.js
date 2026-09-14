/*
 * ChatGPT export adapter
 *
 * This module is intentionally independent of the UI. It accepts native
 * ChatGPT export shapes (split conversation files, a standalone conversation
 * JSON, or a ZIP containing either) and exposes a small, read-only archive.
 */

export const DEFAULT_EXPORT_DIRECTORY = "ChatGPT-2026-07-17-00-43-07";

const decoder = new TextDecoder();

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function messageTimestamp(message, node) {
  return numberOrNull(message?.create_time) ?? numberOrNull(node?.create_time) ?? 0;
}

function isConversation(value) {
  return Boolean(asRecord(value)?.mapping && typeof value.mapping === "object");
}

function normalizeClaudeConversation(value) {
  const source = asRecord(value);
  if (!Array.isArray(source?.chat_messages)) return null;
  const mapping = {};
  let previous = null;
  source.chat_messages.forEach((message, index) => {
    const role = message?.sender === "human" ? "user" : message?.sender === "assistant" ? "assistant" : "";
    if (!role) return;
    const text = typeof message.text === "string" ? message.text : Array.isArray(message.content)
      ? message.content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n") : "";
    if (!text.trim()) return;
    const id = `claude-${index}`;
    mapping[id] = { id, parent: previous, message: { id: message.uuid ?? id, author: { role }, create_time: Date.parse(message.created_at ?? "") / 1000 || 0, content: { content_type: "text", parts: [text] } } };
    previous = id;
  });
  return previous ? { title: source.name || "Claude 对话", mapping, current_node: previous } : null;
}

function assetId(value) {
  if (typeof value !== "string") return "";
  const lastSegment = value.split("/").pop() ?? "";
  return lastSegment.replace(/\.dat$/i, "");
}

function mimeTypeFor(name = "") {
  const extension = name.split(".").pop()?.toLowerCase();
  const types = {
    avif: "image/avif",
    gif: "image/gif",
    heic: "image/heic",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    svg: "image/svg+xml",
    webp: "image/webp",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    mov: "video/quicktime",
    pdf: "application/pdf",
    txt: "text/plain",
  };
  return types[extension] ?? "application/octet-stream";
}

function findManifestKey(manifest, pointer) {
  const id = assetId(pointer);
  if (!id) return "";
  return Object.keys(manifest).find((key) => key === pointer || key.replace(/\.dat$/i, "") === id) ?? "";
}

function mergeAssetNames(manifest, libraryFiles) {
  const names = { ...(asRecord(manifest) ?? {}) };
  if (!Array.isArray(libraryFiles)) return names;

  for (const file of libraryFiles) {
    const id = typeof file?.file_id === "string" ? file.file_id : "";
    const name = typeof file?.file_name === "string" ? file.file_name : "";
    if (id && name && !names[`${id}.dat`]) names[`${id}.dat`] = name;
  }
  return names;
}

function findAttachment(message, pointer) {
  const id = assetId(pointer);
  const attachments = Array.isArray(message?.metadata?.attachments) ? message.metadata.attachments : [];
  return attachments.find((attachment) => assetId(attachment?.id) === id) ?? null;
}

// Import is responsible only for canonical line-ending data. Markdown layout
// stays intact here; the renderer decides how soft and paragraph breaks look.
function normalizeExportText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    // A run beyond one blank line carries no additional Markdown meaning.
    // Remove only those export artefacts; a single blank line remains a p boundary.
    .replace(/\n{3,}/g, "\n\n");
}

function normalizePart(value, message) {
  if (typeof value === "string") return { type: "text", value: normalizeExportText(value) };
  if (!asRecord(value)) return null;

  // Native exports store executable snippets as content_type=code with the
  // source in text. Preserve that type so the CodeMirror-like renderer can
  // apply syntax spans instead of treating the snippet as paragraph text.
  if (String(value.content_type ?? "").toLowerCase() === "code" && typeof value.text === "string") {
    return { type: "code", value: value.text, language: value.language ?? "" };
  }

  const pointer = value.asset_pointer ?? value.pointer ?? value.url ?? "";
  const attachment = findAttachment(message, pointer);
  const type = String(value.content_type ?? attachment?.mime_type ?? "");

  if (pointer || attachment) {
    return {
      type: type.includes("image") || String(attachment?.mime_type ?? "").startsWith("image/") ? "image" : "asset",
      pointer,
      name: value.name ?? attachment?.name ?? "附件",
      mimeType: attachment?.mime_type ?? "",
      width: value.width ?? attachment?.width ?? null,
      height: value.height ?? attachment?.height ?? null,
      size: value.size_bytes ?? attachment?.size ?? null,
    };
  }

  if (typeof value.text === "string") return { type: "text", value: normalizeExportText(value.text) };
  if (typeof value.content === "string") return { type: "text", value: normalizeExportText(value.content) };
  if (typeof value.name === "string") return { type: "asset", pointer: "", name: value.name, mimeType: "" };
  return null;
}

function isInternalAssistantText(value, message) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON metadata */ }
  // Gemini/ChatGPT exports can expose the hidden search request as a JSON
  // object, sometimes with other metadata before the query key. It is not
  // assistant-facing answer content and must not be rendered as a reply.
  return (parsed && typeof parsed === "object" && typeof parsed.query === "string")
    || /(?:^|[,{\s])(?:\\?["']?)query(?:\\?["']?)\s*:/i.test(text)
    || /^思考了\s*\d+(?:\.\d+)?\s*(?:秒|毫秒)?$/.test(text);
}

function normalizeMessageParts(message) {
  const content = asRecord(message?.content) ?? {};
  if (content.content_type === "reasoning_recap") return [];
  const directParts = Array.isArray(content.parts) ? content.parts : [];
  const parts = directParts
    .map((part) => normalizePart(part, message))
    .filter((part) => part && !(part.type === "text" && isInternalAssistantText(part.value, message)));
  const attachments = Array.isArray(message?.metadata?.attachments) ? message.metadata.attachments : [];

  for (const attachment of attachments) {
    const id = typeof attachment?.id === "string" ? attachment.id : "";
    if (!id || parts.some((part) => assetId(part.pointer) === assetId(id))) continue;
    const mimeType = String(attachment.mime_type ?? "");
    parts.push({
      type: mimeType.startsWith("image/") ? "image" : "asset",
      pointer: `sediment://${id}`,
      name: attachment.name ?? "附件",
      mimeType,
      width: attachment.width ?? null,
      height: attachment.height ?? null,
      size: attachment.size ?? null,
    });
  }

  if (parts.length) return parts;

  if (typeof content.content === "string" && !isInternalAssistantText(content.content, message)) {
    return [{ type: "text", value: normalizeExportText(content.content) }];
  }
  if (typeof content.text === "string") {
    if (isInternalAssistantText(content.text, message)) return [];
    return [{ type: "code", value: content.text, language: content.language ?? "" }];
  }
  if (Array.isArray(content.thoughts)) {
    return content.thoughts
      .map((thought) => typeof thought === "string" ? thought : thought?.content ?? thought?.text ?? "")
      .filter(Boolean)
      .map((value) => ({ type: "text", value: normalizeExportText(value) }));
  }
  return [];
}

/** Convert a native export object, a conversation array, or { conversations }. */
export function normalizeConversations(input, options = {}) {
  const root = asRecord(input);
  if (root?.chunkedPrompt?.chunks && Array.isArray(root.chunkedPrompt.chunks)) {
    const mapping = {};
    let previous = null;
    root.chunkedPrompt.chunks.forEach((chunk, index) => {
      // Gemini exports reasoning as normal-looking `text` alongside
      // `isThought`; it must not become a visible assistant message.
      if (chunk?.isThought) return;
      const text = typeof chunk?.text === "string" ? chunk.text : chunk?.parts?.filter((part) => !part?.thought).map((part) => part?.text ?? "").join("");
      if (!text?.trim()) return;
      const id = `gemini-${index}`;
      mapping[id] = { id, parent: previous, message: { author: { role: chunk.role === "model" ? "assistant" : "user" }, create_time: Date.parse(chunk.createTime ?? "") / 1000 || 0, content: { content_type: "text", parts: [text] } } };
      previous = id;
    });
    return previous ? [{ title: options.filename || "Gemini 对话", mapping, current_node: previous }] : [];
  }
  const candidates = Array.isArray(input)
    ? input
    : Array.isArray(root?.conversations)
      ? root.conversations
      : root
        ? [root]
        : [];
  return candidates.flatMap((candidate) => {
    if (isConversation(candidate)) return [candidate];
    const claude = normalizeClaudeConversation(candidate);
    return claude ? [claude] : [];
  });
}

/** Find the most recent leaf when an export has no usable current_node. */
export function resolveCurrentNode(conversation) {
  const mapping = asRecord(conversation?.mapping) ?? {};
  if (mapping[conversation?.current_node]) return conversation.current_node;

  const nodes = Object.entries(mapping).map(([key, node]) => ({ ...node, id: node?.id ?? key }));
  const parents = new Set(nodes.map((node) => node?.parent).filter(Boolean));
  const leaves = nodes.filter((node) => {
    if (Array.isArray(node?.children)) return node.children.length === 0;
    return !parents.has(node.id);
  });
  const candidates = (leaves.length ? leaves : nodes).filter((node) => node?.message);
  candidates.sort((a, b) => messageTimestamp(b?.message, b) - messageTimestamp(a?.message, a));
  return candidates[0]?.id ?? "";
}

/** Return the active branch, in conversation order, excluding system/tool turns. */
export function activeMessages(conversation) {
  const mapping = asRecord(conversation?.mapping) ?? {};
  const output = [];
  const visited = new Set();
  let nodeId = resolveCurrentNode(conversation);

  while (nodeId && mapping[nodeId] && !visited.has(nodeId)) {
    visited.add(nodeId);
    const node = mapping[nodeId];
    const message = node?.message;
    const role = message?.author?.role;

    if (message && (role === "user" || role === "assistant")) {
      const parts = normalizeMessageParts(message);

      if (parts.length) {
        output.push({
          id: message.id ?? node.id ?? nodeId,
          nodeId,
          node,
          message,
          role,
          parts,
          createdAt: numberOrNull(message.create_time),
        });
      }
    }

    nodeId = node?.parent ?? "";
  }

  return output.reverse();
}

export function plainMessageText(record) {
  return (record?.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.value)
    .join("\n")
    .trim();
}

/**
 * Build a resolver for either bundled files or imported ZIP Blob URLs.
 * URLs returned from imported ZIPs are revoked by archive.dispose().
 */
export function createAssetResolver(manifest = {}, { baseUrl = "", urls = new Map() } = {}) {
  const files = asRecord(manifest) ?? {};

  return {
    resolve(part) {
      const key = findManifestKey(files, part?.pointer);
      if (!key) return null;

      const name = files[key] || part?.name || key;
      const url = urls.get(key) ?? (baseUrl ? new URL(encodeURIComponent(key), baseUrl).href : "");
      if (!url) return null;
      return { key, name, url, mimeType: part?.mimeType || mimeTypeFor(name) };
    },
    dispose() {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}

function createArchive(conversations, manifest, resolver, source) {
  return {
    conversations: normalizeConversations(conversations),
    manifest: asRecord(manifest) ?? {},
    resolver,
    source,
    dispose() {
      resolver?.dispose?.();
    },
  };
}

async function fetchJson(fetchImpl, url, required = true) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    if (!required && response.status === 404) return null;
    throw new Error(`无法读取 ${new URL(url).pathname.split("/").pop()}（${response.status}）`);
  }
  return response.json();
}

/** Load the export directory that ships beside index.html. */
export async function loadBundledArchive({ fetchImpl = fetch, baseUrl = document.baseURI } = {}) {
  const directory = new URL(`${DEFAULT_EXPORT_DIRECTORY}/`, baseUrl);

  // A file:// deployment cannot enumerate the exported directory, but the
  // checked-in single-conversation export is still directly readable.
  if (directory.protocol === "file:") {
    try {
      const bundledFile = await fetchJson(
        fetchImpl,
        new URL("ChatGPT-动机与主体间性研究.json", baseUrl),
      );
      const conversations = normalizeConversations(bundledFile);
      if (conversations.length) {
        return createArchive(conversations, {}, createAssetResolver({}, { baseUrl }), "bundled");
      }
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }

  const [exportManifest, manifest, libraryFiles] = await Promise.all([
    fetchJson(fetchImpl, new URL("export_manifest.json", directory), false),
    fetchJson(fetchImpl, new URL("conversation_asset_file_names.json", directory), false),
    fetchJson(fetchImpl, new URL("library_files.json", directory), false),
  ]);

  const declaredChunks = exportManifest?.logical_files?.["conversations.json"]?.files;
  const chunkNames = Array.isArray(declaredChunks) && declaredChunks.length
    ? declaredChunks.filter((name) => /(?:^|\/)conversations(?:-\d+)?\.json$/i.test(name))
    : ["conversations-000.json", "conversations-001.json"];
  const chunks = await Promise.all(
    chunkNames.map((name) => fetchJson(fetchImpl, new URL(name, directory), false)),
  );

  const conversations = chunks.flatMap(normalizeConversations);
  if (!conversations.length) throw new Error("未找到 conversations-*.json");
  const assetNames = mergeAssetNames(manifest, libraryFiles);
  const resolver = createAssetResolver(assetNames, { baseUrl: directory.href });
  return createArchive(conversations, assetNames, resolver, "bundled");
}

function uint32(view, offset) {
  return view.getUint32(offset, true);
}

/** Minimal ZIP reader: uses its central directory and the browser decompressor. */
export async function unzip(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = -1;

  for (let index = data.length - 22; index >= Math.max(0, data.length - 65_558); index -= 1) {
    if (uint32(view, index) === 0x06054b50) {
      end = index;
      break;
    }
  }

  if (end < 0) throw new Error("不是有效的 ZIP 文件");
  const entryCount = view.getUint16(end + 10, true);
  let position = uint32(view, end + 16);
  const entries = new Map();

  for (let index = 0; index < entryCount; index += 1) {
    if (uint32(view, position) !== 0x02014b50) throw new Error("ZIP 目录损坏");

    const compression = view.getUint16(position + 10, true);
    const compressedSize = uint32(view, position + 20);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    const localOffset = uint32(view, position + 42);
    const name = decoder.decode(data.slice(position + 46, position + 46 + nameLength));

    if (uint32(view, localOffset) !== 0x04034b50) throw new Error(`ZIP 条目损坏：${name}`);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const payloadStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = data.slice(payloadStart, payloadStart + compressedSize);

    let bytes;
    if (compression === 0) {
      bytes = compressed;
    } else if (compression === 8 && typeof DecompressionStream !== "undefined") {
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      throw new Error(compression === 8 ? "此浏览器无法解压 ZIP" : `不支持 ZIP 压缩方式 ${compression}`);
    }

    entries.set(name, bytes);
    position += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function entryFor(entries, name) {
  return [...entries.keys()].find((key) => key === name || key.endsWith(`/${name}`)) ?? "";
}

function jsonFromEntries(entries, name, required = false) {
  const key = entryFor(entries, name);
  if (!key) {
    if (required) throw new Error(`ZIP 中未找到 ${name}`);
    return null;
  }
  return JSON.parse(decoder.decode(entries.get(key)));
}

function extractJsonDocuments(source) {
  const opening = new Map([["{", "}"], ["[", "]"]]);
  const documents = [];

  for (let start = 0; start < source.length; start += 1) {
    if (!opening.has(source[start])) continue;

    const stack = [];
    let quote = "";
    let escaped = false;

    for (let index = start; index < source.length; index += 1) {
      const character = source[index];

      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
        continue;
      }

      if (character === '"') {
        quote = character;
      } else if (opening.has(character)) {
        stack.push(opening.get(character));
      } else if (stack.length && character === stack[stack.length - 1]) {
        stack.pop();
        if (!stack.length) {
          documents.push(source.slice(start, index + 1));
          start = index;
          break;
        }
      }
    }
  }

  return documents;
}

function parseJsonExport(source) {
  try {
    return JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch (initialError) {
    for (const embedded of extractJsonDocuments(source)) {
      try {
        const value = JSON.parse(embedded);
        if (normalizeConversations(value).length) return value;
      } catch {
        // Keep looking. A JavaScript wrapper can contain unrelated JSON first.
      }
    }
    throw initialError;
  }
}

async function looksLikeZip(file) {
  const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const signature = `${bytes[0]}:${bytes[1]}:${bytes[2]}:${bytes[3]}`;
  return bytes.length >= 4 && ["80:75:3:4", "80:75:5:6", "80:75:7:8"].includes(signature);
}

function sequenceFromName(name) {
  if (/(?:^|\/)conversations\.json$/i.test(name)) return -1;
  return Number(name.match(/conversations-(\d+)\.json$/)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

function archiveFromZip(entries, sourceFilename = "") {
  const chunkNames = [...entries.keys()]
    .filter((name) => /(?:^|\/)conversations(?:-\d+)?\.json$/i.test(name))
    .sort((left, right) => sequenceFromName(left) - sequenceFromName(right));

  if (!chunkNames.length) {
    const geminiConversations = [];
    for (const [name, bytes] of entries) {
      if (name.endsWith("/") || /(?:^|\/)(__MACOSX|\.DS_Store)(?:\/|$)/i.test(name)) continue;
      try {
        const value = parseJsonExport(decoder.decode(bytes));
        const title = sourceFilename || name.split("/").pop() || "Gemini 对话";
        geminiConversations.push(...normalizeConversations(value).map((conversation) => ({ ...conversation, title })));
      } catch {
        // ZIPs may also contain PDFs and other attachments; ignore non-JSON files.
      }
    }
    if (geminiConversations.length) {
      return createArchive(geminiConversations, {}, createAssetResolver({}), "zip");
    }
    throw new Error("ZIP 中未找到可识别的对话 JSON");
  }

  const conversations = chunkNames.flatMap((name) => normalizeConversations(JSON.parse(decoder.decode(entries.get(name)))));
  if (!conversations.length) throw new Error("ZIP 中没有可识别的 ChatGPT 会话");
  const manifest = mergeAssetNames(
    jsonFromEntries(entries, "conversation_asset_file_names.json"),
    jsonFromEntries(entries, "library_files.json"),
  );
  const urls = new Map();

  for (const [key, filename] of Object.entries(manifest)) {
    const entry = entryFor(entries, key);
    if (entry) urls.set(key, URL.createObjectURL(new Blob([entries.get(entry)], { type: mimeTypeFor(filename) })));
  }

  return createArchive(conversations, manifest, createAssetResolver(manifest, { urls }), "zip");
}

/** Parse a user-dropped .zip, JSON, or a .js file that contains JSON data. */
export async function importArchiveFile(file) {
  const name = String(file?.name ?? "").toLowerCase();
  if (!file) throw new Error("未选择文件");
  if (name.endsWith(".zip") || await looksLikeZip(file)) return archiveFromZip(await unzip(file), file.name);

  const value = parseJsonExport(await file.text());
  const conversations = normalizeConversations(value, { filename: file.name });
  if (!conversations.length) {
    throw new Error("这不是可识别的 ChatGPT 会话 JSON；.js 文件只会读取其中的 JSON，不会执行代码");
  }
  return createArchive(conversations, {}, createAssetResolver({}), "json");
}
