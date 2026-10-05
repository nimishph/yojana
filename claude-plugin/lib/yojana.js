// @bun
// cli/src/main.ts
import { existsSync as existsSync8, mkdirSync as mkdirSync5, readFileSync as readFileSync7, writeFileSync as writeFileSync3 } from "fs";
import { userInfo } from "os";
import { join as join9, relative as relative3, resolve as resolve2, sep as sep3 } from "path";
// node_modules/.bun/@cntxt-labs+patra-core@.+vendor+patra+cntxt-labs-patra-core-0.0.0.tgz/node_modules/@cntxt-labs/patra-core/src/errors.ts
class PatraError extends Error {
  code;
  hint;
  constructor(code, message, options) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PatraError";
    this.code = code;
    this.hint = options?.hint;
  }
}
// node_modules/.bun/@cntxt-labs+patra-core@.+vendor+patra+cntxt-labs-patra-core-0.0.0.tgz/node_modules/@cntxt-labs/patra-core/src/format.ts
class SafeHtml {
  html;
  constructor(html) {
    this.html = html;
  }
  toString() {
    return this.html;
  }
}
var ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
  "=": "&#61;"
};
function escapeHtml(text) {
  return text.replace(/[&<>"'`=]/g, (c) => ESCAPES[c] ?? c);
}
function inline(text) {
  return escapeHtml(text).replace(/&#96;(.+?)&#96;/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}
var UNESCAPES = Object.fromEntries(Object.entries(ESCAPES).map(([c, entity]) => [entity, c]));
function readChars(html) {
  const chars = [];
  for (const m of html.matchAll(/<[^>]*>|&#?\w+;|[^<&]|&/g)) {
    const token = m[0];
    if (token.startsWith("<"))
      continue;
    const start = m.index ?? 0;
    chars.push({ char: UNESCAPES[token] ?? token, start, end: start + token.length });
  }
  return chars;
}
function squeeze(chars) {
  return chars.filter((c, i) => !(/\s/.test(c.char) && i > 0 && /\s/.test(chars[i - 1]?.char ?? "")));
}
function wrapText(html, id) {
  return html.split(/(<[^>]*>)/).map((part) => part === "" || part.startsWith("<") ? part : `<mark data-mark="${escapeHtml(id)}">${part}</mark>`).join("");
}
function applyMarks(html, marks) {
  let result = html;
  for (const mark of marks) {
    const needle = squeeze(readChars(inline(mark.text.trim().replace(/\s+/g, " ")))).map((c) => c.char).join("");
    if (needle === "")
      continue;
    const text = squeeze(readChars(result));
    const at = text.map((c) => c.char).join("").indexOf(needle);
    if (at < 0)
      continue;
    const start = text[at]?.start ?? 0;
    const end = text[at + needle.length - 1]?.end ?? start;
    result = result.slice(0, start) + wrapText(result.slice(start, end), mark.id) + result.slice(end);
  }
  return result;
}
function renderMarkdown(source, marks = []) {
  const out = [];
  let paragraph = [];
  let list = [];
  let code;
  const mark = (html) => applyMarks(html, marks);
  const flush = () => {
    if (paragraph.length > 0)
      out.push(`<p>${mark(inline(paragraph.join(" ")))}</p>`);
    if (list.length > 0)
      out.push(`<ul>${list.map((i) => `<li>${mark(inline(i))}</li>`).join("")}</ul>`);
    paragraph = [];
    list = [];
  };
  for (const line of source.replace(/\r\n?/g, `
`).split(`
`)) {
    if (code !== undefined) {
      if (/^ {0,3}(`{3,}|~{3,})\s*$/.test(line)) {
        out.push(`<pre><code>${escapeHtml(code.join(`
`))}</code></pre>`);
        code = undefined;
      } else {
        code.push(line);
      }
      continue;
    }
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      flush();
      code = [];
      continue;
    }
    const heading = /^#{2,6}\s+(.*)$/.exec(line);
    if (heading !== null) {
      flush();
      out.push(`<h4>${inline(heading[1] ?? "")}</h4>`);
      continue;
    }
    const item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (item !== null) {
      if (paragraph.length > 0)
        flush();
      list.push(item[1] ?? "");
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (list.length > 0)
      flush();
    paragraph.push(line.trim());
  }
  if (code !== undefined)
    out.push(`<pre><code>${escapeHtml(code.join(`
`))}</code></pre>`);
  flush();
  return new SafeHtml(out.join(`
`));
}
function tokens(text) {
  return text.match(/\s+|[^\s]+/g) ?? [];
}
var SIMILAR_ENOUGH_TO_INTERLEAVE = 0.4;
function lcsDiff(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1;i >= 0; i--) {
    for (let j = b.length - 1;j >= 0; j--) {
      table[i * cols + j] = a[i] === b[j] ? (table[(i + 1) * cols + j + 1] ?? 0) + 1 : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", text: a[i] ?? "" });
      i++;
      j++;
    } else if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)) {
      ops.push({ kind: "del", text: a[i] ?? "" });
      i++;
    } else {
      ops.push({ kind: "ins", text: b[j] ?? "" });
      j++;
    }
  }
  for (;i < a.length; i++)
    ops.push({ kind: "del", text: a[i] ?? "" });
  for (;j < b.length; j++)
    ops.push({ kind: "ins", text: b[j] ?? "" });
  return ops;
}
function renderDiff(before, after) {
  const normalize = (text) => text.replace(/\s+/g, " ").trim();
  const a = normalize(before);
  const b = normalize(after);
  const ops = lcsDiff(tokens(a), tokens(b));
  const words = (text) => tokens(text).filter((t) => t.trim() !== "").length;
  const kept = ops.filter((op) => op.kind === "same" && op.text.trim() !== "").length;
  const longest = Math.max(words(a), words(b));
  if (longest > 0 && kept / longest < SIMILAR_ENOUGH_TO_INTERLEAVE && a !== "" && b !== "") {
    return new SafeHtml(`<del>${escapeHtml(a)}</del> <ins>${escapeHtml(b)}</ins>`);
  }
  const out = [];
  let removed = "";
  let added = "";
  const flush = () => {
    if (removed !== "")
      out.push(`<del>${escapeHtml(removed)}</del>`);
    if (removed !== "" && added !== "")
      out.push(" ");
    if (added !== "")
      out.push(`<ins>${escapeHtml(added)}</ins>`);
    removed = "";
    added = "";
  };
  ops.forEach((op, index) => {
    if (op.kind === "del")
      removed += op.text;
    else if (op.kind === "ins")
      added += op.text;
    else {
      const between = op.text.trim() === "" && (removed !== "" || added !== "");
      const next = ops[index + 1];
      if (between && next !== undefined && next.kind !== "same") {
        if (removed !== "")
          removed += op.text;
        if (added !== "")
          added += op.text;
        return;
      }
      flush();
      out.push(escapeHtml(op.text));
    }
  });
  flush();
  return new SafeHtml(out.join(""));
}
// node_modules/.bun/mustache@4.2.0/node_modules/mustache/mustache.mjs
/*!
 * mustache.js - Logic-less {{mustache}} templates with JavaScript
 * http://github.com/janl/mustache.js
 */
var objectToString = Object.prototype.toString;
var isArray = Array.isArray || function isArrayPolyfill(object) {
  return objectToString.call(object) === "[object Array]";
};
function isFunction(object) {
  return typeof object === "function";
}
function typeStr(obj) {
  return isArray(obj) ? "array" : typeof obj;
}
function escapeRegExp(string) {
  return string.replace(/[\-\[\]{}()*+?.,\\\^$|#\s]/g, "\\$&");
}
function hasProperty(obj, propName) {
  return obj != null && typeof obj === "object" && propName in obj;
}
function primitiveHasOwnProperty(primitive, propName) {
  return primitive != null && typeof primitive !== "object" && primitive.hasOwnProperty && primitive.hasOwnProperty(propName);
}
var regExpTest = RegExp.prototype.test;
function testRegExp(re, string) {
  return regExpTest.call(re, string);
}
var nonSpaceRe = /\S/;
function isWhitespace(string) {
  return !testRegExp(nonSpaceRe, string);
}
var entityMap = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "/": "&#x2F;",
  "`": "&#x60;",
  "=": "&#x3D;"
};
function escapeHtml2(string) {
  return String(string).replace(/[&<>"'`=\/]/g, function fromEntityMap(s) {
    return entityMap[s];
  });
}
var whiteRe = /\s*/;
var spaceRe = /\s+/;
var equalsRe = /\s*=/;
var curlyRe = /\s*\}/;
var tagRe = /#|\^|\/|>|\{|&|=|!/;
function parseTemplate(template, tags) {
  if (!template)
    return [];
  var lineHasNonSpace = false;
  var sections = [];
  var tokens = [];
  var spaces = [];
  var hasTag = false;
  var nonSpace = false;
  var indentation = "";
  var tagIndex = 0;
  function stripSpace() {
    if (hasTag && !nonSpace) {
      while (spaces.length)
        delete tokens[spaces.pop()];
    } else {
      spaces = [];
    }
    hasTag = false;
    nonSpace = false;
  }
  var openingTagRe, closingTagRe, closingCurlyRe;
  function compileTags(tagsToCompile) {
    if (typeof tagsToCompile === "string")
      tagsToCompile = tagsToCompile.split(spaceRe, 2);
    if (!isArray(tagsToCompile) || tagsToCompile.length !== 2)
      throw new Error("Invalid tags: " + tagsToCompile);
    openingTagRe = new RegExp(escapeRegExp(tagsToCompile[0]) + "\\s*");
    closingTagRe = new RegExp("\\s*" + escapeRegExp(tagsToCompile[1]));
    closingCurlyRe = new RegExp("\\s*" + escapeRegExp("}" + tagsToCompile[1]));
  }
  compileTags(tags || mustache.tags);
  var scanner = new Scanner(template);
  var start, type, value, chr, token, openSection;
  while (!scanner.eos()) {
    start = scanner.pos;
    value = scanner.scanUntil(openingTagRe);
    if (value) {
      for (var i = 0, valueLength = value.length;i < valueLength; ++i) {
        chr = value.charAt(i);
        if (isWhitespace(chr)) {
          spaces.push(tokens.length);
          indentation += chr;
        } else {
          nonSpace = true;
          lineHasNonSpace = true;
          indentation += " ";
        }
        tokens.push(["text", chr, start, start + 1]);
        start += 1;
        if (chr === `
`) {
          stripSpace();
          indentation = "";
          tagIndex = 0;
          lineHasNonSpace = false;
        }
      }
    }
    if (!scanner.scan(openingTagRe))
      break;
    hasTag = true;
    type = scanner.scan(tagRe) || "name";
    scanner.scan(whiteRe);
    if (type === "=") {
      value = scanner.scanUntil(equalsRe);
      scanner.scan(equalsRe);
      scanner.scanUntil(closingTagRe);
    } else if (type === "{") {
      value = scanner.scanUntil(closingCurlyRe);
      scanner.scan(curlyRe);
      scanner.scanUntil(closingTagRe);
      type = "&";
    } else {
      value = scanner.scanUntil(closingTagRe);
    }
    if (!scanner.scan(closingTagRe))
      throw new Error("Unclosed tag at " + scanner.pos);
    if (type == ">") {
      token = [type, value, start, scanner.pos, indentation, tagIndex, lineHasNonSpace];
    } else {
      token = [type, value, start, scanner.pos];
    }
    tagIndex++;
    tokens.push(token);
    if (type === "#" || type === "^") {
      sections.push(token);
    } else if (type === "/") {
      openSection = sections.pop();
      if (!openSection)
        throw new Error('Unopened section "' + value + '" at ' + start);
      if (openSection[1] !== value)
        throw new Error('Unclosed section "' + openSection[1] + '" at ' + start);
    } else if (type === "name" || type === "{" || type === "&") {
      nonSpace = true;
    } else if (type === "=") {
      compileTags(value);
    }
  }
  stripSpace();
  openSection = sections.pop();
  if (openSection)
    throw new Error('Unclosed section "' + openSection[1] + '" at ' + scanner.pos);
  return nestTokens(squashTokens(tokens));
}
function squashTokens(tokens) {
  var squashedTokens = [];
  var token, lastToken;
  for (var i = 0, numTokens = tokens.length;i < numTokens; ++i) {
    token = tokens[i];
    if (token) {
      if (token[0] === "text" && lastToken && lastToken[0] === "text") {
        lastToken[1] += token[1];
        lastToken[3] = token[3];
      } else {
        squashedTokens.push(token);
        lastToken = token;
      }
    }
  }
  return squashedTokens;
}
function nestTokens(tokens) {
  var nestedTokens = [];
  var collector = nestedTokens;
  var sections = [];
  var token, section;
  for (var i = 0, numTokens = tokens.length;i < numTokens; ++i) {
    token = tokens[i];
    switch (token[0]) {
      case "#":
      case "^":
        collector.push(token);
        sections.push(token);
        collector = token[4] = [];
        break;
      case "/":
        section = sections.pop();
        section[5] = token[2];
        collector = sections.length > 0 ? sections[sections.length - 1][4] : nestedTokens;
        break;
      default:
        collector.push(token);
    }
  }
  return nestedTokens;
}
function Scanner(string) {
  this.string = string;
  this.tail = string;
  this.pos = 0;
}
Scanner.prototype.eos = function eos() {
  return this.tail === "";
};
Scanner.prototype.scan = function scan(re) {
  var match = this.tail.match(re);
  if (!match || match.index !== 0)
    return "";
  var string = match[0];
  this.tail = this.tail.substring(string.length);
  this.pos += string.length;
  return string;
};
Scanner.prototype.scanUntil = function scanUntil(re) {
  var index = this.tail.search(re), match;
  switch (index) {
    case -1:
      match = this.tail;
      this.tail = "";
      break;
    case 0:
      match = "";
      break;
    default:
      match = this.tail.substring(0, index);
      this.tail = this.tail.substring(index);
  }
  this.pos += match.length;
  return match;
};
function Context(view, parentContext) {
  this.view = view;
  this.cache = { ".": this.view };
  this.parent = parentContext;
}
Context.prototype.push = function push(view) {
  return new Context(view, this);
};
Context.prototype.lookup = function lookup(name) {
  var cache = this.cache;
  var value;
  if (cache.hasOwnProperty(name)) {
    value = cache[name];
  } else {
    var context = this, intermediateValue, names, index, lookupHit = false;
    while (context) {
      if (name.indexOf(".") > 0) {
        intermediateValue = context.view;
        names = name.split(".");
        index = 0;
        while (intermediateValue != null && index < names.length) {
          if (index === names.length - 1)
            lookupHit = hasProperty(intermediateValue, names[index]) || primitiveHasOwnProperty(intermediateValue, names[index]);
          intermediateValue = intermediateValue[names[index++]];
        }
      } else {
        intermediateValue = context.view[name];
        lookupHit = hasProperty(context.view, name);
      }
      if (lookupHit) {
        value = intermediateValue;
        break;
      }
      context = context.parent;
    }
    cache[name] = value;
  }
  if (isFunction(value))
    value = value.call(this.view);
  return value;
};
function Writer() {
  this.templateCache = {
    _cache: {},
    set: function set(key, value) {
      this._cache[key] = value;
    },
    get: function get(key) {
      return this._cache[key];
    },
    clear: function clear() {
      this._cache = {};
    }
  };
}
Writer.prototype.clearCache = function clearCache() {
  if (typeof this.templateCache !== "undefined") {
    this.templateCache.clear();
  }
};
Writer.prototype.parse = function parse(template, tags) {
  var cache = this.templateCache;
  var cacheKey = template + ":" + (tags || mustache.tags).join(":");
  var isCacheEnabled = typeof cache !== "undefined";
  var tokens = isCacheEnabled ? cache.get(cacheKey) : undefined;
  if (tokens == undefined) {
    tokens = parseTemplate(template, tags);
    isCacheEnabled && cache.set(cacheKey, tokens);
  }
  return tokens;
};
Writer.prototype.render = function render(template, view, partials, config) {
  var tags = this.getConfigTags(config);
  var tokens = this.parse(template, tags);
  var context = view instanceof Context ? view : new Context(view, undefined);
  return this.renderTokens(tokens, context, partials, template, config);
};
Writer.prototype.renderTokens = function renderTokens(tokens, context, partials, originalTemplate, config) {
  var buffer = "";
  var token, symbol, value;
  for (var i = 0, numTokens = tokens.length;i < numTokens; ++i) {
    value = undefined;
    token = tokens[i];
    symbol = token[0];
    if (symbol === "#")
      value = this.renderSection(token, context, partials, originalTemplate, config);
    else if (symbol === "^")
      value = this.renderInverted(token, context, partials, originalTemplate, config);
    else if (symbol === ">")
      value = this.renderPartial(token, context, partials, config);
    else if (symbol === "&")
      value = this.unescapedValue(token, context);
    else if (symbol === "name")
      value = this.escapedValue(token, context, config);
    else if (symbol === "text")
      value = this.rawValue(token);
    if (value !== undefined)
      buffer += value;
  }
  return buffer;
};
Writer.prototype.renderSection = function renderSection(token, context, partials, originalTemplate, config) {
  var self2 = this;
  var buffer = "";
  var value = context.lookup(token[1]);
  function subRender(template) {
    return self2.render(template, context, partials, config);
  }
  if (!value)
    return;
  if (isArray(value)) {
    for (var j = 0, valueLength = value.length;j < valueLength; ++j) {
      buffer += this.renderTokens(token[4], context.push(value[j]), partials, originalTemplate, config);
    }
  } else if (typeof value === "object" || typeof value === "string" || typeof value === "number") {
    buffer += this.renderTokens(token[4], context.push(value), partials, originalTemplate, config);
  } else if (isFunction(value)) {
    if (typeof originalTemplate !== "string")
      throw new Error("Cannot use higher-order sections without the original template");
    value = value.call(context.view, originalTemplate.slice(token[3], token[5]), subRender);
    if (value != null)
      buffer += value;
  } else {
    buffer += this.renderTokens(token[4], context, partials, originalTemplate, config);
  }
  return buffer;
};
Writer.prototype.renderInverted = function renderInverted(token, context, partials, originalTemplate, config) {
  var value = context.lookup(token[1]);
  if (!value || isArray(value) && value.length === 0)
    return this.renderTokens(token[4], context, partials, originalTemplate, config);
};
Writer.prototype.indentPartial = function indentPartial(partial, indentation, lineHasNonSpace) {
  var filteredIndentation = indentation.replace(/[^ \t]/g, "");
  var partialByNl = partial.split(`
`);
  for (var i = 0;i < partialByNl.length; i++) {
    if (partialByNl[i].length && (i > 0 || !lineHasNonSpace)) {
      partialByNl[i] = filteredIndentation + partialByNl[i];
    }
  }
  return partialByNl.join(`
`);
};
Writer.prototype.renderPartial = function renderPartial(token, context, partials, config) {
  if (!partials)
    return;
  var tags = this.getConfigTags(config);
  var value = isFunction(partials) ? partials(token[1]) : partials[token[1]];
  if (value != null) {
    var lineHasNonSpace = token[6];
    var tagIndex = token[5];
    var indentation = token[4];
    var indentedValue = value;
    if (tagIndex == 0 && indentation) {
      indentedValue = this.indentPartial(value, indentation, lineHasNonSpace);
    }
    var tokens = this.parse(indentedValue, tags);
    return this.renderTokens(tokens, context, partials, indentedValue, config);
  }
};
Writer.prototype.unescapedValue = function unescapedValue(token, context) {
  var value = context.lookup(token[1]);
  if (value != null)
    return value;
};
Writer.prototype.escapedValue = function escapedValue(token, context, config) {
  var escape = this.getConfigEscape(config) || mustache.escape;
  var value = context.lookup(token[1]);
  if (value != null)
    return typeof value === "number" && escape === mustache.escape ? String(value) : escape(value);
};
Writer.prototype.rawValue = function rawValue(token) {
  return token[1];
};
Writer.prototype.getConfigTags = function getConfigTags(config) {
  if (isArray(config)) {
    return config;
  } else if (config && typeof config === "object") {
    return config.tags;
  } else {
    return;
  }
};
Writer.prototype.getConfigEscape = function getConfigEscape(config) {
  if (config && typeof config === "object" && !isArray(config)) {
    return config.escape;
  } else {
    return;
  }
};
var mustache = {
  name: "mustache.js",
  version: "4.2.0",
  tags: ["{{", "}}"],
  clearCache: undefined,
  escape: undefined,
  parse: undefined,
  render: undefined,
  Scanner: undefined,
  Context: undefined,
  Writer: undefined,
  set templateCache(cache) {
    defaultWriter.templateCache = cache;
  },
  get templateCache() {
    return defaultWriter.templateCache;
  }
};
var defaultWriter = new Writer;
mustache.clearCache = function clearCache() {
  return defaultWriter.clearCache();
};
mustache.parse = function parse(template, tags) {
  return defaultWriter.parse(template, tags);
};
mustache.render = function render(template, view, partials, config) {
  if (typeof template !== "string") {
    throw new TypeError('Invalid template! Template should be a "string" ' + 'but "' + typeStr(template) + '" was given as the first ' + "argument for mustache#render(template, view, partials)");
  }
  return defaultWriter.render(template, view, partials, config);
};
mustache.escape = escapeHtml2;
mustache.Scanner = Scanner;
mustache.Context = Context;
mustache.Writer = Writer;
var mustache_default = mustache;

// node_modules/.bun/@cntxt-labs+patra-core@.+vendor+patra+cntxt-labs-patra-core-0.0.0.tgz/node_modules/@cntxt-labs/patra-core/src/markup.ts
function templateProblems(file, html, partNames) {
  let tokens;
  try {
    tokens = mustache_default.parse(html);
  } catch (error) {
    return [{ file, at: "", code: "TEMPLATE_SYNTAX", message: String(error) }];
  }
  const problems = [];
  const walk = (list) => {
    for (const token of list) {
      const [type, value] = token;
      if (type === "&" || type === "{") {
        problems.push({
          file,
          at: "",
          code: "RAW_OUTPUT",
          message: `{{{${value}}}} would output content unescaped; use {{${value}}} (formatted values render as HTML on their own)`
        });
      } else if (type === "=") {
        problems.push({
          file,
          at: "",
          code: "DELIMITER_CHANGE",
          message: "changing Mustache delimiters is not allowed in patra templates"
        });
      } else if (type === ">" && !partNames.has(value)) {
        problems.push({
          file,
          at: "",
          code: "UNKNOWN_PART",
          message: `{{> ${value}}} names no part`
        });
      }
      const children = token[4];
      if (Array.isArray(children))
        walk(children);
    }
  };
  walk(tokens);
  return problems;
}
// node_modules/.bun/@cntxt-labs+patra-core@.+vendor+patra+cntxt-labs-patra-core-0.0.0.tgz/node_modules/@cntxt-labs/patra-core/src/render.ts
var escapeValue = (value) => value instanceof SafeHtml ? value.html : escapeHtml(String(value));
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function marksOf(value) {
  if (!Array.isArray(value))
    return [];
  return value.flatMap((m) => isRecord(m) && typeof m.text === "string" && typeof m.id === "string" ? [{ text: m.text, id: m.id }] : []);
}
function prepare(value, item = false) {
  return prepareIn(value, new Set, item);
}
function prepareIn(value, enclosing, item) {
  if (Array.isArray(value))
    return value.map((v) => prepareIn(v, enclosing, true));
  if (!isRecord(value))
    return value;
  if (value.kind === "markdown" && typeof value.source === "string") {
    return renderMarkdown(value.source, marksOf(value.marks));
  }
  if (value.kind === "diff" && typeof value.before === "string" && typeof value.after === "string") {
    return renderDiff(value.before, value.after);
  }
  const inner = item ? new Set([...enclosing, ...Object.keys(value)]) : enclosing;
  const own = Object.entries(value).map(([k, v]) => [k, prepareIn(v, inner, false)]);
  const shadowed = item ? [...enclosing].filter((k) => !Object.hasOwn(value, k)).map((k) => [k, null]) : [];
  return Object.fromEntries([...shadowed, ...own]);
}
function partials(template) {
  return Object.fromEntries([...template.parts].map(([name, part]) => [name, part.html]));
}
function renderPage(template, content, patra = {}) {
  const problems = template.check(content);
  if (problems.length > 0)
    return { ok: false, problems };
  const view = { ...prepare(content), patra };
  return {
    ok: true,
    html: mustache_default.render(template.page, view, partials(template), { escape: escapeValue })
  };
}
function renderPart(template, partName, item, patra = {}) {
  const part = template.parts.get(partName);
  if (part === undefined) {
    return {
      ok: false,
      problems: [{ file: "content", at: "", code: "UNKNOWN_PART", message: `no part ${partName}` }]
    };
  }
  if (part.key !== undefined) {
    const key = isRecord(item) ? item[part.key] : undefined;
    if (typeof key !== "string" || key === "") {
      return {
        ok: false,
        problems: [
          {
            file: "content",
            at: "",
            code: "MISSING_KEY",
            message: `an item of ${partName} needs a string ${part.key}`
          }
        ]
      };
    }
  }
  const view = isRecord(item) ? { ...prepare(item, part.key !== undefined), patra } : { patra };
  return {
    ok: true,
    html: mustache_default.render(part.html, view, partials(template), { escape: escapeValue })
  };
}
function pageHead(template, themeCss, extra = []) {
  const css = [themeCss, ...template.styles.map((s) => s.css)].join(`
`).replace(/<\/style/gi, "<\\/style");
  return new SafeHtml([`<style>
${css}
</style>`, ...extra].join(`
`));
}
// node_modules/.bun/@cntxt-labs+patra-core@.+vendor+patra+cntxt-labs-patra-core-0.0.0.tgz/node_modules/@cntxt-labs/patra-core/src/template.ts
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// node_modules/.bun/@cfworker+json-schema@4.1.1/node_modules/@cfworker/json-schema/dist/esm/deep-compare-strict.js
function deepCompareStrict(a, b) {
  const typeofa = typeof a;
  if (typeofa !== typeof b) {
    return false;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) {
      return false;
    }
    const length = a.length;
    if (length !== b.length) {
      return false;
    }
    for (let i = 0;i < length; i++) {
      if (!deepCompareStrict(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  if (typeofa === "object") {
    if (!a || !b) {
      return a === b;
    }
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    const length = aKeys.length;
    if (length !== bKeys.length) {
      return false;
    }
    for (const k of aKeys) {
      if (!deepCompareStrict(a[k], b[k])) {
        return false;
      }
    }
    return true;
  }
  return a === b;
}

// node_modules/.bun/@cfworker+json-schema@4.1.1/node_modules/@cfworker/json-schema/dist/esm/pointer.js
function encodePointer(p) {
  return encodeURI(escapePointer(p));
}
function escapePointer(p) {
  return p.replace(/~/g, "~0").replace(/\//g, "~1");
}

// node_modules/.bun/@cfworker+json-schema@4.1.1/node_modules/@cfworker/json-schema/dist/esm/dereference.js
var schemaArrayKeyword = {
  prefixItems: true,
  items: true,
  allOf: true,
  anyOf: true,
  oneOf: true
};
var schemaMapKeyword = {
  $defs: true,
  definitions: true,
  properties: true,
  patternProperties: true,
  dependentSchemas: true
};
var ignoredKeyword = {
  id: true,
  $id: true,
  $ref: true,
  $schema: true,
  $anchor: true,
  $vocabulary: true,
  $comment: true,
  default: true,
  enum: true,
  const: true,
  required: true,
  type: true,
  maximum: true,
  minimum: true,
  exclusiveMaximum: true,
  exclusiveMinimum: true,
  multipleOf: true,
  maxLength: true,
  minLength: true,
  pattern: true,
  format: true,
  maxItems: true,
  minItems: true,
  uniqueItems: true,
  maxProperties: true,
  minProperties: true
};
var initialBaseURI = typeof self !== "undefined" && self.location && self.location.origin !== "null" ? new URL(self.location.origin + self.location.pathname + location.search) : new URL("https://github.com/cfworker");
function dereference(schema, lookup = Object.create(null), baseURI = initialBaseURI, basePointer = "") {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    const id = schema.$id || schema.id;
    if (id) {
      const url = new URL(id, baseURI.href);
      if (url.hash.length > 1) {
        lookup[url.href] = schema;
      } else {
        url.hash = "";
        if (basePointer === "") {
          baseURI = url;
        } else {
          dereference(schema, lookup, baseURI);
        }
      }
    }
  } else if (schema !== true && schema !== false) {
    return lookup;
  }
  const schemaURI = baseURI.href + (basePointer ? "#" + basePointer : "");
  if (lookup[schemaURI] !== undefined) {
    throw new Error(`Duplicate schema URI "${schemaURI}".`);
  }
  lookup[schemaURI] = schema;
  if (schema === true || schema === false) {
    return lookup;
  }
  if (schema.__absolute_uri__ === undefined) {
    Object.defineProperty(schema, "__absolute_uri__", {
      enumerable: false,
      value: schemaURI
    });
  }
  if (schema.$ref && schema.__absolute_ref__ === undefined) {
    const url = new URL(schema.$ref, baseURI.href);
    url.hash = url.hash;
    Object.defineProperty(schema, "__absolute_ref__", {
      enumerable: false,
      value: url.href
    });
  }
  if (schema.$recursiveRef && schema.__absolute_recursive_ref__ === undefined) {
    const url = new URL(schema.$recursiveRef, baseURI.href);
    url.hash = url.hash;
    Object.defineProperty(schema, "__absolute_recursive_ref__", {
      enumerable: false,
      value: url.href
    });
  }
  if (schema.$anchor) {
    const url = new URL("#" + schema.$anchor, baseURI.href);
    lookup[url.href] = schema;
  }
  for (let key in schema) {
    if (ignoredKeyword[key]) {
      continue;
    }
    const keyBase = `${basePointer}/${encodePointer(key)}`;
    const subSchema = schema[key];
    if (Array.isArray(subSchema)) {
      if (schemaArrayKeyword[key]) {
        const length = subSchema.length;
        for (let i = 0;i < length; i++) {
          dereference(subSchema[i], lookup, baseURI, `${keyBase}/${i}`);
        }
      }
    } else if (schemaMapKeyword[key]) {
      for (let subKey in subSchema) {
        dereference(subSchema[subKey], lookup, baseURI, `${keyBase}/${encodePointer(subKey)}`);
      }
    } else {
      dereference(subSchema, lookup, baseURI, keyBase);
    }
  }
  return lookup;
}

// node_modules/.bun/@cfworker+json-schema@4.1.1/node_modules/@cfworker/json-schema/dist/esm/format.js
var DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
var DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
var TIME = /^(\d\d):(\d\d):(\d\d)(\.\d+)?(z|[+-]\d\d(?::?\d\d)?)?$/i;
var HOSTNAME = /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i;
var URIREF = /^(?:[a-z][a-z0-9+\-.]*:)?(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'"()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?(?:\?(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
var URITEMPLATE = /^(?:(?:[^\x00-\x20"'<>%\\^`{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$/i;
var URL_ = /^(?:(?:https?|ftp):\/\/)(?:\S+(?::\S*)?@)?(?:(?!10(?:\.\d{1,3}){3})(?!127(?:\.\d{1,3}){3})(?!169\.254(?:\.\d{1,3}){2})(?!192\.168(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z\u{00a1}-\u{ffff}0-9]+-?)*[a-z\u{00a1}-\u{ffff}0-9]+)(?:\.(?:[a-z\u{00a1}-\u{ffff}0-9]+-?)*[a-z\u{00a1}-\u{ffff}0-9]+)*(?:\.(?:[a-z\u{00a1}-\u{ffff}]{2,})))(?::\d{2,5})?(?:\/[^\s]*)?$/iu;
var UUID = /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
var JSON_POINTER = /^(?:\/(?:[^~/]|~0|~1)*)*$/;
var JSON_POINTER_URI_FRAGMENT = /^#(?:\/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*$/i;
var RELATIVE_JSON_POINTER = /^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~0|~1)*)*)$/;
var EMAIL = (input) => {
  if (input[0] === '"')
    return false;
  const [name, host, ...rest] = input.split("@");
  if (!name || !host || rest.length !== 0 || name.length > 64 || host.length > 253)
    return false;
  if (name[0] === "." || name.endsWith(".") || name.includes(".."))
    return false;
  if (!/^[a-z0-9.-]+$/i.test(host) || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(name))
    return false;
  return host.split(".").every((part) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(part));
};
var IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
var IPV6 = /^((([0-9a-f]{1,4}:){7}([0-9a-f]{1,4}|:))|(([0-9a-f]{1,4}:){6}(:[0-9a-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){5}(((:[0-9a-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){4}(((:[0-9a-f]{1,4}){1,3})|((:[0-9a-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){3}(((:[0-9a-f]{1,4}){1,4})|((:[0-9a-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){2}(((:[0-9a-f]{1,4}){1,5})|((:[0-9a-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){1}(((:[0-9a-f]{1,4}){1,6})|((:[0-9a-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9a-f]{1,4}){1,7})|((:[0-9a-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))$/i;
var DURATION = (input) => input.length > 1 && input.length < 80 && (/^P\d+([.,]\d+)?W$/.test(input) || /^P[\dYMDTHS]*(\d[.,]\d+)?[YMDHS]$/.test(input) && /^P([.,\d]+Y)?([.,\d]+M)?([.,\d]+D)?(T([.,\d]+H)?([.,\d]+M)?([.,\d]+S)?)?$/.test(input));
function bind(r) {
  return r.test.bind(r);
}
var format = {
  date,
  time: time.bind(undefined, false),
  "date-time": date_time,
  duration: DURATION,
  uri,
  "uri-reference": bind(URIREF),
  "uri-template": bind(URITEMPLATE),
  url: bind(URL_),
  email: EMAIL,
  hostname: bind(HOSTNAME),
  ipv4: bind(IPV4),
  ipv6: bind(IPV6),
  regex,
  uuid: bind(UUID),
  "json-pointer": bind(JSON_POINTER),
  "json-pointer-uri-fragment": bind(JSON_POINTER_URI_FRAGMENT),
  "relative-json-pointer": bind(RELATIVE_JSON_POINTER)
};
function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
function date(str) {
  const matches = str.match(DATE);
  if (!matches)
    return false;
  const year = +matches[1];
  const month = +matches[2];
  const day = +matches[3];
  return month >= 1 && month <= 12 && day >= 1 && day <= (month == 2 && isLeapYear(year) ? 29 : DAYS[month]);
}
function time(full, str) {
  const matches = str.match(TIME);
  if (!matches)
    return false;
  const hour = +matches[1];
  const minute = +matches[2];
  const second = +matches[3];
  const timeZone = !!matches[5];
  return (hour <= 23 && minute <= 59 && second <= 59 || hour == 23 && minute == 59 && second == 60) && (!full || timeZone);
}
var DATE_TIME_SEPARATOR = /t|\s/i;
function date_time(str) {
  const dateTime = str.split(DATE_TIME_SEPARATOR);
  return dateTime.length == 2 && date(dateTime[0]) && time(true, dateTime[1]);
}
var NOT_URI_FRAGMENT = /\/|:/;
var URI_PATTERN = /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
function uri(str) {
  return NOT_URI_FRAGMENT.test(str) && URI_PATTERN.test(str);
}
var Z_ANCHOR = /[^\\]\\Z/;
function regex(str) {
  if (Z_ANCHOR.test(str))
    return false;
  try {
    new RegExp(str, "u");
    return true;
  } catch (e) {
    return false;
  }
}

// node_modules/.bun/@cfworker+json-schema@4.1.1/node_modules/@cfworker/json-schema/dist/esm/ucs2-length.js
function ucs2length(s) {
  let result = 0;
  let length = s.length;
  let index = 0;
  let charCode;
  while (index < length) {
    result++;
    charCode = s.charCodeAt(index++);
    if (charCode >= 55296 && charCode <= 56319 && index < length) {
      charCode = s.charCodeAt(index);
      if ((charCode & 64512) == 56320) {
        index++;
      }
    }
  }
  return result;
}

// node_modules/.bun/@cfworker+json-schema@4.1.1/node_modules/@cfworker/json-schema/dist/esm/validate.js
function validate(instance, schema, draft = "2019-09", lookup = dereference(schema), shortCircuit = true, recursiveAnchor = null, instanceLocation = "#", schemaLocation = "#", evaluated = Object.create(null)) {
  if (schema === true) {
    return { valid: true, errors: [] };
  }
  if (schema === false) {
    return {
      valid: false,
      errors: [
        {
          instanceLocation,
          keyword: "false",
          keywordLocation: instanceLocation,
          error: "False boolean schema."
        }
      ]
    };
  }
  const rawInstanceType = typeof instance;
  let instanceType;
  switch (rawInstanceType) {
    case "boolean":
    case "number":
    case "string":
      instanceType = rawInstanceType;
      break;
    case "object":
      if (instance === null) {
        instanceType = "null";
      } else if (Array.isArray(instance)) {
        instanceType = "array";
      } else {
        instanceType = "object";
      }
      break;
    default:
      throw new Error(`Instances of "${rawInstanceType}" type are not supported.`);
  }
  const { $ref, $recursiveRef, $recursiveAnchor, type: $type, const: $const, enum: $enum, required: $required, not: $not, anyOf: $anyOf, allOf: $allOf, oneOf: $oneOf, if: $if, then: $then, else: $else, format: $format, properties: $properties, patternProperties: $patternProperties, additionalProperties: $additionalProperties, unevaluatedProperties: $unevaluatedProperties, minProperties: $minProperties, maxProperties: $maxProperties, propertyNames: $propertyNames, dependentRequired: $dependentRequired, dependentSchemas: $dependentSchemas, dependencies: $dependencies, prefixItems: $prefixItems, items: $items, additionalItems: $additionalItems, unevaluatedItems: $unevaluatedItems, contains: $contains, minContains: $minContains, maxContains: $maxContains, minItems: $minItems, maxItems: $maxItems, uniqueItems: $uniqueItems, minimum: $minimum, maximum: $maximum, exclusiveMinimum: $exclusiveMinimum, exclusiveMaximum: $exclusiveMaximum, multipleOf: $multipleOf, minLength: $minLength, maxLength: $maxLength, pattern: $pattern, __absolute_ref__, __absolute_recursive_ref__ } = schema;
  const errors = [];
  if ($recursiveAnchor === true && recursiveAnchor === null) {
    recursiveAnchor = schema;
  }
  if ($recursiveRef === "#") {
    const refSchema = recursiveAnchor === null ? lookup[__absolute_recursive_ref__] : recursiveAnchor;
    const keywordLocation = `${schemaLocation}/$recursiveRef`;
    const result = validate(instance, recursiveAnchor === null ? schema : recursiveAnchor, draft, lookup, shortCircuit, refSchema, instanceLocation, keywordLocation, evaluated);
    if (!result.valid) {
      errors.push({
        instanceLocation,
        keyword: "$recursiveRef",
        keywordLocation,
        error: "A subschema had errors."
      }, ...result.errors);
    }
  }
  if ($ref !== undefined) {
    const uri = __absolute_ref__ || $ref;
    const refSchema = lookup[uri];
    if (refSchema === undefined) {
      let message = `Unresolved $ref "${$ref}".`;
      if (__absolute_ref__ && __absolute_ref__ !== $ref) {
        message += `  Absolute URI "${__absolute_ref__}".`;
      }
      message += `
Known schemas:
- ${Object.keys(lookup).join(`
- `)}`;
      throw new Error(message);
    }
    const keywordLocation = `${schemaLocation}/$ref`;
    const result = validate(instance, refSchema, draft, lookup, shortCircuit, recursiveAnchor, instanceLocation, keywordLocation, evaluated);
    if (!result.valid) {
      errors.push({
        instanceLocation,
        keyword: "$ref",
        keywordLocation,
        error: "A subschema had errors."
      }, ...result.errors);
    }
    if (draft === "4" || draft === "7") {
      return { valid: errors.length === 0, errors };
    }
  }
  if (Array.isArray($type)) {
    let length = $type.length;
    let valid = false;
    for (let i = 0;i < length; i++) {
      if (instanceType === $type[i] || $type[i] === "integer" && instanceType === "number" && instance % 1 === 0 && instance === instance) {
        valid = true;
        break;
      }
    }
    if (!valid) {
      errors.push({
        instanceLocation,
        keyword: "type",
        keywordLocation: `${schemaLocation}/type`,
        error: `Instance type "${instanceType}" is invalid. Expected "${$type.join('", "')}".`
      });
    }
  } else if ($type === "integer") {
    if (instanceType !== "number" || instance % 1 || instance !== instance) {
      errors.push({
        instanceLocation,
        keyword: "type",
        keywordLocation: `${schemaLocation}/type`,
        error: `Instance type "${instanceType}" is invalid. Expected "${$type}".`
      });
    }
  } else if ($type !== undefined && instanceType !== $type) {
    errors.push({
      instanceLocation,
      keyword: "type",
      keywordLocation: `${schemaLocation}/type`,
      error: `Instance type "${instanceType}" is invalid. Expected "${$type}".`
    });
  }
  if ($const !== undefined) {
    if (instanceType === "object" || instanceType === "array") {
      if (!deepCompareStrict(instance, $const)) {
        errors.push({
          instanceLocation,
          keyword: "const",
          keywordLocation: `${schemaLocation}/const`,
          error: `Instance does not match ${JSON.stringify($const)}.`
        });
      }
    } else if (instance !== $const) {
      errors.push({
        instanceLocation,
        keyword: "const",
        keywordLocation: `${schemaLocation}/const`,
        error: `Instance does not match ${JSON.stringify($const)}.`
      });
    }
  }
  if ($enum !== undefined) {
    if (instanceType === "object" || instanceType === "array") {
      if (!$enum.some((value) => deepCompareStrict(instance, value))) {
        errors.push({
          instanceLocation,
          keyword: "enum",
          keywordLocation: `${schemaLocation}/enum`,
          error: `Instance does not match any of ${JSON.stringify($enum)}.`
        });
      }
    } else if (!$enum.some((value) => instance === value)) {
      errors.push({
        instanceLocation,
        keyword: "enum",
        keywordLocation: `${schemaLocation}/enum`,
        error: `Instance does not match any of ${JSON.stringify($enum)}.`
      });
    }
  }
  if ($not !== undefined) {
    const keywordLocation = `${schemaLocation}/not`;
    const result = validate(instance, $not, draft, lookup, shortCircuit, recursiveAnchor, instanceLocation, keywordLocation);
    if (result.valid) {
      errors.push({
        instanceLocation,
        keyword: "not",
        keywordLocation,
        error: 'Instance matched "not" schema.'
      });
    }
  }
  let subEvaluateds = [];
  if ($anyOf !== undefined) {
    const keywordLocation = `${schemaLocation}/anyOf`;
    const errorsLength = errors.length;
    let anyValid = false;
    for (let i = 0;i < $anyOf.length; i++) {
      const subSchema = $anyOf[i];
      const subEvaluated = Object.create(evaluated);
      const result = validate(instance, subSchema, draft, lookup, shortCircuit, $recursiveAnchor === true ? recursiveAnchor : null, instanceLocation, `${keywordLocation}/${i}`, subEvaluated);
      errors.push(...result.errors);
      anyValid = anyValid || result.valid;
      if (result.valid) {
        subEvaluateds.push(subEvaluated);
      }
    }
    if (anyValid) {
      errors.length = errorsLength;
    } else {
      errors.splice(errorsLength, 0, {
        instanceLocation,
        keyword: "anyOf",
        keywordLocation,
        error: "Instance does not match any subschemas."
      });
    }
  }
  if ($allOf !== undefined) {
    const keywordLocation = `${schemaLocation}/allOf`;
    const errorsLength = errors.length;
    let allValid = true;
    for (let i = 0;i < $allOf.length; i++) {
      const subSchema = $allOf[i];
      const subEvaluated = Object.create(evaluated);
      const result = validate(instance, subSchema, draft, lookup, shortCircuit, $recursiveAnchor === true ? recursiveAnchor : null, instanceLocation, `${keywordLocation}/${i}`, subEvaluated);
      errors.push(...result.errors);
      allValid = allValid && result.valid;
      if (result.valid) {
        subEvaluateds.push(subEvaluated);
      }
    }
    if (allValid) {
      errors.length = errorsLength;
    } else {
      errors.splice(errorsLength, 0, {
        instanceLocation,
        keyword: "allOf",
        keywordLocation,
        error: `Instance does not match every subschema.`
      });
    }
  }
  if ($oneOf !== undefined) {
    const keywordLocation = `${schemaLocation}/oneOf`;
    const errorsLength = errors.length;
    const matches = $oneOf.filter((subSchema, i) => {
      const subEvaluated = Object.create(evaluated);
      const result = validate(instance, subSchema, draft, lookup, shortCircuit, $recursiveAnchor === true ? recursiveAnchor : null, instanceLocation, `${keywordLocation}/${i}`, subEvaluated);
      errors.push(...result.errors);
      if (result.valid) {
        subEvaluateds.push(subEvaluated);
      }
      return result.valid;
    }).length;
    if (matches === 1) {
      errors.length = errorsLength;
    } else {
      errors.splice(errorsLength, 0, {
        instanceLocation,
        keyword: "oneOf",
        keywordLocation,
        error: `Instance does not match exactly one subschema (${matches} matches).`
      });
    }
  }
  if (instanceType === "object" || instanceType === "array") {
    Object.assign(evaluated, ...subEvaluateds);
  }
  if ($if !== undefined) {
    const keywordLocation = `${schemaLocation}/if`;
    const conditionResult = validate(instance, $if, draft, lookup, shortCircuit, recursiveAnchor, instanceLocation, keywordLocation, evaluated).valid;
    if (conditionResult) {
      if ($then !== undefined) {
        const thenResult = validate(instance, $then, draft, lookup, shortCircuit, recursiveAnchor, instanceLocation, `${schemaLocation}/then`, evaluated);
        if (!thenResult.valid) {
          errors.push({
            instanceLocation,
            keyword: "if",
            keywordLocation,
            error: `Instance does not match "then" schema.`
          }, ...thenResult.errors);
        }
      }
    } else if ($else !== undefined) {
      const elseResult = validate(instance, $else, draft, lookup, shortCircuit, recursiveAnchor, instanceLocation, `${schemaLocation}/else`, evaluated);
      if (!elseResult.valid) {
        errors.push({
          instanceLocation,
          keyword: "if",
          keywordLocation,
          error: `Instance does not match "else" schema.`
        }, ...elseResult.errors);
      }
    }
  }
  if (instanceType === "object") {
    if ($required !== undefined) {
      for (const key of $required) {
        if (!(key in instance)) {
          errors.push({
            instanceLocation,
            keyword: "required",
            keywordLocation: `${schemaLocation}/required`,
            error: `Instance does not have required property "${key}".`
          });
        }
      }
    }
    const keys = Object.keys(instance);
    if ($minProperties !== undefined && keys.length < $minProperties) {
      errors.push({
        instanceLocation,
        keyword: "minProperties",
        keywordLocation: `${schemaLocation}/minProperties`,
        error: `Instance does not have at least ${$minProperties} properties.`
      });
    }
    if ($maxProperties !== undefined && keys.length > $maxProperties) {
      errors.push({
        instanceLocation,
        keyword: "maxProperties",
        keywordLocation: `${schemaLocation}/maxProperties`,
        error: `Instance does not have at least ${$maxProperties} properties.`
      });
    }
    if ($propertyNames !== undefined) {
      const keywordLocation = `${schemaLocation}/propertyNames`;
      for (const key in instance) {
        const subInstancePointer = `${instanceLocation}/${encodePointer(key)}`;
        const result = validate(key, $propertyNames, draft, lookup, shortCircuit, recursiveAnchor, subInstancePointer, keywordLocation);
        if (!result.valid) {
          errors.push({
            instanceLocation,
            keyword: "propertyNames",
            keywordLocation,
            error: `Property name "${key}" does not match schema.`
          }, ...result.errors);
        }
      }
    }
    if ($dependentRequired !== undefined) {
      const keywordLocation = `${schemaLocation}/dependantRequired`;
      for (const key in $dependentRequired) {
        if (key in instance) {
          const required = $dependentRequired[key];
          for (const dependantKey of required) {
            if (!(dependantKey in instance)) {
              errors.push({
                instanceLocation,
                keyword: "dependentRequired",
                keywordLocation,
                error: `Instance has "${key}" but does not have "${dependantKey}".`
              });
            }
          }
        }
      }
    }
    if ($dependentSchemas !== undefined) {
      for (const key in $dependentSchemas) {
        const keywordLocation = `${schemaLocation}/dependentSchemas`;
        if (key in instance) {
          const result = validate(instance, $dependentSchemas[key], draft, lookup, shortCircuit, recursiveAnchor, instanceLocation, `${keywordLocation}/${encodePointer(key)}`, evaluated);
          if (!result.valid) {
            errors.push({
              instanceLocation,
              keyword: "dependentSchemas",
              keywordLocation,
              error: `Instance has "${key}" but does not match dependant schema.`
            }, ...result.errors);
          }
        }
      }
    }
    if ($dependencies !== undefined) {
      const keywordLocation = `${schemaLocation}/dependencies`;
      for (const key in $dependencies) {
        if (key in instance) {
          const propsOrSchema = $dependencies[key];
          if (Array.isArray(propsOrSchema)) {
            for (const dependantKey of propsOrSchema) {
              if (!(dependantKey in instance)) {
                errors.push({
                  instanceLocation,
                  keyword: "dependencies",
                  keywordLocation,
                  error: `Instance has "${key}" but does not have "${dependantKey}".`
                });
              }
            }
          } else {
            const result = validate(instance, propsOrSchema, draft, lookup, shortCircuit, recursiveAnchor, instanceLocation, `${keywordLocation}/${encodePointer(key)}`);
            if (!result.valid) {
              errors.push({
                instanceLocation,
                keyword: "dependencies",
                keywordLocation,
                error: `Instance has "${key}" but does not match dependant schema.`
              }, ...result.errors);
            }
          }
        }
      }
    }
    const thisEvaluated = Object.create(null);
    let stop = false;
    if ($properties !== undefined) {
      const keywordLocation = `${schemaLocation}/properties`;
      for (const key in $properties) {
        if (!(key in instance)) {
          continue;
        }
        const subInstancePointer = `${instanceLocation}/${encodePointer(key)}`;
        const result = validate(instance[key], $properties[key], draft, lookup, shortCircuit, recursiveAnchor, subInstancePointer, `${keywordLocation}/${encodePointer(key)}`);
        if (result.valid) {
          evaluated[key] = thisEvaluated[key] = true;
        } else {
          stop = shortCircuit;
          errors.push({
            instanceLocation,
            keyword: "properties",
            keywordLocation,
            error: `Property "${key}" does not match schema.`
          }, ...result.errors);
          if (stop)
            break;
        }
      }
    }
    if (!stop && $patternProperties !== undefined) {
      const keywordLocation = `${schemaLocation}/patternProperties`;
      for (const pattern in $patternProperties) {
        const regex = new RegExp(pattern, "u");
        const subSchema = $patternProperties[pattern];
        for (const key in instance) {
          if (!regex.test(key)) {
            continue;
          }
          const subInstancePointer = `${instanceLocation}/${encodePointer(key)}`;
          const result = validate(instance[key], subSchema, draft, lookup, shortCircuit, recursiveAnchor, subInstancePointer, `${keywordLocation}/${encodePointer(pattern)}`);
          if (result.valid) {
            evaluated[key] = thisEvaluated[key] = true;
          } else {
            stop = shortCircuit;
            errors.push({
              instanceLocation,
              keyword: "patternProperties",
              keywordLocation,
              error: `Property "${key}" matches pattern "${pattern}" but does not match associated schema.`
            }, ...result.errors);
          }
        }
      }
    }
    if (!stop && $additionalProperties !== undefined) {
      const keywordLocation = `${schemaLocation}/additionalProperties`;
      for (const key in instance) {
        if (thisEvaluated[key]) {
          continue;
        }
        const subInstancePointer = `${instanceLocation}/${encodePointer(key)}`;
        const result = validate(instance[key], $additionalProperties, draft, lookup, shortCircuit, recursiveAnchor, subInstancePointer, keywordLocation);
        if (result.valid) {
          evaluated[key] = true;
        } else {
          stop = shortCircuit;
          errors.push({
            instanceLocation,
            keyword: "additionalProperties",
            keywordLocation,
            error: `Property "${key}" does not match additional properties schema.`
          }, ...result.errors);
        }
      }
    } else if (!stop && $unevaluatedProperties !== undefined) {
      const keywordLocation = `${schemaLocation}/unevaluatedProperties`;
      for (const key in instance) {
        if (!evaluated[key]) {
          const subInstancePointer = `${instanceLocation}/${encodePointer(key)}`;
          const result = validate(instance[key], $unevaluatedProperties, draft, lookup, shortCircuit, recursiveAnchor, subInstancePointer, keywordLocation);
          if (result.valid) {
            evaluated[key] = true;
          } else {
            errors.push({
              instanceLocation,
              keyword: "unevaluatedProperties",
              keywordLocation,
              error: `Property "${key}" does not match unevaluated properties schema.`
            }, ...result.errors);
          }
        }
      }
    }
  } else if (instanceType === "array") {
    if ($maxItems !== undefined && instance.length > $maxItems) {
      errors.push({
        instanceLocation,
        keyword: "maxItems",
        keywordLocation: `${schemaLocation}/maxItems`,
        error: `Array has too many items (${instance.length} > ${$maxItems}).`
      });
    }
    if ($minItems !== undefined && instance.length < $minItems) {
      errors.push({
        instanceLocation,
        keyword: "minItems",
        keywordLocation: `${schemaLocation}/minItems`,
        error: `Array has too few items (${instance.length} < ${$minItems}).`
      });
    }
    const length = instance.length;
    let i = 0;
    let stop = false;
    if ($prefixItems !== undefined) {
      const keywordLocation = `${schemaLocation}/prefixItems`;
      const length2 = Math.min($prefixItems.length, length);
      for (;i < length2; i++) {
        const result = validate(instance[i], $prefixItems[i], draft, lookup, shortCircuit, recursiveAnchor, `${instanceLocation}/${i}`, `${keywordLocation}/${i}`);
        evaluated[i] = true;
        if (!result.valid) {
          stop = shortCircuit;
          errors.push({
            instanceLocation,
            keyword: "prefixItems",
            keywordLocation,
            error: `Items did not match schema.`
          }, ...result.errors);
          if (stop)
            break;
        }
      }
    }
    if ($items !== undefined) {
      const keywordLocation = `${schemaLocation}/items`;
      if (Array.isArray($items)) {
        const length2 = Math.min($items.length, length);
        for (;i < length2; i++) {
          const result = validate(instance[i], $items[i], draft, lookup, shortCircuit, recursiveAnchor, `${instanceLocation}/${i}`, `${keywordLocation}/${i}`);
          evaluated[i] = true;
          if (!result.valid) {
            stop = shortCircuit;
            errors.push({
              instanceLocation,
              keyword: "items",
              keywordLocation,
              error: `Items did not match schema.`
            }, ...result.errors);
            if (stop)
              break;
          }
        }
      } else {
        for (;i < length; i++) {
          const result = validate(instance[i], $items, draft, lookup, shortCircuit, recursiveAnchor, `${instanceLocation}/${i}`, keywordLocation);
          evaluated[i] = true;
          if (!result.valid) {
            stop = shortCircuit;
            errors.push({
              instanceLocation,
              keyword: "items",
              keywordLocation,
              error: `Items did not match schema.`
            }, ...result.errors);
            if (stop)
              break;
          }
        }
      }
      if (!stop && $additionalItems !== undefined) {
        const keywordLocation = `${schemaLocation}/additionalItems`;
        for (;i < length; i++) {
          const result = validate(instance[i], $additionalItems, draft, lookup, shortCircuit, recursiveAnchor, `${instanceLocation}/${i}`, keywordLocation);
          evaluated[i] = true;
          if (!result.valid) {
            stop = shortCircuit;
            errors.push({
              instanceLocation,
              keyword: "additionalItems",
              keywordLocation,
              error: `Items did not match additional items schema.`
            }, ...result.errors);
          }
        }
      }
    }
    if ($contains !== undefined) {
      if (length === 0 && $minContains === undefined) {
        errors.push({
          instanceLocation,
          keyword: "contains",
          keywordLocation: `${schemaLocation}/contains`,
          error: `Array is empty. It must contain at least one item matching the schema.`
        });
      } else if ($minContains !== undefined && length < $minContains) {
        errors.push({
          instanceLocation,
          keyword: "minContains",
          keywordLocation: `${schemaLocation}/minContains`,
          error: `Array has less items (${length}) than minContains (${$minContains}).`
        });
      } else {
        const keywordLocation = `${schemaLocation}/contains`;
        const errorsLength = errors.length;
        let contained = 0;
        for (let j = 0;j < length; j++) {
          const result = validate(instance[j], $contains, draft, lookup, shortCircuit, recursiveAnchor, `${instanceLocation}/${j}`, keywordLocation);
          if (result.valid) {
            evaluated[j] = true;
            contained++;
          } else {
            errors.push(...result.errors);
          }
        }
        if (contained >= ($minContains || 0)) {
          errors.length = errorsLength;
        }
        if ($minContains === undefined && $maxContains === undefined && contained === 0) {
          errors.splice(errorsLength, 0, {
            instanceLocation,
            keyword: "contains",
            keywordLocation,
            error: `Array does not contain item matching schema.`
          });
        } else if ($minContains !== undefined && contained < $minContains) {
          errors.push({
            instanceLocation,
            keyword: "minContains",
            keywordLocation: `${schemaLocation}/minContains`,
            error: `Array must contain at least ${$minContains} items matching schema. Only ${contained} items were found.`
          });
        } else if ($maxContains !== undefined && contained > $maxContains) {
          errors.push({
            instanceLocation,
            keyword: "maxContains",
            keywordLocation: `${schemaLocation}/maxContains`,
            error: `Array may contain at most ${$maxContains} items matching schema. ${contained} items were found.`
          });
        }
      }
    }
    if (!stop && $unevaluatedItems !== undefined) {
      const keywordLocation = `${schemaLocation}/unevaluatedItems`;
      for (i;i < length; i++) {
        if (evaluated[i]) {
          continue;
        }
        const result = validate(instance[i], $unevaluatedItems, draft, lookup, shortCircuit, recursiveAnchor, `${instanceLocation}/${i}`, keywordLocation);
        evaluated[i] = true;
        if (!result.valid) {
          errors.push({
            instanceLocation,
            keyword: "unevaluatedItems",
            keywordLocation,
            error: `Items did not match unevaluated items schema.`
          }, ...result.errors);
        }
      }
    }
    if ($uniqueItems) {
      for (let j = 0;j < length; j++) {
        const a = instance[j];
        const ao = typeof a === "object" && a !== null;
        for (let k = 0;k < length; k++) {
          if (j === k) {
            continue;
          }
          const b = instance[k];
          const bo = typeof b === "object" && b !== null;
          if (a === b || ao && bo && deepCompareStrict(a, b)) {
            errors.push({
              instanceLocation,
              keyword: "uniqueItems",
              keywordLocation: `${schemaLocation}/uniqueItems`,
              error: `Duplicate items at indexes ${j} and ${k}.`
            });
            j = Number.MAX_SAFE_INTEGER;
            k = Number.MAX_SAFE_INTEGER;
          }
        }
      }
    }
  } else if (instanceType === "number") {
    if (draft === "4") {
      if ($minimum !== undefined && ($exclusiveMinimum === true && instance <= $minimum || instance < $minimum)) {
        errors.push({
          instanceLocation,
          keyword: "minimum",
          keywordLocation: `${schemaLocation}/minimum`,
          error: `${instance} is less than ${$exclusiveMinimum ? "or equal to " : ""} ${$minimum}.`
        });
      }
      if ($maximum !== undefined && ($exclusiveMaximum === true && instance >= $maximum || instance > $maximum)) {
        errors.push({
          instanceLocation,
          keyword: "maximum",
          keywordLocation: `${schemaLocation}/maximum`,
          error: `${instance} is greater than ${$exclusiveMaximum ? "or equal to " : ""} ${$maximum}.`
        });
      }
    } else {
      if ($minimum !== undefined && instance < $minimum) {
        errors.push({
          instanceLocation,
          keyword: "minimum",
          keywordLocation: `${schemaLocation}/minimum`,
          error: `${instance} is less than ${$minimum}.`
        });
      }
      if ($maximum !== undefined && instance > $maximum) {
        errors.push({
          instanceLocation,
          keyword: "maximum",
          keywordLocation: `${schemaLocation}/maximum`,
          error: `${instance} is greater than ${$maximum}.`
        });
      }
      if ($exclusiveMinimum !== undefined && instance <= $exclusiveMinimum) {
        errors.push({
          instanceLocation,
          keyword: "exclusiveMinimum",
          keywordLocation: `${schemaLocation}/exclusiveMinimum`,
          error: `${instance} is less than ${$exclusiveMinimum}.`
        });
      }
      if ($exclusiveMaximum !== undefined && instance >= $exclusiveMaximum) {
        errors.push({
          instanceLocation,
          keyword: "exclusiveMaximum",
          keywordLocation: `${schemaLocation}/exclusiveMaximum`,
          error: `${instance} is greater than or equal to ${$exclusiveMaximum}.`
        });
      }
    }
    if ($multipleOf !== undefined) {
      const remainder = instance % $multipleOf;
      if (Math.abs(0 - remainder) >= 0.00000011920929 && Math.abs($multipleOf - remainder) >= 0.00000011920929) {
        errors.push({
          instanceLocation,
          keyword: "multipleOf",
          keywordLocation: `${schemaLocation}/multipleOf`,
          error: `${instance} is not a multiple of ${$multipleOf}.`
        });
      }
    }
  } else if (instanceType === "string") {
    const length = $minLength === undefined && $maxLength === undefined ? 0 : ucs2length(instance);
    if ($minLength !== undefined && length < $minLength) {
      errors.push({
        instanceLocation,
        keyword: "minLength",
        keywordLocation: `${schemaLocation}/minLength`,
        error: `String is too short (${length} < ${$minLength}).`
      });
    }
    if ($maxLength !== undefined && length > $maxLength) {
      errors.push({
        instanceLocation,
        keyword: "maxLength",
        keywordLocation: `${schemaLocation}/maxLength`,
        error: `String is too long (${length} > ${$maxLength}).`
      });
    }
    if ($pattern !== undefined && !new RegExp($pattern, "u").test(instance)) {
      errors.push({
        instanceLocation,
        keyword: "pattern",
        keywordLocation: `${schemaLocation}/pattern`,
        error: `String does not match pattern.`
      });
    }
    if ($format !== undefined && format[$format] && !format[$format](instance)) {
      errors.push({
        instanceLocation,
        keyword: "format",
        keywordLocation: `${schemaLocation}/format`,
        error: `String does not match format "${$format}".`
      });
    }
  }
  return { valid: errors.length === 0, errors };
}

// node_modules/.bun/@cfworker+json-schema@4.1.1/node_modules/@cfworker/json-schema/dist/esm/validator.js
class Validator {
  schema;
  draft;
  shortCircuit;
  lookup;
  constructor(schema, draft = "2019-09", shortCircuit = true) {
    this.schema = schema;
    this.draft = draft;
    this.shortCircuit = shortCircuit;
    this.lookup = dereference(schema);
  }
  validate(instance) {
    return validate(instance, this.schema, this.draft, this.lookup, this.shortCircuit);
  }
  addSchema(schema, id) {
    if (id) {
      schema = { ...schema, $id: id };
    }
    dereference(schema, this.lookup);
  }
}

// node_modules/.bun/@cntxt-labs+patra-core@.+vendor+patra+cntxt-labs-patra-core-0.0.0.tgz/node_modules/@cntxt-labs/patra-core/src/template.ts
var ID = /^[a-z][a-z0-9-]{0,63}$/;
var SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
var TOKEN = /^--[a-z][a-z0-9-]*$/;
var MANIFEST = "template.json";
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function segment(key) {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}
function loadTemplate(dir) {
  const problems = [];
  const problem = (file, at, code, message) => problems.push({ file, at, code, message });
  const readText = (file, at) => {
    const path = join(dir, file);
    if (!existsSync(path)) {
      problem(MANIFEST, at, "MISSING_FILE", `${file} does not exist in ${dir}`);
      return;
    }
    return readFileSync(path, "utf8");
  };
  const readJson = (file, at) => {
    const text = readText(file, at);
    if (text === undefined)
      return;
    try {
      return JSON.parse(text);
    } catch (error) {
      problem(file, "", "INVALID_JSON", `${file} is not valid JSON: ${String(error)}`);
      return;
    }
  };
  const raw = readJson(MANIFEST, "");
  if (!isRecord2(raw)) {
    if (raw !== undefined)
      problem(MANIFEST, "", "INVALID_MANIFEST", "template.json must be an object");
    return { ok: false, problems };
  }
  const text = (key, pattern, hint) => {
    const value = raw[key];
    if (typeof value !== "string" || value.trim() === "") {
      problem(MANIFEST, `/${key}`, "INVALID_MANIFEST", `${key} must be a non-empty string`);
      return "";
    }
    if (pattern !== undefined && !pattern.test(value)) {
      problem(MANIFEST, `/${key}`, "INVALID_MANIFEST", `${key} ${hint ?? "is not valid"}: ${value}`);
    }
    return value;
  };
  const id = text("id", ID, "must be lowercase kebab-case");
  const version = text("version", SEMVER, "must be semver (1.2.3)");
  const description = text("description");
  const pageFile = text("page");
  const schemaFile = text("schema");
  const page = pageFile === "" ? undefined : readText(pageFile, "/page");
  const parts = new Map;
  const rawParts = raw.parts ?? {};
  if (!isRecord2(rawParts)) {
    problem(MANIFEST, "/parts", "INVALID_MANIFEST", "parts must be an object of name -> part");
  } else {
    for (const [name, value] of Object.entries(rawParts)) {
      const at = `/parts/${segment(name)}`;
      if (!ID.test(name))
        problem(MANIFEST, at, "INVALID_MANIFEST", `part name must be kebab-case: ${name}`);
      if (!isRecord2(value) || typeof value.file !== "string") {
        problem(MANIFEST, at, "INVALID_MANIFEST", "a part needs a file");
        continue;
      }
      const collection = value.collection;
      const key = value.key;
      if (collection !== undefined && (typeof collection !== "string" || !collection.startsWith("/"))) {
        problem(MANIFEST, `${at}/collection`, "INVALID_MANIFEST", "collection must be a JSON Pointer such as /sections");
        continue;
      }
      if (collection === undefined !== (key === undefined) || key !== undefined && typeof key !== "string") {
        problem(MANIFEST, at, "INVALID_MANIFEST", "collection and key go together: both or neither");
        continue;
      }
      const html = readText(value.file, `${at}/file`);
      if (html === undefined)
        continue;
      parts.set(name, {
        name,
        file: value.file,
        html,
        ...typeof collection === "string" ? { collection } : {},
        ...typeof key === "string" ? { key } : {}
      });
    }
  }
  const partNames = new Set(isRecord2(rawParts) ? Object.keys(rawParts) : []);
  if (page !== undefined)
    problems.push(...templateProblems(pageFile, page, partNames));
  for (const part of parts.values())
    problems.push(...templateProblems(part.file, part.html, partNames));
  const actions = {};
  const rawActions = raw.actions ?? {};
  if (!isRecord2(rawActions)) {
    problem(MANIFEST, "/actions", "INVALID_MANIFEST", "actions must be an object of name -> action");
  } else {
    for (const [name, value] of Object.entries(rawActions)) {
      const at = `/actions/${segment(name)}`;
      if (!ID.test(name))
        problem(MANIFEST, at, "INVALID_MANIFEST", `action name must be kebab-case: ${name}`);
      if (!isRecord2(value) || typeof value.part !== "string") {
        problem(MANIFEST, at, "INVALID_MANIFEST", "an action needs the part it acts on");
        continue;
      }
      const target = rawParts !== undefined && isRecord2(rawParts) ? rawParts[value.part] : undefined;
      if (target === undefined) {
        problem(MANIFEST, `${at}/part`, "UNKNOWN_PART", `no part ${value.part}`);
      } else if (!isRecord2(target) || target.key === undefined) {
        problem(MANIFEST, `${at}/part`, "INVALID_MANIFEST", `${value.part} has no key, so an action cannot say which item it is on`);
      }
      if (value.form !== undefined && (typeof value.form !== "string" || !isRecord2(rawParts) || rawParts[value.form] === undefined)) {
        problem(MANIFEST, `${at}/form`, "UNKNOWN_PART", `no part ${String(value.form)} for the form`);
      }
      const fields = value.fields ?? [];
      if (!Array.isArray(fields) || !fields.every((f) => typeof f === "string")) {
        problem(MANIFEST, `${at}/fields`, "INVALID_MANIFEST", "fields must be a list of field names");
        continue;
      }
      const defaults = {};
      if (value.defaults !== undefined) {
        if (!isRecord2(value.defaults)) {
          problem(MANIFEST, `${at}/defaults`, "INVALID_MANIFEST", "defaults must map a field to a JSON Pointer");
        } else {
          for (const [field, pointer] of Object.entries(value.defaults)) {
            if (!fields.includes(field)) {
              problem(MANIFEST, `${at}/defaults/${segment(field)}`, "INVALID_MANIFEST", `${field} is not one of the action's fields`);
            } else if (typeof pointer !== "string" || !pointer.startsWith("/")) {
              problem(MANIFEST, `${at}/defaults/${segment(field)}`, "INVALID_MANIFEST", "a default must be a JSON Pointer such as /editable/text");
            } else {
              defaults[field] = pointer;
            }
          }
        }
      }
      actions[name] = {
        part: value.part,
        ...typeof value.form === "string" ? { form: value.form } : {},
        fields,
        ...Object.keys(defaults).length > 0 ? { defaults } : {}
      };
    }
  }
  const styles = [];
  const rawStyles = raw.styles ?? [];
  if (!Array.isArray(rawStyles) || !rawStyles.every((f) => typeof f === "string")) {
    problem(MANIFEST, "/styles", "INVALID_MANIFEST", "styles must be a list of CSS files");
  } else {
    rawStyles.forEach((file, index) => {
      const css = readText(file, `/styles/${index}`);
      if (css !== undefined)
        styles.push({ file, css });
    });
  }
  const rawTokens = raw.tokens ?? [];
  const tokens = [];
  if (!Array.isArray(rawTokens)) {
    problem(MANIFEST, "/tokens", "INVALID_MANIFEST", 'tokens must be a list such as ["--bg", "--ink"]');
  } else {
    rawTokens.forEach((token, index) => {
      if (typeof token === "string" && TOKEN.test(token))
        tokens.push(token);
      else
        problem(MANIFEST, `/tokens/${index}`, "INVALID_MANIFEST", `not a CSS custom property name: ${String(token)}`);
    });
  }
  let schema;
  let validator;
  if (schemaFile !== "") {
    const rawSchema = readJson(schemaFile, "/schema");
    if (isRecord2(rawSchema)) {
      try {
        schema = rawSchema;
        validator = new Validator(schema, "2020-12", false);
      } catch (error) {
        problem(schemaFile, "", "INVALID_SCHEMA", `the content schema does not compile: ${String(error)}`);
      }
    } else if (rawSchema !== undefined) {
      problem(schemaFile, "", "INVALID_SCHEMA", "the content schema must be a JSON object");
    }
  }
  if (problems.length > 0 || page === undefined || schema === undefined || validator === undefined) {
    return { ok: false, problems };
  }
  const manifest = {
    id,
    version,
    description,
    page: pageFile,
    parts: Object.fromEntries([...parts].map(([name, part]) => [name, partManifest(part)])),
    schema: schemaFile,
    actions,
    tokens,
    ...styles.length > 0 ? { styles: styles.map((s) => s.file) } : {}
  };
  const checker = validator;
  return {
    ok: true,
    template: {
      dir,
      manifest,
      page,
      parts,
      styles,
      schema,
      check: (content) => [
        ...schemaProblems(checker, content),
        ...collectionProblems(parts, content)
      ]
    }
  };
}
function partManifest(part) {
  return {
    file: part.file,
    ...part.collection === undefined ? {} : { collection: part.collection },
    ...part.key === undefined ? {} : { key: part.key }
  };
}
var WRAPPERS = new Set([
  "properties",
  "items",
  "prefixItems",
  "allOf",
  "$ref",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems"
]);
var REPEATS = new Set([...WRAPPERS, "false"]);
function schemaProblems(validator, content) {
  const result = validator.validate(content);
  if (result.valid)
    return [];
  const errors = result.errors;
  const explained = (e) => errors.some((d) => d !== e && !WRAPPERS.has(d.keyword) && (d.instanceLocation.startsWith(`${e.instanceLocation}/`) || d.instanceLocation === e.instanceLocation && !REPEATS.has(d.keyword)));
  const seen = new Set;
  const problems = [];
  for (const e of errors) {
    if (REPEATS.has(e.keyword) && explained(e))
      continue;
    if (WRAPPERS.has(e.keyword))
      continue;
    const at = e.instanceLocation.replace(/^#/, "");
    const message = e.keyword === "false" ? `${at || "this"} is not allowed here` : e.error;
    const id = `${at}\x00${message}`;
    if (seen.has(id))
      continue;
    seen.add(id);
    problems.push({ file: "content", at, code: "INVALID_CONTENT", message });
  }
  return problems;
}
function resolvePointer(value, pointer) {
  if (pointer === "")
    return value;
  let current = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current))
      current = current[Number(key)];
    else if (isRecord2(current))
      current = current[key];
    else
      return;
  }
  return current;
}
function collectionProblems(parts, content) {
  const problems = [];
  for (const part of parts.values()) {
    if (part.collection === undefined || part.key === undefined)
      continue;
    const items = resolvePointer(content, part.collection);
    if (items === undefined)
      continue;
    if (!Array.isArray(items)) {
      problems.push({
        file: "content",
        at: part.collection,
        code: "NOT_A_COLLECTION",
        message: `part ${part.name} renders ${part.collection}, which must be a list`
      });
      continue;
    }
    const seen = new Map;
    items.forEach((item, index) => {
      const key = isRecord2(item) ? item[part.key ?? ""] : undefined;
      const at = `${part.collection}/${index}`;
      if (typeof key !== "string" || key === "") {
        problems.push({
          file: "content",
          at,
          code: "MISSING_KEY",
          message: `items of ${part.collection} need a string ${part.key} so ${part.name} can update one of them`
        });
        return;
      }
      const first = seen.get(key);
      if (first !== undefined) {
        problems.push({
          file: "content",
          at,
          code: "DUPLICATE_KEY",
          message: `${part.key} ${key} is used by ${part.collection}/${first} as well`
        });
      }
      seen.set(key, index);
    });
  }
  return problems;
}
// node_modules/.bun/@cntxt-labs+patra-themes@..+vendor+patra+cntxt-labs-patra-themes-0.0.0.tgz/node_modules/@cntxt-labs/patra-themes/index.ts
import { join as join2 } from "path";
function themeFile(name) {
  return join2(import.meta.dir, name, "theme.css");
}

// yojana-core/src/conflicts.ts
function findBaseConflicts(heads, deltas) {
  const conflicts = [];
  for (const delta of deltas) {
    const id = delta.op === "remove" ? delta.id : delta.requirement.id;
    const actual = heads.get(id);
    const expected = delta.base;
    const ok = delta.op === "add" ? actual === undefined : actual === expected;
    if (!ok)
      conflicts.push({ requirement: id, op: delta.op, expected, actual });
  }
  return conflicts;
}
// yojana-core/src/errors.ts
class YojanaError extends Error {
  code;
  hint;
  constructor(code, message, options) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "YojanaError";
    this.code = code;
    this.hint = options?.hint;
  }
}

class InvalidArgumentError extends YojanaError {
  constructor(name, expected, got) {
    super("INVALID_ARGUMENT", `${name}: expected ${expected}, got ${JSON.stringify(got)}`);
    this.name = "InvalidArgumentError";
  }
}
// yojana-core/src/events.ts
import { createHash } from "crypto";
var WORK_DECISIONS = ["close", "reopen"];
var EVENT_ID_HEX_CHARS = 16;
function computeEventId(event, at, actor, writtenAt) {
  const digest = createHash("sha256").update(JSON.stringify({ event, at, actor, writtenAt })).digest("hex");
  return `e_${digest.slice(0, EVENT_ID_HEX_CHARS)}`;
}
// yojana-core/src/fold.ts
function openAnomalies(state) {
  return state.anomalies.filter((a) => a.settledBy === undefined);
}
function emptyFoldState() {
  return {
    plans: new Map,
    changes: new Map,
    decisions: new Map,
    proposals: new Map,
    anomalies: [],
    head: 0
  };
}
function planFor(state, id) {
  let plan = state.plans.get(id);
  if (plan === undefined) {
    plan = {
      id,
      status: "draft",
      statusHistory: [],
      heads: new Map,
      contested: new Map,
      annotations: [],
      removedAnnotations: new Map,
      workItems: [],
      approvals: new Map
    };
    state.plans.set(id, plan);
  }
  return plan;
}
function applyDelta(state, plan, delta, seq) {
  const id = delta.op === "remove" ? delta.id : delta.requirement.id;
  const actual = plan.heads.get(id)?.revision;
  const stale = delta.op === "add" ? actual !== undefined : actual !== delta.base;
  const after = delta.op === "remove" ? undefined : delta.requirement.revision;
  if (stale) {
    const competing = plan.contested.get(id) ?? [actual];
    plan.contested.set(id, [...competing, after]);
  } else if (plan.contested.delete(id)) {
    for (const anomaly of state.anomalies) {
      if (anomaly.code === "STALE_BASE" && anomaly.planId === plan.id && anomaly.requirement === id && anomaly.settledBy === undefined) {
        anomaly.settledBy = seq;
      }
    }
  }
  if (stale) {
    state.anomalies.push({
      seq,
      code: "STALE_BASE",
      message: `${delta.op} of ${id} in ${plan.id} expected ${delta.base ?? "no requirement"}, log had ${actual ?? "none"}`,
      planId: plan.id,
      requirement: id
    });
  }
  if (delta.op === "remove")
    plan.heads.delete(id);
  else
    plan.heads.set(id, delta.requirement);
}
function applyEvent(state, event) {
  const { seq } = event;
  if (seq <= state.head) {
    state.anomalies.push({
      seq,
      code: "OUT_OF_ORDER",
      message: `event ${seq} arrived after ${state.head}; skipped`
    });
    return;
  }
  state.head = seq;
  switch (event.type) {
    case "revision-recorded": {
      const plan = planFor(state, event.planId);
      const delta = event.base === undefined ? { op: "add", requirement: event.requirement } : { op: "modify", requirement: event.requirement, base: event.base };
      applyDelta(state, plan, delta, seq);
      return;
    }
    case "requirement-removed": {
      const plan = planFor(state, event.planId);
      applyDelta(state, plan, { op: "remove", id: event.id, base: event.base }, seq);
      return;
    }
    case "change-opened": {
      const { change } = event;
      if (state.changes.has(change.id)) {
        state.anomalies.push({
          seq,
          code: "DUPLICATE_CHANGE",
          message: `change ${change.id} was already opened; the later one is ignored`
        });
        return;
      }
      planFor(state, change.planId);
      state.changes.set(change.id, {
        change,
        status: "open",
        openedSeq: seq,
        openedAt: event.at,
        closedSeq: undefined,
        reason: undefined
      });
      return;
    }
    case "change-archived":
    case "change-abandoned": {
      const entry = state.changes.get(event.changeId);
      if (entry === undefined || entry.status !== "open") {
        state.anomalies.push({
          seq,
          code: "CHANGE_NOT_OPEN",
          message: `change ${event.changeId} is ${entry?.status ?? "unknown"}; ${event.type} ignored`
        });
        return;
      }
      entry.closedSeq = seq;
      if (event.type === "change-abandoned") {
        entry.status = "abandoned";
        entry.reason = event.reason;
        return;
      }
      entry.status = "archived";
      const plan = planFor(state, entry.change.planId);
      for (const delta of entry.change.deltas)
        applyDelta(state, plan, delta, seq);
      return;
    }
    case "status-changed": {
      const plan = planFor(state, event.planId);
      if (event.proposal !== undefined) {
        const proposal = state.proposals.get(event.proposal);
        if (proposal === undefined || proposal.status !== "proposed") {
          state.anomalies.push({
            seq,
            code: "PROPOSAL_OUT_OF_STEP",
            message: `status proposal ${event.proposal} is ${proposal?.status ?? "unknown"}; the plan moved to ${event.to} anyway`,
            planId: plan.id
          });
        } else {
          proposal.status = "accepted";
          proposal.decidedBy = event.actor;
          proposal.at = event.at;
        }
      }
      plan.status = event.to;
      plan.statusHistory.push({
        to: event.to,
        reason: event.reason,
        actor: event.actor,
        at: event.at,
        seq
      });
      return;
    }
    case "status-proposed": {
      planFor(state, event.planId);
      state.proposals.set(event.eventId, {
        id: event.eventId,
        planId: event.planId,
        to: event.to,
        reason: event.reason,
        proposedBy: event.actor,
        proposedAt: event.at,
        status: "proposed",
        decidedBy: undefined,
        at: event.at,
        outcome: undefined
      });
      return;
    }
    case "status-declined": {
      const proposal = state.proposals.get(event.proposalId);
      if (proposal === undefined || proposal.status !== "proposed") {
        state.anomalies.push({
          seq,
          code: "PROPOSAL_OUT_OF_STEP",
          message: `status proposal ${event.proposalId} is ${proposal?.status ?? "unknown"}; status-declined ignored`
        });
        return;
      }
      proposal.status = "declined";
      proposal.decidedBy = event.actor;
      proposal.at = event.at;
      proposal.outcome = event.reason;
      return;
    }
    case "requirement-approved": {
      planFor(state, event.planId).approvals.set(event.requirement, {
        verdict: "approved",
        revision: event.revision,
        by: event.actor,
        at: event.at
      });
      return;
    }
    case "requirement-declined": {
      planFor(state, event.planId).approvals.set(event.requirement, {
        verdict: "declined",
        revision: event.revision,
        by: event.actor,
        at: event.at,
        reason: event.reason
      });
      return;
    }
    case "work-linked": {
      planFor(state, event.planId).workItems = event.workItems;
      return;
    }
    case "annotation-added": {
      planFor(state, event.planId).annotations.push(event.annotation);
      return;
    }
    case "annotation-removed": {
      const plan = planFor(state, event.planId);
      if (!plan.annotations.some((a) => a.id === event.annotationId)) {
        state.anomalies.push({
          seq,
          code: "ANNOTATION_UNKNOWN",
          message: `no comment ${event.annotationId} on ${event.planId}; annotation-removed ignored`
        });
        return;
      }
      plan.removedAnnotations.set(event.annotationId, { by: event.actor, at: event.at });
      return;
    }
    case "decision-recorded": {
      planFor(state, event.planId);
      state.decisions.set(event.eventId, {
        id: event.eventId,
        planId: event.planId,
        requirement: event.requirement,
        item: event.item,
        decision: event.decision,
        reason: event.reason,
        recordedBy: event.actor,
        recordedAt: event.at,
        status: "recorded",
        finalizedBy: undefined,
        at: event.at,
        outcome: undefined
      });
      return;
    }
    case "decision-finalized":
    case "decision-applied":
    case "decision-failed": {
      const decision = state.decisions.get(event.decisionId);
      const expected = event.type === "decision-finalized" ? ["recorded"] : ["finalized", "failed"];
      if (decision === undefined || !expected.includes(decision.status)) {
        state.anomalies.push({
          seq,
          code: "DECISION_OUT_OF_STEP",
          message: `decision ${event.decisionId} is ${decision?.status ?? "unknown"}; ${event.type} ignored`
        });
        return;
      }
      decision.at = event.at;
      if (event.type === "decision-finalized") {
        decision.status = "finalized";
        decision.finalizedBy = event.actor;
      } else if (event.type === "decision-applied") {
        decision.status = "applied";
        decision.outcome = event.note;
      } else {
        decision.status = "failed";
        decision.outcome = event.error;
      }
      return;
    }
    default: {
      const type = event.type;
      state.anomalies.push({
        seq,
        code: "UNKNOWN_EVENT",
        message: `event type ${String(type)} is not known to this version; skipped`
      });
    }
  }
}
function foldLog(events, state = emptyFoldState()) {
  for (const event of events)
    applyEvent(state, event);
  return state;
}
function planHeads(state, planId) {
  const heads = new Map;
  for (const [id, requirement] of state.plans.get(planId)?.heads ?? []) {
    heads.set(id, requirement.revision);
  }
  return heads;
}
function isAnnotationRemoved(plan, id) {
  return plan.removedAnnotations.has(id);
}
function approvalOf(plan, requirement) {
  const approval = plan.approvals.get(requirement);
  if (approval === undefined)
    return;
  return { ...approval, stale: plan.heads.get(requirement)?.revision !== approval.revision };
}
function waitingProposals(state, planId) {
  return [...state.proposals.values()].filter((p) => p.planId === planId && p.status === "proposed");
}
function isAnnotationOutdated(state, planId, a) {
  return state.plans.get(planId)?.heads.get(a.requirement)?.revision !== a.revision;
}
// yojana-core/src/model.ts
var PLAN_STATUSES = [
  "draft",
  "accepted",
  "in-progress",
  "realized",
  "superseded",
  "abandoned"
];
// yojana-core/src/revision.ts
import { createHash as createHash2 } from "crypto";
var REQUIREMENT_ID = /^[a-z][a-z0-9-]{0,63}$/;
function assertRequirementId(id) {
  if (!REQUIREMENT_ID.test(id)) {
    throw new InvalidArgumentError("requirement id", "lowercase kebab-case, 1-64 chars", id);
  }
  return id;
}
var CHANGE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
function assertChangeId(id) {
  if (!CHANGE_ID.test(id)) {
    throw new InvalidArgumentError("change id", "lowercase kebab-case, 1-64 chars", id);
  }
  return id;
}
function normalizeContent(text) {
  return text.replace(/\r\n?/g, `
`).split(`
`).map((line) => line.trimEnd()).join(`
`).trim();
}
var REVISION_HEX_CHARS = 16;
function requirementRevision(requirement) {
  const { id, title, text, claims } = requirement;
  const claimLines = claims.map((c) => `claim ${c.kind} ${c.expect} ${c.expression.trim()}`);
  const work = [...requirement.workItems ?? []].sort();
  const workLines = work.length > 0 ? [`work ${work.join(",")}`] : [];
  return revisionHash(id, [`title ${title.trim()}`, normalizeContent(text), ...claimLines, ...workLines].join(`
`));
}
function revisionHash(id, text) {
  const digest = createHash2("sha256").update(`${id}
${normalizeContent(text)}`).digest("hex");
  return `r_${digest.slice(0, REVISION_HEX_CHARS)}`;
}
// yojana-markdown/src/document.ts
var REQUIREMENT_HEADING = /^##\s+(?:(ADDED|MODIFIED|REMOVED)\s+)?Requirement:\s*(.*?)\s*(?:\{#([^}]*)\})?\s*$/;
var LEVEL2_HEADING = /^##\s/;
var TITLE_HEADING = /^#\s+(.*?)\s*#*\s*$/;
var FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
var FRONTMATTER_FENCE = "---";
var GIT_CONFLICT_MARKER = /^(<{7} |={7}$|>{7} )/;
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function closesFence(line, fence) {
  const trimmed = line.trim();
  const char = fence.marker.charAt(0);
  return trimmed.length >= fence.marker.length && [...trimmed].every((c) => c === char) && line.length - line.trimStart().length <= 3;
}
function trimBlankLines(lines) {
  return lines.join(`
`).replace(/^\s*\n/, "").trimEnd();
}
function parseDocument(input, issue) {
  const lines = input.replace(/\r\n?/g, `
`).split(`
`);
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
    issue(1, "MISSING_FRONTMATTER", "the file starts with YAML frontmatter between --- lines");
    return;
  }
  const closing = lines.findIndex((l, i) => i > 0 && l.trim() === FRONTMATTER_FENCE);
  if (closing === -1) {
    issue(1, "MISSING_FRONTMATTER", "the frontmatter opened on line 1 is never closed with ---");
    return;
  }
  let meta = {};
  let metaReadable = true;
  try {
    const parsed = Bun.YAML.parse(lines.slice(1, closing).join(`
`));
    if (parsed !== null && parsed !== undefined && !isRecord3(parsed)) {
      issue(2, "INVALID_FRONTMATTER", "frontmatter must be a mapping of keys to values");
      metaReadable = false;
    } else if (isRecord3(parsed)) {
      meta = parsed;
    }
  } catch (error) {
    issue(2, "INVALID_FRONTMATTER", `frontmatter is not valid YAML: ${String(error)}`);
    metaReadable = false;
  }
  const sections = [{ kind: "prose", lines: [] }];
  let fence;
  let sawContent = false;
  let heading;
  let headingLine;
  const current = () => sections[sections.length - 1] ?? { kind: "prose", lines: [] };
  const pushLine = (line) => {
    const section = current();
    if (section.kind === "prose")
      section.lines.push(line);
    else
      section.draft.lines.push(line);
  };
  const finishYojanaBlock = (block) => {
    const section = current();
    if (block.info !== "yojana:claim") {
      issue(block.line, "UNKNOWN_BLOCK", `unknown block \`${block.info}\`; known: yojana:claim`);
      return;
    }
    if (section.kind !== "requirement") {
      issue(block.line, "CLAIM_OUTSIDE_REQUIREMENT", "a claim must sit inside a requirement");
      return;
    }
    const claim = parseClaim(block, issue);
    if (claim !== undefined)
      section.draft.claims.push(claim);
  };
  for (let i = closing + 1;i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    if (fence !== undefined) {
      if (closesFence(line, fence)) {
        if (fence.info.startsWith("yojana:"))
          finishYojanaBlock(fence);
        else
          pushLine(line);
        fence = undefined;
      } else if (fence.info.startsWith("yojana:")) {
        fence.body.push(line);
      } else {
        pushLine(line);
      }
      continue;
    }
    if (GIT_CONFLICT_MARKER.test(line)) {
      issue(lineNo, "GIT_CONFLICT_MARKER", "this file still has a git merge conflict; resolve it before yojana reads it");
    }
    const open = FENCE_OPEN.exec(line);
    if (open !== null) {
      fence = { marker: open[1] ?? "```", info: open[2] ?? "", line: lineNo, body: [] };
      if (!fence.info.startsWith("yojana:"))
        pushLine(line);
      sawContent = true;
      continue;
    }
    const titleMatch = TITLE_HEADING.exec(line);
    if (titleMatch !== null && !sawContent) {
      heading = (titleMatch[1] ?? "").trim();
      headingLine = lineNo;
      sawContent = true;
      continue;
    }
    const requirement = REQUIREMENT_HEADING.exec(line);
    if (requirement !== null) {
      const [id, ...attributes] = (requirement[3] ?? "").trim().split(/\s+/);
      sections.push({
        kind: "requirement",
        draft: {
          op: requirement[1],
          title: (requirement[2] ?? "").trim(),
          id: requirement[3] === undefined ? undefined : id,
          attributes,
          line: lineNo,
          lines: [],
          claims: []
        }
      });
      sawContent = true;
      continue;
    }
    if (LEVEL2_HEADING.test(line)) {
      sections.push({ kind: "prose", lines: [line] });
      sawContent = true;
      continue;
    }
    if (line.trim() !== "")
      sawContent = true;
    pushLine(line);
  }
  if (fence !== undefined) {
    issue(fence.line, "UNCLOSED_FENCE", `code fence ${fence.marker} is never closed`);
  }
  const parts = [];
  const seen = new Map;
  for (const section of sections) {
    if (section.kind === "prose") {
      const markdown = trimBlankLines(section.lines);
      if (markdown !== "")
        parts.push({ kind: "prose", markdown });
      continue;
    }
    const { draft } = section;
    if (draft.id === undefined || draft.id === "") {
      issue(draft.line, "MISSING_REQUIREMENT_ID", "add an id: ## Requirement: <title> {#req-id}");
      continue;
    }
    try {
      assertRequirementId(draft.id);
    } catch (error) {
      issue(draft.line, "INVALID_REQUIREMENT_ID", String(error));
      continue;
    }
    const first = seen.get(draft.id);
    if (first !== undefined) {
      issue(draft.line, "DUPLICATE_REQUIREMENT_ID", `id ${draft.id} is already used on line ${first}`);
      continue;
    }
    seen.set(draft.id, draft.line);
    let workItems = [];
    let badAttribute = false;
    for (const attribute of draft.attributes) {
      const [key, value = ""] = attribute.split("=", 2);
      if (key === "beads" && value !== "") {
        workItems = value.split(",").filter((b) => b !== "");
      } else {
        issue(draft.line, "INVALID_REQUIREMENT_ATTRIBUTE", `"${attribute}" is not understood; known: beads=<id>[,<id>...]`);
        badAttribute = true;
      }
    }
    if (badAttribute)
      continue;
    const fields = {
      id: draft.id,
      title: draft.title,
      text: normalizeContent(draft.lines.join(`
`)),
      claims: draft.claims,
      ...workItems.length > 0 ? { workItems } : {}
    };
    parts.push({
      kind: "requirement",
      op: draft.op,
      line: draft.line,
      requirement: { ...fields, revision: requirementRevision(fields) }
    });
  }
  return { meta, metaReadable, heading, headingLine, parts };
}
function parseClaim(block, issue) {
  let raw;
  try {
    raw = Bun.YAML.parse(block.body.join(`
`));
  } catch (error) {
    issue(block.line, "INVALID_CLAIM", `claim is not valid YAML: ${String(error)}`);
    return;
  }
  if (!isRecord3(raw)) {
    issue(block.line, "INVALID_CLAIM", "a claim is a mapping with kind, expression and expect");
    return;
  }
  const { kind, expression } = raw;
  const expect = raw.expect ?? true;
  if (typeof kind !== "string" || kind.trim() === "") {
    issue(block.line, "INVALID_CLAIM", "claim needs a non-empty string `kind`");
    return;
  }
  if (typeof expression !== "string" || expression.trim() === "") {
    issue(block.line, "INVALID_CLAIM", "claim needs a non-empty string `expression`");
    return;
  }
  if (typeof expect !== "boolean") {
    issue(block.line, "INVALID_CLAIM", "`expect` must be true or false");
    return;
  }
  return { kind: kind.trim(), expression: expression.trim(), expect };
}
function resolveTitle(doc, fallback, issue) {
  const fromMeta = typeof doc.meta.title === "string" ? doc.meta.title.trim() : "";
  if (fromMeta !== "" && doc.heading !== undefined && doc.heading !== fromMeta) {
    issue(doc.headingLine, "TITLE_MISMATCH", `heading "${doc.heading}" differs from frontmatter title`);
  }
  return fromMeta !== "" ? fromMeta : doc.heading ?? fallback;
}

// yojana-markdown/src/change.ts
function parseChange(source, input) {
  const issues = [];
  const issue = (line, code, message) => issues.push({ source, line, code, message });
  const doc = parseDocument(input, issue);
  if (doc === undefined)
    return { ok: false, issues };
  const { meta } = doc;
  const id = typeof meta.id === "string" ? meta.id.trim() : "";
  if (doc.metaReadable) {
    if (id === "")
      issue(2, "MISSING_CHANGE_ID", "frontmatter needs a non-empty string `id`");
    else {
      try {
        assertChangeId(id);
      } catch (error) {
        issue(2, "INVALID_CHANGE_ID", String(error));
      }
    }
  }
  const planId = typeof meta.plan === "string" ? meta.plan.trim() : "";
  if (planId === "" && doc.metaReadable) {
    issue(2, "MISSING_PLAN", "frontmatter needs `plan`: the id of the plan this change edits");
  }
  const title = resolveTitle(doc, id, issue);
  const deltas = [];
  for (const part of doc.parts) {
    if (part.kind === "prose")
      continue;
    const { op, requirement, line } = part;
    if (op === "ADDED")
      deltas.push({ op: "add", requirement });
    else if (op === "MODIFIED")
      deltas.push({ op: "modify", requirement });
    else if (op === "REMOVED")
      deltas.push({ op: "remove", id: requirement.id });
    else {
      issue(line, "MISSING_CHANGE_MARKER", "say what this does: ## ADDED, ## MODIFIED or ## REMOVED Requirement: ...");
    }
  }
  if (deltas.length === 0 && issues.length === 0) {
    issue(undefined, "EMPTY_CHANGE", "a change needs at least one ADDED, MODIFIED or REMOVED requirement");
  }
  issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  if (issues.length > 0)
    return { ok: false, issues };
  return { ok: true, change: { id, planId, title, deltas, source } };
}

// yojana-markdown/src/parse.ts
function parsePlan(source, input) {
  const issues = [];
  const issue = (line, code, message) => issues.push({ source, line, code, message });
  const doc = parseDocument(input, issue);
  if (doc === undefined)
    return { ok: false, issues };
  const { meta } = doc;
  const planId = typeof meta.id === "string" ? meta.id.trim() : "";
  if (planId === "" && doc.metaReadable) {
    issue(2, "MISSING_PLAN_ID", "frontmatter needs a non-empty string `id`");
  }
  let status = "draft";
  if (meta.status !== undefined) {
    const found = PLAN_STATUSES.find((s) => s === meta.status);
    if (found === undefined) {
      issue(2, "INVALID_STATUS", `status must be one of ${PLAN_STATUSES.join(", ")}`);
    } else {
      status = found;
    }
  }
  let workItems = [];
  if (meta.beads !== undefined) {
    if (Array.isArray(meta.beads) && meta.beads.every((b) => typeof b === "string")) {
      workItems = meta.beads.map((b) => b.trim());
    } else {
      issue(2, "INVALID_BEADS", "`beads` must be a list of bead ids");
    }
  }
  const title = resolveTitle(doc, planId, issue);
  const requirements = [];
  const parts = [];
  for (const part of doc.parts) {
    if (part.kind === "prose") {
      parts.push(part);
      continue;
    }
    if (part.op !== undefined) {
      issue(part.line, "CHANGE_MARKER_IN_PLAN", `${part.op} belongs in a change file; a plan states requirements as they are`);
      continue;
    }
    requirements.push(part.requirement);
    parts.push({ kind: "requirement", id: part.requirement.id });
  }
  issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  if (issues.length > 0)
    return { ok: false, issues };
  return {
    ok: true,
    plan: { id: planId, title, status, workItems, requirements, parts, source }
  };
}

// yojana-markdown/src/render.ts
function yamlString(value) {
  if (value.includes(`
`))
    return JSON.stringify(value);
  const quoted = `'${value.replaceAll("'", "''")}'`;
  if (value === "" || value !== value.trim())
    return quoted;
  try {
    const back = Bun.YAML.parse(`v: ${value}`);
    const plainWorks = typeof back === "object" && back !== null && "v" in back && back.v === value;
    return plainWorks ? value : quoted;
  } catch {
    return quoted;
  }
}
function renderClaim(claim) {
  return [
    "```yojana:claim",
    `kind: ${yamlString(claim.kind)}`,
    `expression: ${yamlString(claim.expression)}`,
    ...claim.expect ? [] : ["expect: false"],
    "```"
  ].join(`
`);
}
function renderRequirement(requirement, marker = "") {
  const work = requirement.workItems ?? [];
  const links = work.length > 0 ? ` beads=${work.join(",")}` : "";
  const blocks = [`## ${marker}Requirement: ${requirement.title} {#${requirement.id}${links}}`];
  if (requirement.text !== "")
    blocks.push(requirement.text);
  for (const claim of requirement.claims)
    blocks.push(renderClaim(claim));
  return blocks.join(`

`);
}
function renderPlan(plan) {
  const byId = new Map(plan.requirements.map((r) => [r.id, r]));
  const frontmatter = [
    "---",
    `id: ${yamlString(plan.id)}`,
    `title: ${yamlString(plan.title)}`,
    `status: ${plan.status}`,
    `beads: [${plan.workItems.map(yamlString).join(", ")}]`,
    "---"
  ].join(`
`);
  const blocks = [frontmatter, `# ${plan.title}`];
  for (const part of plan.parts) {
    if (part.kind === "prose") {
      blocks.push(part.markdown);
      continue;
    }
    const requirement = byId.get(part.id);
    if (requirement !== undefined)
      blocks.push(renderRequirement(requirement));
  }
  const placed = new Set(plan.parts.flatMap((p) => p.kind === "requirement" ? [p.id] : []));
  for (const requirement of plan.requirements) {
    if (!placed.has(requirement.id))
      blocks.push(renderRequirement(requirement));
  }
  return `${blocks.join(`

`)}
`;
}
function renderChange(change, why) {
  const frontmatter = [
    "---",
    `id: ${yamlString(change.id)}`,
    `plan: ${yamlString(change.planId)}`,
    `title: ${yamlString(change.title)}`,
    "---"
  ].join(`
`);
  const blocks = [frontmatter];
  if (why !== undefined && why.trim() !== "")
    blocks.push(why.trim());
  for (const delta of change.deltas) {
    if (delta.op === "remove")
      blocks.push(`## REMOVED Requirement: ${delta.id} {#${delta.id}}`);
    else
      blocks.push(renderRequirement(delta.requirement, delta.op === "add" ? "ADDED " : "MODIFIED "));
  }
  return `${blocks.join(`

`)}
`;
}
// yojana-markdown/src/import.ts
var HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
var FENCE = /^ {0,3}(`{3,}|~{3,})/;
var BACKTICKED = /`([a-z][a-z0-9]*)-([a-z0-9]{3,4}(?:\.\d+)*)`/g;
var MAX_ID = 64;
var ID_WORDS = 5;
var MARKDOWN_DEEPEST_HEADING = 6;
function markFences(text) {
  let fence;
  return text.replace(/\r\n?/g, `
`).split(`
`).map((line) => {
    const open = FENCE.exec(line);
    const wasIn = fence !== undefined;
    if (open !== null) {
      const marker = open[1] ?? "";
      if (fence === undefined)
        fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = undefined;
      return { text: line, inFence: true };
    }
    return { text: line, inFence: wasIn };
  });
}
function detectPrefix(text) {
  const counts = new Map;
  for (const match of text.matchAll(BACKTICKED)) {
    const prefix = match[1] ?? "";
    const ids = counts.get(prefix) ?? new Set;
    ids.add(match[0]);
    counts.set(prefix, ids);
  }
  const ranked = [...counts].sort((a, b) => b[1].size - a[1].size);
  const best = ranked[0];
  return best !== undefined && best[1].size >= 2 ? best[0] : undefined;
}
function beadsIn(text, prefix) {
  if (prefix === undefined)
    return [];
  const pattern = new RegExp(`\\b${prefix}-[a-z0-9]{3,4}(?:\\.\\d+)*\\b`, "g");
  return [...new Set(text.match(pattern) ?? [])];
}
function slug(title) {
  const words = title.toLowerCase().replace(/`/g, "").split(/[^a-z0-9]+/).filter((w) => w !== "");
  const id = ["req", ...words.slice(0, ID_WORDS)].join("-").slice(0, MAX_ID).replace(/-+$/, "");
  return id === "req" ? "req-untitled" : id;
}
function isStatusTable(block) {
  const header = block[0] ?? "";
  return /\|\s*status\s*\|/i.test(header);
}
function importRoadmap(text, options) {
  const lines = markFences(text);
  const prefix = options.prefix ?? detectPrefix(text);
  const headings = lines.map((line, index) => ({ line, index, match: line.inFence ? null : HEADING.exec(line.text) })).filter((h) => h.match !== null).map((h) => ({
    index: h.index,
    level: (h.match?.[1] ?? "").length,
    title: (h.match?.[2] ?? "").trim()
  }));
  const h1 = headings.find((h) => h.level === 1);
  const title = h1?.title.replace(/`/g, "") ?? options.planId;
  const levelCounts = new Map;
  for (const h of headings) {
    if (h.level > 1 && beadsIn(h.title, prefix).length > 0) {
      levelCounts.set(h.level, (levelCounts.get(h.level) ?? 0) + 1);
    }
  }
  const level = [...levelCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 2;
  const out = [];
  const requirements = [];
  const usedIds = new Set;
  let droppedTables = 0;
  let table = [];
  const flushTable = () => {
    if (table.length === 0)
      return;
    if (isStatusTable(table)) {
      droppedTables++;
      out.push("_(A status table was here; progress now comes from the beads.)_");
    } else {
      out.push(...table);
    }
    table = [];
  };
  for (const [index, line] of lines.entries()) {
    if (!line.inFence && line.text.trimStart().startsWith("|")) {
      table.push(line.text);
      continue;
    }
    flushTable();
    if (h1 !== undefined && index === h1.index)
      continue;
    const heading = headings.find((h) => h.index === index);
    if (heading === undefined) {
      out.push(line.text);
      continue;
    }
    if (heading.level === level) {
      const beads = beadsIn(heading.title, prefix);
      const leadingIds = beads.map((b) => b.replaceAll(".", "\\.")).join("|");
      const cleanTitle = heading.title.replace(/`/g, "").replace(new RegExp(`^(?:${leadingIds})\\s*[:\\-\u2013\u2014]\\s*`), "").trim() || heading.title;
      let id = slug(cleanTitle);
      for (let n = 2;usedIds.has(id); n++)
        id = `${slug(cleanTitle)}-${n}`;
      usedIds.add(id);
      requirements.push({ id, beads });
      const links = beads.length > 0 ? ` beads=${beads.join(",")}` : "";
      out.push(`## Requirement: ${cleanTitle} {#${id}${links}}`);
    } else if (heading.level < level) {
      out.push(`## ${heading.title}`);
    } else {
      const depth = Math.max(3, heading.level - level + 2);
      out.push(`${"#".repeat(Math.min(depth, MARKDOWN_DEEPEST_HEADING))} ${heading.title}`);
    }
  }
  flushTable();
  const beads = beadsIn(text, prefix);
  const status = options.status ?? "draft";
  const frontmatter = [
    "---",
    `id: ${options.planId}`,
    `title: ${JSON.stringify(title)}`,
    `status: ${status}`,
    `beads: [${beads.join(", ")}]`,
    "---",
    "",
    `# ${title}`,
    "",
    `_Imported from ${options.source}. Add claims to make the requirements checkable._`,
    ""
  ];
  const markdown = `${normalizeContent([...frontmatter, ...out].join(`
`))}
`;
  return {
    markdown,
    title,
    requirements,
    beads,
    prefix: prefix === undefined ? undefined : { value: prefix, detected: options.prefix === undefined },
    droppedTables,
    level
  };
}
function importAndValidate(text, options) {
  const report = importRoadmap(text, options);
  const parsed = parsePlan(options.source, report.markdown);
  return { report, issues: parsed.ok ? [] : parsed.issues };
}

// yojana-markdown/src/index.ts
class MarkdownParser {
  name = "markdown";
  parse(source, text) {
    return parsePlan(source, text);
  }
  parseChange(source, text) {
    return parseChange(source, text);
  }
  render(plan) {
    return renderPlan(plan);
  }
}
// yojana/src/changes.ts
async function openChange(options) {
  const { store, draft, actor } = options;
  const state = foldLog(await store.events());
  const problems = [];
  const refuse = (requirement, code, message) => problems.push({ requirement, code, message });
  const existing = state.changes.get(draft.id);
  if (existing !== undefined) {
    refuse(undefined, "CHANGE_EXISTS", `change ${draft.id} was already opened (${existing.status})`);
  }
  const plan = state.plans.get(draft.planId);
  if (plan === undefined) {
    refuse(undefined, "PLAN_NOT_FOUND", `the log has no plan ${draft.planId}; ingest it first`);
  }
  const heads = planHeads(state, draft.planId);
  const deltas = [];
  for (const delta of draft.deltas) {
    if (delta.op === "add") {
      const { id } = delta.requirement;
      if (heads.has(id))
        refuse(id, "ALREADY_EXISTS", `${id} already exists; use MODIFIED`);
      else
        deltas.push({ op: "add", requirement: delta.requirement });
      continue;
    }
    const id = delta.op === "remove" ? delta.id : delta.requirement.id;
    const base = heads.get(id);
    if (base === undefined) {
      refuse(id, "NOT_FOUND", `${id} is not in ${draft.planId}; use ADDED`);
    } else if (delta.op === "remove") {
      deltas.push({ op: "remove", id, base });
    } else if (delta.requirement.revision === base) {
      refuse(id, "UNCHANGED", `${id} is marked MODIFIED but reads the same as the plan`);
    } else {
      deltas.push({ op: "modify", requirement: delta.requirement, base });
    }
  }
  if (problems.length > 0)
    return { outcome: "refused", change: undefined, problems };
  const change = {
    id: draft.id,
    planId: draft.planId,
    title: draft.title,
    deltas,
    source: draft.source
  };
  await store.append({ type: "change-opened", change }, actor);
  return { outcome: "opened", change, problems };
}
function applyChange(plan, deltas) {
  let requirements = [...plan.requirements];
  let parts = [...plan.parts];
  for (const delta of deltas) {
    if (delta.op === "remove") {
      requirements = requirements.filter((r) => r.id !== delta.id);
      parts = parts.filter((p) => p.kind !== "requirement" || p.id !== delta.id);
    } else if (delta.op === "modify") {
      requirements = requirements.map((r) => r.id === delta.requirement.id ? delta.requirement : r);
    } else {
      requirements.push(delta.requirement);
      const lastRequirement = parts.findLastIndex((p) => p.kind === "requirement");
      parts.splice(lastRequirement + 1, 0, { kind: "requirement", id: delta.requirement.id });
    }
  }
  return { ...plan, requirements, parts };
}
async function archiveChange(options) {
  const { store, bases, parser, changeId, actor } = options;
  const state = foldLog(await store.events());
  const entry = state.changes.get(changeId);
  const refused = (code, message) => ({
    outcome: "refused",
    change: entry?.change,
    problems: [{ requirement: undefined, code, message }],
    conflicts: [],
    planFile: undefined
  });
  if (entry === undefined)
    return refused("CHANGE_NOT_FOUND", `no change ${changeId} in the log`);
  if (entry.status !== "open") {
    return refused("CHANGE_NOT_OPEN", `change ${changeId} is already ${entry.status}`);
  }
  const { change } = entry;
  const heads = planHeads(state, change.planId);
  const conflicts = findBaseConflicts(heads, change.deltas);
  if (conflicts.length > 0) {
    return { outcome: "refused", change, problems: [], conflicts, planFile: undefined };
  }
  let found;
  for (const file of options.planFiles) {
    const parsed = parser.parse(file.source, file.text);
    if (parsed.ok && parsed.plan.id === change.planId) {
      found = { source: file.source, plan: parsed.plan };
      break;
    }
  }
  const logStatus = state.plans.get(change.planId)?.status;
  const inStep = found?.plan !== undefined && found.plan.status === logStatus && found.plan.requirements.length === heads.size && found.plan.requirements.every((r) => heads.get(r.id) === r.revision);
  await store.append({ type: "change-archived", changeId }, actor);
  let planFile;
  if (found?.plan === undefined) {
    planFile = { updated: false, source: undefined, reason: "not-found" };
  } else if (!inStep) {
    planFile = { updated: false, source: found.source, reason: "out-of-step" };
  } else {
    const next = applyChange(found.plan, change.deltas);
    options.writePlan(found.source, parser.render(next));
    await bases.set({
      planId: next.id,
      status: next.status,
      revisions: Object.fromEntries(next.requirements.map((r) => [r.id, r.revision]))
    });
    planFile = { updated: true, source: found.source };
  }
  return { outcome: "archived", change, problems: [], conflicts: [], planFile };
}
async function abandonChange(options) {
  const { store, changeId, actor } = options;
  const reason = options.reason.trim();
  const entry = foldLog(await store.events()).changes.get(changeId);
  const refused = (code, message) => ({
    outcome: "refused",
    change: entry?.change,
    problems: [{ requirement: undefined, code, message }]
  });
  if (reason === "")
    return refused("REASON_REQUIRED", "say why the change is abandoned");
  if (entry === undefined)
    return refused("CHANGE_NOT_FOUND", `no change ${changeId} in the log`);
  if (entry.status !== "open") {
    return refused("CHANGE_NOT_OPEN", `change ${changeId} is already ${entry.status}`);
  }
  await store.append({ type: "change-abandoned", changeId, reason }, actor);
  return { outcome: "abandoned", change: entry.change, problems: [] };
}
// yojana/src/check.ts
async function check(options) {
  const state = foldLog(await options.store.events());
  const byKind = new Map;
  for (const verifier of options.verifiers) {
    for (const kind of verifier.kinds)
      byKind.set(kind, verifier);
  }
  const known = [...byKind.keys()].sort().join(", ");
  const plans = [];
  for (const plan of state.plans.values()) {
    if (options.planId !== undefined && plan.id !== options.planId)
      continue;
    const results = [];
    for (const requirement of plan.heads.values()) {
      for (const claim of requirement.claims) {
        const verifier = byKind.get(claim.kind);
        results.push(verifier === undefined ? {
          requirement: requirement.id,
          claim,
          outcome: "unverifiable",
          evidence: `no verifier for kind "${claim.kind}"; known kinds: ${known}`
        } : await verifier.verify(requirement.id, claim));
      }
    }
    plans.push({ planId: plan.id, results });
  }
  const count = (outcome) => plans.reduce((n, p) => n + p.results.filter((r) => r.outcome === outcome).length, 0);
  return {
    plans,
    holds: count("holds"),
    violated: count("violated"),
    unverifiable: count("unverifiable")
  };
}
// yojana/src/comment.ts
import { randomUUID } from "crypto";
var COMMENT_ID_CHARS = 8;
async function comment(options) {
  const fail = (code, message) => ({ ok: false, code, message });
  const body = options.body.trim();
  if (body === "")
    return fail("EMPTY_COMMENT", "a comment needs some text");
  const plan = foldLog(await options.store.events()).plans.get(options.planId);
  if (plan === undefined)
    return fail("PLAN_NOT_FOUND", `the log has no plan ${options.planId}`);
  const head = plan.heads.get(options.requirement);
  if (head === undefined) {
    return fail("NOT_FOUND", `${options.requirement} is not a requirement of ${options.planId}`);
  }
  const quote = options.quote?.trim();
  if (quote !== undefined && quote !== "" && !quoteAppears(head.text, quote)) {
    return fail("QUOTE_NOT_FOUND", `"${quote}" does not appear in ${options.requirement}`);
  }
  if (options.replyTo !== undefined && !plan.annotations.some((a) => a.id === options.replyTo)) {
    return fail("COMMENT_NOT_FOUND", `no comment ${options.replyTo} on ${options.planId}`);
  }
  const annotation = {
    id: `n_${randomUUID().replaceAll("-", "").slice(0, COMMENT_ID_CHARS)}`,
    requirement: head.id,
    revision: head.revision,
    author: options.author,
    body,
    quote: quote === "" ? undefined : quote,
    replyTo: options.replyTo
  };
  await options.store.append({ type: "annotation-added", planId: options.planId, annotation }, options.author);
  return { ok: true, annotation };
}
async function removeComment(options) {
  const fail = (code, message) => ({
    ok: false,
    code,
    message
  });
  const plan = foldLog(await options.store.events()).plans.get(options.planId);
  if (plan === undefined)
    return fail("PLAN_NOT_FOUND", `the log has no plan ${options.planId}`);
  const annotation = plan.annotations.find((a) => a.id === options.id);
  if (annotation === undefined || isAnnotationRemoved(plan, options.id)) {
    return fail("COMMENT_NOT_FOUND", `no comment ${options.id} on ${options.planId}`);
  }
  if (annotation.author !== options.actor) {
    return fail("NOT_YOURS", `${options.id} is ${annotation.author}'s; only its author removes it`);
  }
  await options.store.append({ type: "annotation-removed", planId: options.planId, annotationId: options.id }, options.actor);
  return { ok: true, annotation };
}
function asRead(text) {
  return text.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
}
function quoteAppears(text, quote) {
  return quotePosition(text, quote) !== undefined;
}
function quotePosition(text, quote) {
  const written = text.indexOf(quote);
  if (written >= 0)
    return written;
  const read = asRead(text).indexOf(asRead(quote));
  return read >= 0 ? read : undefined;
}
// yojana/src/decisions.ts
function isDecision(value) {
  return WORK_DECISIONS.includes(value);
}
async function recordDecision(request) {
  const refuse = (code, message) => ({ ok: false, code, message });
  const state = foldLog(await request.store.events());
  const plan = state.plans.get(request.planId);
  if (plan === undefined)
    return refuse("PLAN_NOT_FOUND", `the log has no plan ${request.planId}`);
  const requirement = plan.heads.get(request.requirement);
  if (requirement === undefined) {
    return refuse("NOT_FOUND", `${request.requirement} is not a requirement of ${request.planId}`);
  }
  if (!isDecision(request.decision)) {
    return refuse("INVALID", `a decision is one of ${WORK_DECISIONS.join(", ")}`);
  }
  const linked = requirement.workItems ?? [];
  if (!linked.includes(request.item)) {
    return refuse("NOT_LINKED", `${request.item} is not linked to ${requirement.id}${linked.length > 0 ? ` (it links ${linked.join(", ")})` : ""}`);
  }
  const reason = request.reason.trim();
  const waiting = [...state.decisions.values()].find((d) => d.planId === request.planId && d.item === request.item && d.decision === request.decision && d.status !== "applied");
  if (waiting !== undefined) {
    if (waiting.status === "recorded" && request.finalize) {
      await request.store.append({ type: "decision-finalized", decisionId: waiting.id }, request.actor);
      return { ok: true, decision: decisionById(await request.store.events(), waiting.id) };
    }
    return { ok: true, decision: waiting };
  }
  if (reason === "")
    return refuse("REASON_REQUIRED", "say why");
  const recorded = await request.store.append({
    type: "decision-recorded",
    planId: request.planId,
    requirement: requirement.id,
    item: request.item,
    decision: request.decision,
    reason
  }, request.actor);
  if (request.finalize) {
    await request.store.append({ type: "decision-finalized", decisionId: recorded.eventId }, request.actor);
  }
  return { ok: true, decision: decisionById(await request.store.events(), recorded.eventId) };
}
function decisionById(events, id) {
  const decision = foldLog(events).decisions.get(id);
  if (decision === undefined) {
    throw new YojanaError("LOG_INCONSISTENT", `decision ${id} is missing from the log it was written to`);
  }
  return decision;
}
async function finalizeDecision(options) {
  const decision = foldLog(await options.store.events()).decisions.get(options.decisionId);
  if (decision === undefined) {
    return { ok: false, code: "NOT_FOUND", message: `no decision ${options.decisionId}` };
  }
  if (decision.status !== "recorded") {
    return {
      ok: false,
      code: "NOT_PROPOSED",
      message: `decision ${options.decisionId} is already ${decision.status}`
    };
  }
  await options.store.append({ type: "decision-finalized", decisionId: options.decisionId }, options.actor);
  return { ok: true, decision: decisionById(await options.store.events(), options.decisionId) };
}
function alreadyDone(decision, state) {
  if (decision === "close")
    return state === "closed";
  return state !== "closed" && state !== "missing" && state !== "unknown";
}
async function applyDecisions(options) {
  const state = foldLog(await options.store.events());
  const due = [...state.decisions.values()].filter((d) => (d.status === "finalized" || d.status === "failed") && (options.ids === undefined || options.ids.includes(d.id)));
  const out = [];
  for (const d of due) {
    const done = (note) => ({
      id: d.id,
      item: d.item,
      decision: d.decision,
      outcome: "applied",
      note
    });
    const failed = (note) => ({ ...done(note), outcome: "failed" });
    let result;
    const lookup = await options.worklink.get([d.item]);
    const item = lookup.ok ? lookup.items[0] : undefined;
    if (!lookup.ok) {
      result = failed(lookup.error);
    } else if (item === undefined || item.state === "missing") {
      result = failed(`${options.worklink.name} has no item ${d.item}`);
    } else if (alreadyDone(d.decision, item.state)) {
      result = done(`${d.item} was already ${item.state}`);
    } else {
      const act = d.decision === "close" ? options.worklink.close : options.worklink.reopen;
      if (act === undefined) {
        result = failed(`${options.worklink.name} cannot ${d.decision} items from yojana`);
      } else {
        const changed = await act.call(options.worklink, d.item, d.reason);
        result = changed.ok ? done(`${d.decision === "close" ? "closed" : "reopened"} ${d.item}`) : failed(changed.error);
      }
    }
    await options.store.append(result.outcome === "applied" ? { type: "decision-applied", decisionId: d.id, note: result.note } : { type: "decision-failed", decisionId: d.id, error: result.note }, options.actor);
    out.push(result);
  }
  return out;
}
// yojana/src/edit.ts
import { randomUUID as randomUUID2 } from "crypto";

// yojana/src/ingest.ts
function movement(file, base, log) {
  if (file === log)
    return "same";
  if (base === log)
    return "edited";
  if (file === base)
    return "behind";
  return "conflict";
}
async function ingest(options) {
  const { store, parser, bases, actor } = options;
  const reports = [];
  const seenPlans = new Map;
  let appended = 0;
  for (const file of options.files) {
    const parsed = parser.parse(file.source, file.text);
    if (!parsed.ok) {
      reports.push(invalid(file.source, undefined, parsed.issues));
      continue;
    }
    const { plan } = parsed;
    const earlier = seenPlans.get(plan.id);
    if (earlier !== undefined) {
      reports.push(invalid(file.source, plan.id, [
        {
          source: file.source,
          line: undefined,
          code: "DUPLICATE_PLAN",
          message: `plan ${plan.id} is already defined in ${earlier}`
        }
      ]));
      continue;
    }
    seenPlans.set(plan.id, file.source);
    const state = foldLog(await store.events());
    const logPlan = state.plans.get(plan.id);
    const savedBase = await bases.get(plan.id);
    const missingBase = savedBase === undefined && logPlan !== undefined;
    const fileRevs = new Map(plan.requirements.map((r) => [r.id, r.revision]));
    const logRevs = new Map([...logPlan?.heads ?? []].map(([id, r]) => [id, r.revision]));
    const baseRevs = new Map(missingBase && options.trustFile === true ? logRevs : Object.entries(savedBase?.revisions ?? {}));
    const logStatus = logPlan?.status;
    const baseStatus = missingBase && options.trustFile === true ? logStatus : savedBase?.status;
    const contested = logPlan?.contested ?? new Map;
    const ids = [...new Set([...fileRevs.keys(), ...logRevs.keys(), ...baseRevs.keys()])];
    const outcomes = [];
    const nextBase = {};
    for (const id of ids) {
      const f = fileRevs.get(id);
      const b = baseRevs.get(id);
      const l = logRevs.get(id);
      const moved = contested.has(id) ? "resolved" : movement(f, b, l);
      const kept = moved === "behind" ? b : f;
      if (kept !== undefined && moved !== "conflict")
        nextBase[id] = kept;
      if (moved === "same")
        continue;
      const action = moved !== "edited" && moved !== "resolved" ? undefined : f === undefined ? "removed" : l === undefined ? "added" : "modified";
      outcomes.push({ id, movement: moved, action, file: f, base: b, log: l });
    }
    const statusMove = movement(plan.status, baseStatus, logStatus);
    const proposing = options.agent === true && statusMove === "edited" && !(logStatus === undefined && plan.status === "draft");
    const status = statusMove === "same" ? undefined : {
      movement: statusMove,
      file: plan.status,
      base: baseStatus,
      log: logStatus,
      ...proposing ? { proposed: true } : {}
    };
    const refused = statusMove === "conflict" || outcomes.some((o) => o.movement === "conflict");
    if (refused) {
      reports.push({
        source: file.source,
        planId: plan.id,
        outcome: "refused",
        issues: [],
        requirements: outcomes,
        status,
        missingBase,
        workItemsChanged: false,
        appended: 0
      });
      continue;
    }
    const events = [];
    if (proposing) {
      if (logStatus === undefined) {
        events.push({
          type: "status-changed",
          planId: plan.id,
          to: "draft",
          reason: `created from ${file.source}`
        });
      }
      const waiting = [...state.proposals.values()].some((p) => p.planId === plan.id && p.to === plan.status && p.status === "proposed");
      if (!waiting) {
        events.push({
          type: "status-proposed",
          planId: plan.id,
          to: plan.status,
          reason: `${logStatus === undefined ? "set" : "edited"} in ${file.source}`
        });
      }
    } else if (status?.movement === "edited") {
      const proposal = [...state.proposals.values()].find((p) => p.planId === plan.id && p.to === plan.status && p.status === "proposed");
      events.push({
        type: "status-changed",
        planId: plan.id,
        to: plan.status,
        reason: logStatus === undefined ? `created from ${file.source}` : `edited in ${file.source}`,
        ...proposal === undefined ? {} : { proposal: proposal.id }
      });
    }
    const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    const workChanged = !sameSet(plan.workItems, logPlan?.workItems ?? []);
    if (workChanged) {
      events.push({ type: "work-linked", planId: plan.id, workItems: plan.workItems });
    }
    const byId = new Map(plan.requirements.map((r) => [r.id, r]));
    for (const o of outcomes) {
      if (o.movement !== "edited" && o.movement !== "resolved")
        continue;
      const requirement = byId.get(o.id);
      if (o.action === "removed" && o.log !== undefined) {
        events.push({ type: "requirement-removed", planId: plan.id, id: o.id, base: o.log });
      } else if (requirement !== undefined) {
        events.push({ type: "revision-recorded", planId: plan.id, requirement, base: o.log });
      }
    }
    if (options.dryRun !== true) {
      for (const event of events)
        await store.append(event, actor);
      appended += events.length;
      await bases.set({
        planId: plan.id,
        status: proposing ? logStatus ?? "draft" : status?.movement === "behind" ? baseStatus : plan.status,
        revisions: nextBase
      });
    }
    reports.push({
      source: file.source,
      planId: plan.id,
      outcome: events.length > 0 ? "recorded" : "unchanged",
      issues: [],
      requirements: outcomes,
      status,
      missingBase,
      workItemsChanged: workChanged,
      appended: options.dryRun === true ? 0 : events.length
    });
  }
  return { files: reports, appended };
}
function invalid(source, planId, issues) {
  return {
    source,
    planId,
    outcome: "invalid",
    issues,
    requirements: [],
    status: undefined,
    missingBase: false,
    workItemsChanged: false,
    appended: 0
  };
}

// yojana/src/edit.ts
async function current(request) {
  const plan = foldLog(await request.store.events()).plans.get(request.planId);
  if (plan === undefined) {
    return { ok: false, code: "PLAN_NOT_FOUND", message: `the log has no plan ${request.planId}` };
  }
  const head = plan.heads.get(request.requirementId);
  if (head === undefined) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: `${request.requirementId} is not a requirement of ${request.planId}`
    };
  }
  if (head.revision !== request.expectedRevision) {
    return {
      ok: false,
      code: "STALE",
      message: `${request.requirementId} changed since this page was loaded; nothing was saved`,
      current: head
    };
  }
  return head;
}
function rewritten(head, title, text) {
  const fields = {
    id: head.id,
    title: title.trim(),
    text: normalizeContent(text),
    claims: head.claims,
    ...head.workItems === undefined ? {} : { workItems: head.workItems }
  };
  return { ...fields, revision: requirementRevision(fields) };
}
async function editRequirement(request) {
  const head = await current(request);
  if ("ok" in head)
    return head;
  const next = rewritten(head, request.title, request.text);
  if (next.revision === head.revision) {
    return { ok: false, code: "UNCHANGED", message: "the requirement already reads like this" };
  }
  if (next.title === "") {
    return { ok: false, code: "INVALID_TEXT", message: "a requirement needs a title" };
  }
  const { parser, store, bases } = request;
  const dry = await ingest({
    store,
    parser,
    bases,
    files: request.files,
    actor: request.actor,
    dryRun: true
  });
  const report = dry.files.find((f) => f.planId === request.planId);
  const file = request.files.find((f) => f.source === report?.source);
  if (report === undefined || file === undefined || report.outcome === "invalid") {
    return {
      ok: false,
      code: "NO_PLAN_FILE",
      message: `no readable plan file for ${request.planId}; use suggest instead`
    };
  }
  const pending = report.requirements.map((r) => `${r.id} (${r.movement})`);
  if (pending.length > 0 || report.status !== undefined || report.workItemsChanged) {
    return {
      ok: false,
      code: "FILE_NOT_IN_STEP",
      message: `${report.source} is not in step with the log${pending.length > 0 ? `: ${pending.join(", ")}` : ""}; run yojana ingest or refresh first, or suggest instead`
    };
  }
  const parsed = parser.parse(file.source, file.text);
  if (!parsed.ok)
    return { ok: false, code: "NO_PLAN_FILE", message: `${file.source} does not parse` };
  const text = parser.render(applyChange(parsed.plan, [{ op: "modify", requirement: next, base: head.revision }]));
  const check = parser.parse(file.source, text);
  const kept = check.ok && check.plan.requirements.length === parsed.plan.requirements.length && check.plan.requirements.some((r) => r.id === next.id && r.revision === next.revision);
  if (!kept) {
    return {
      ok: false,
      code: "INVALID_TEXT",
      message: "the new text would change the plan structure (a ## heading or a claim block?); nothing was saved"
    };
  }
  request.writePlan(file.source, text);
  await ingest({
    store,
    parser,
    bases,
    files: request.files.map((f) => f.source === file.source ? { ...f, text } : f),
    actor: request.actor
  });
  return { ok: true, revision: next.revision };
}
var SUGGESTION_ID_CHARS = 6;
var SUGGESTION_REQ_CHARS = 40;
async function suggestEdit(request) {
  const head = await current(request);
  if ("ok" in head)
    return head;
  const next = rewritten(head, request.title, request.text);
  if (next.revision === head.revision) {
    return { ok: false, code: "UNCHANGED", message: "the requirement already reads like this" };
  }
  const suffix = randomUUID2().replaceAll("-", "").slice(0, SUGGESTION_ID_CHARS);
  const changeId = `suggest-${head.id.replace(/^req-/, "").slice(0, SUGGESTION_REQ_CHARS)}-${suffix}`;
  const source = `${request.changesDir}/${changeId}.md`;
  const draft = {
    id: changeId,
    planId: request.planId,
    title: `Suggested edit to ${head.id}`,
    deltas: [{ op: "modify", requirement: next }],
    source
  };
  const text = renderChange(draft, request.why);
  const check = request.parser.parseChange(source, text);
  const delta = check.ok ? check.change.deltas[0] : undefined;
  if (!check.ok || check.change.deltas.length !== 1 || delta?.op !== "modify" || delta.requirement.revision !== next.revision) {
    return {
      ok: false,
      code: "INVALID_TEXT",
      message: "the new text would change the plan structure (a ## heading or a claim block?); nothing was saved"
    };
  }
  request.writeChange(source, text);
  const opened = await openChange({
    store: request.store,
    draft: check.change,
    actor: request.actor
  });
  if (opened.outcome !== "opened") {
    return {
      ok: false,
      code: "INVALID_TEXT",
      message: opened.problems.map((p) => p.message).join("; ")
    };
  }
  return { ok: true, changeId, source };
}
// yojana/src/refresh.ts
async function refresh(options) {
  const { store, parser, bases } = options;
  const state = foldLog(await store.events());
  const dry = await ingest({
    store,
    parser,
    bases,
    files: options.files,
    actor: "refresh",
    dryRun: true
  });
  const textOf = new Map(options.files.map((f) => [f.source, f.text]));
  const refreshed = [];
  for (const report of dry.files) {
    const behind = report.requirements.filter((r) => r.movement === "behind");
    const statusBehind = report.status?.movement === "behind";
    if (report.planId === undefined || behind.length === 0 && !statusBehind)
      continue;
    const parsed = parser.parse(report.source, textOf.get(report.source) ?? "");
    const logPlan = state.plans.get(report.planId);
    if (!parsed.ok || logPlan === undefined)
      continue;
    const deltas = [];
    const updated = [];
    const added = [];
    const removed = [];
    for (const r of behind) {
      const head = logPlan.heads.get(r.id);
      if (head === undefined) {
        deltas.push({ op: "remove", id: r.id, base: r.file ?? "" });
        removed.push(r.id);
      } else if (r.file === undefined) {
        deltas.push({ op: "add", requirement: head });
        added.push(r.id);
      } else {
        deltas.push({ op: "modify", requirement: head, base: r.file });
        updated.push(r.id);
      }
    }
    const next = applyChange(statusBehind ? { ...parsed.plan, status: logPlan.status } : parsed.plan, deltas);
    options.writePlan(report.source, parser.render(next));
    const saved = await bases.get(report.planId);
    const revisions = { ...saved?.revisions ?? {} };
    for (const id of removed)
      delete revisions[id];
    for (const id of [...updated, ...added]) {
      const head = logPlan.heads.get(id);
      if (head !== undefined)
        revisions[id] = head.revision;
    }
    await bases.set({
      planId: report.planId,
      status: statusBehind ? logPlan.status : saved?.status,
      revisions
    });
    refreshed.push({
      source: report.source,
      planId: report.planId,
      updated,
      added,
      removed,
      status: statusBehind ? { from: parsed.plan.status, to: logPlan.status } : undefined
    });
  }
  return { files: refreshed };
}

// yojana/src/plan-status.ts
var refuse = (code, message) => ({ ok: false, code, message });
var PERSON_ONLY = "only a person decides this; the person does it on the review page, or runs yojana themselves";
function isStatus(value) {
  return PLAN_STATUSES.includes(value);
}
async function proposeStatus(request) {
  if (request.finalize && request.agent)
    return refuse("PERSON_ONLY", PERSON_ONLY);
  const state = foldLog(await request.store.events());
  const plan = state.plans.get(request.planId);
  if (plan === undefined)
    return refuse("PLAN_NOT_FOUND", `the log has no plan ${request.planId}`);
  if (!isStatus(request.to)) {
    return refuse("INVALID", `a plan status is one of ${PLAN_STATUSES.join(", ")}`);
  }
  if (plan.status === request.to) {
    return refuse("ALREADY", `${request.planId} is already ${request.to}`);
  }
  const reason = request.reason.trim();
  const waiting = [...state.proposals.values()].find((p) => p.planId === plan.id && p.to === request.to && p.status === "proposed");
  if (waiting !== undefined) {
    if (!request.finalize)
      return { ok: true, proposal: waiting, moved: false };
    return finalizeStatus({ ...request, proposalId: waiting.id });
  }
  if (reason === "")
    return refuse("REASON_REQUIRED", "say why");
  const proposed = await request.store.append({ type: "status-proposed", planId: plan.id, to: request.to, reason }, request.actor);
  if (!request.finalize) {
    return {
      ok: true,
      proposal: proposalById(await request.store.events(), proposed.eventId),
      moved: false
    };
  }
  return finalizeStatus({ ...request, proposalId: proposed.eventId });
}
async function finalizeStatus(request) {
  if (request.agent)
    return refuse("PERSON_ONLY", PERSON_ONLY);
  const proposal = foldLog(await request.store.events()).proposals.get(request.proposalId);
  if (proposal === undefined)
    return refuse("NOT_FOUND", `no status proposal ${request.proposalId}`);
  if (proposal.status !== "proposed") {
    return refuse("NOT_PROPOSED", `status proposal ${request.proposalId} is already ${proposal.status}`);
  }
  const reason = request.reason?.trim() || proposal.reason;
  await request.store.append({
    type: "status-changed",
    planId: proposal.planId,
    to: proposal.to,
    reason,
    proposal: proposal.id
  }, request.actor);
  return {
    ok: true,
    proposal: proposalById(await request.store.events(), proposal.id),
    moved: true
  };
}
async function declineStatus(request) {
  if (request.agent)
    return refuse("PERSON_ONLY", PERSON_ONLY);
  const proposal = foldLog(await request.store.events()).proposals.get(request.proposalId);
  if (proposal === undefined)
    return refuse("NOT_FOUND", `no status proposal ${request.proposalId}`);
  if (proposal.status !== "proposed") {
    return refuse("NOT_PROPOSED", `status proposal ${request.proposalId} is already ${proposal.status}`);
  }
  const reason = request.reason.trim();
  if (reason === "")
    return refuse("REASON_REQUIRED", "say why not yet");
  await request.store.append({ type: "status-declined", proposalId: proposal.id, reason }, request.actor);
  return {
    ok: true,
    proposal: proposalById(await request.store.events(), proposal.id),
    moved: false
  };
}
function proposalById(events, id) {
  const proposal = foldLog(events).proposals.get(id);
  if (proposal === undefined) {
    throw new YojanaError("LOG_INCONSISTENT", `status proposal ${id} is missing from the log it was written to`);
  }
  return proposal;
}
async function settleStatusLine(options) {
  const { proposal } = options;
  if (proposal.status === "declined") {
    const file = options.files.map((f) => options.parser.parse(f.source, f.text)).find((p) => p.ok && p.plan.id === proposal.planId);
    const base = await options.bases.get(proposal.planId);
    if (file?.ok && file.plan.status === proposal.to && base !== undefined) {
      await options.bases.set({ ...base, status: proposal.to });
    }
  }
  await refresh({
    store: options.store,
    parser: options.parser,
    bases: options.bases,
    files: options.files,
    writePlan: options.writePlan
  });
}
async function approveRequirement(request) {
  if (request.agent)
    return refuse("PERSON_ONLY", PERSON_ONLY);
  const plan = foldLog(await request.store.events()).plans.get(request.planId);
  if (plan === undefined)
    return refuse("PLAN_NOT_FOUND", `the log has no plan ${request.planId}`);
  const head = plan.heads.get(request.requirement);
  if (head === undefined) {
    return refuse("NOT_FOUND", `${request.requirement} is not a requirement of ${request.planId}`);
  }
  if (request.revision !== undefined && request.revision !== "" && request.revision !== head.revision) {
    return refuse("STALE", `${request.requirement} changed since it was read; read it again before approving`);
  }
  const verdict = plan.approvals.get(head.id);
  if (verdict?.verdict === "approved" && verdict.revision === head.revision) {
    return { ok: true, revision: head.revision, already: true };
  }
  await request.store.append({
    type: "requirement-approved",
    planId: plan.id,
    requirement: head.id,
    revision: head.revision
  }, request.actor);
  return { ok: true, revision: head.revision, already: false };
}
async function declineRequirement(request) {
  if (request.agent)
    return refuse("PERSON_ONLY", PERSON_ONLY);
  const reason = request.reason.trim();
  if (reason === "") {
    return refuse("REASON_REQUIRED", "say why it is declined, so it can be changed to fit");
  }
  const plan = foldLog(await request.store.events()).plans.get(request.planId);
  if (plan === undefined)
    return refuse("PLAN_NOT_FOUND", `the log has no plan ${request.planId}`);
  const head = plan.heads.get(request.requirement);
  if (head === undefined) {
    return refuse("NOT_FOUND", `${request.requirement} is not a requirement of ${request.planId}`);
  }
  if (request.revision !== undefined && request.revision !== "" && request.revision !== head.revision) {
    return refuse("STALE", `${request.requirement} changed since it was read; read it again before declining`);
  }
  const verdict = plan.approvals.get(head.id);
  if (verdict?.verdict === "declined" && verdict.revision === head.revision && verdict.reason === reason) {
    return { ok: true, revision: head.revision, already: true };
  }
  await request.store.append({
    type: "requirement-declined",
    planId: plan.id,
    requirement: head.id,
    revision: head.revision,
    reason
  }, request.actor);
  return { ok: true, revision: head.revision, already: false };
}
// yojana/src/progress.ts
async function progress(options) {
  const state = foldLog(await options.store.events());
  const result = [];
  for (const plan of state.plans.values()) {
    if (options.planId !== undefined && plan.id !== options.planId)
      continue;
    const failed = (error) => ({
      planId: plan.id,
      items: [],
      done: 0,
      total: 0,
      error
    });
    const lookup = await options.worklink.get(plan.workItems);
    if (!lookup.ok) {
      result.push(failed(lookup.error));
      continue;
    }
    const lookups = await Promise.all(lookup.items.map(async (item) => item.state === "missing" ? { item, children: { ok: true, items: [] } } : { item, children: await options.worklink.children(item.id) }));
    const failure = lookups.find((l) => !l.children.ok);
    if (failure !== undefined && !failure.children.ok) {
      result.push(failed(failure.children.error));
      continue;
    }
    const items = lookups.map(({ item, children }) => ({
      item,
      children: children.ok ? children.items : []
    }));
    const counted = items.flatMap((p) => p.children.length > 0 ? p.children : [p.item]);
    result.push({
      planId: plan.id,
      items,
      done: counted.filter((w) => w.state === "closed").length,
      total: counted.length,
      error: undefined
    });
  }
  return result;
}
// yojana/src/project.ts
var ACTIVITY_LIMIT = 12;
var AGENT_ACTORS = ["claude", "opencode"];
var NEXT_STATUS = {
  draft: "accepted",
  accepted: "in-progress",
  "in-progress": "realized"
};
var PROPOSAL_CALLOUT = "proposal:";
var NEXT_CALLOUT = "next";
var DECLINE_ACTION = "decline-section";
var MINUTE_MS = 60000;
var MINUTES_PER_HOUR = 60;
var MINUTES_PER_DAY = 1440;
var STATUS_INTENT = {
  draft: "neutral",
  accepted: "primary",
  "in-progress": "primary",
  realized: "success",
  superseded: "neutral",
  abandoned: "neutral"
};
var OUTCOME_INTENT = {
  holds: "success",
  violated: "danger",
  unverifiable: "warning"
};
function ago(at, now) {
  const minutes = Math.round((now - at) / MINUTE_MS);
  if (minutes < 1)
    return "just now";
  if (minutes < MINUTES_PER_HOUR)
    return `${minutes}m`;
  if (minutes < MINUTES_PER_DAY)
    return `${Math.round(minutes / MINUTES_PER_HOUR)}h`;
  return `${Math.round(minutes / MINUTES_PER_DAY)}d`;
}
function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
function healthOf(results) {
  if (results.some((r) => r.outcome === "violated"))
    return "danger";
  if (results.length > 0 && results.every((r) => r.outcome === "holds"))
    return "success";
  return results.length > 0 ? "warning" : "neutral";
}
function deltaTarget(delta) {
  return delta.op === "remove" ? delta.id : delta.requirement.id;
}
function numberMarks(state, plan) {
  const numbers = new Map;
  let next = 0;
  for (const requirement of plan.heads.values()) {
    const quoted = plan.annotations.filter((a) => a.requirement === requirement.id && a.replyTo === undefined && !isAnnotationRemoved(plan, a.id) && a.quote !== undefined && a.quote !== "" && !isAnnotationOutdated(state, plan.id, a)).flatMap((a) => {
      const at = quotePosition(requirement.text, a.quote ?? "");
      return at === undefined ? [] : [{ a, at }];
    }).sort((x, y) => x.at - y.at);
    for (const { a } of quoted) {
      next += 1;
      numbers.set(a.id, String(next));
    }
  }
  return numbers;
}
function projectReview(options) {
  const state = foldLog(options.events);
  const plan = state.plans.get(options.planId);
  if (plan === undefined)
    return;
  const { now, report, checks } = options;
  const agents = options.agents ?? AGENT_ACTORS;
  const isAgent = (actor) => agents.includes(actor);
  const when = (at) => at === undefined ? "" : ago(at, now);
  const atOf = new Map;
  const openedBy = new Map;
  for (const event of options.events) {
    if (event.type === "annotation-added")
      atOf.set(event.annotation.id, event.at);
    if (event.type === "change-opened")
      openedBy.set(event.change.id, event.actor);
  }
  const openChanges = [...state.changes.values()].filter((c) => c.status === "open" && c.change.planId === plan.id).sort((a, b) => a.openedSeq - b.openedSeq);
  const heads = planHeads(state, plan.id);
  const marks = numberMarks(state, plan);
  const sections = [...plan.heads.values()].map((r) => projectSection({ state, plan, requirement: r, report, checks, openChanges, marks }));
  const threads = projectThreads(plan, state, marks, atOf, isAgent, when, options.you);
  const changes = openChanges.map((c) => {
    const applies = findBaseConflicts(heads, c.change.deltas).length === 0;
    const author = openedBy.get(c.change.id);
    return {
      id: c.change.id,
      title: c.change.title,
      ...author === undefined ? {} : { author },
      when: when(c.openedAt),
      status: applies ? { label: "applies cleanly", intent: "success" } : { label: "no longer applies", intent: "danger" },
      applies,
      diffs: c.change.deltas.map((d) => {
        const id = deltaTarget(d);
        const title = d.op === "remove" ? plan.heads.get(id)?.title ?? id : d.requirement.title;
        return {
          section: id,
          label: `${d.op} \xB7 ${title}`,
          diff: {
            kind: "diff",
            before: plan.heads.get(id)?.text ?? "",
            after: d.op === "remove" ? "" : d.requirement.text
          }
        };
      })
    };
  });
  const count = (tag) => sections.filter((s) => s.tags.includes(tag)).length;
  const attention = count("attention");
  const filters = [
    {
      id: "attention",
      label: "Needs attention",
      count: attention,
      ...attention > 0 ? { active: true } : {}
    },
    { id: "close", label: "Close?", count: count("close") },
    { id: "violated", label: "Violated", count: count("violated") },
    { id: "unapproved", label: "Not approved", count: count("unapproved") }
  ];
  const tally = (o) => checks.filter((c) => c.outcome === o).length;
  const progress = report?.progress;
  const file = report?.file;
  const pending = file?.kind === "file" ? file.unrecorded.length + file.behind.length + file.conflicts.length : undefined;
  const metrics = [
    ...progress !== undefined && progress.error === undefined && progress.total > 0 ? [
      {
        label: `${progress.done}/${progress.total} work items`,
        meter: { value: progress.done, max: progress.total }
      }
    ] : [],
    ...checks.length === 0 ? [{ label: "claims not checked", intent: "neutral" }] : [
      { label: `${tally("holds")} hold`, intent: "success" },
      ...tally("violated") > 0 ? [{ label: `${tally("violated")} violated`, intent: "danger" }] : [],
      ...tally("unverifiable") > 0 ? [{ label: `${tally("unverifiable")} not checked`, intent: "warning" }] : []
    ],
    ...pending === undefined ? [] : pending === 0 ? [{ label: "file in step", intent: "success" }] : [{ label: `${plural(pending, "pending file edit")}`, intent: "warning" }],
    ...sections.length === 0 ? [] : [
      {
        label: `${sections.length - count("unapproved")}/${sections.length} approved`,
        ...count("unapproved") === 0 ? { intent: "success" } : {}
      }
    ]
  ];
  const liveThreads = threads.filter((t) => !t.outdated && t.removed !== true).length;
  const unapproved = count("unapproved");
  const declined = count("declined");
  const weigh = [
    ...declined > 0 ? [{ label: `${plural(declined, "requirement")} declined`, intent: "danger" }] : [],
    ...unapproved > 0 ? [
      {
        label: `${unapproved} of ${plural(sections.length, "requirement")} not approved, or changed since`,
        intent: "warning"
      }
    ] : [],
    ...liveThreads > 0 ? [{ label: plural(liveThreads, "open thread") }] : [],
    ...changes.length > 0 ? [{ label: plural(changes.length, "open change"), intent: "warning" }] : [],
    ...pending !== undefined && pending > 0 ? [{ label: `${plural(pending, "file edit")} not ingested`, intent: "warning" }] : []
  ];
  const callouts = projectCallouts(plan, waitingProposals(state, plan.id), weigh);
  const anomalies = openAnomalies(state).filter((a) => a.planId === undefined || a.planId === plan.id);
  const intro = options.plan?.parts.find((p) => p.kind === "prose");
  const introText = intro?.kind === "prose" ? intro.markdown.replace(/^#\s.*\n*/, "").trim() : undefined;
  const source = options.plan?.source ?? (file?.kind === "file" ? file.source : undefined);
  const crumbs = [options.repository, source].filter((s) => s !== undefined).join(" / ");
  return {
    document: {
      id: plan.id,
      title: options.plan?.title ?? plan.id,
      ...crumbs === "" ? {} : { crumbs },
      status: { label: plan.status, intent: STATUS_INTENT[plan.status] },
      metrics,
      mode: options.mode,
      ...introText === undefined || introText === "" ? {} : { intro: { kind: "markdown", source: introText } },
      ...anomalies.length > 0 ? {
        banner: {
          label: `${plural(anomalies.length, "anomaly", "anomalies")} in the log: ${anomalies[0]?.message ?? ""}`,
          intent: "warning"
        }
      } : {},
      ...source === undefined ? {} : { source },
      freshness: options.checkedAt === undefined ? "claims not checked" : `claims checked ${when(options.checkedAt)}${options.checkedAt >= now - MINUTE_MS ? "" : " ago"}`
    },
    filters,
    callouts,
    sections,
    threads,
    changes,
    activity: projectActivity(options, plan, state, isAgent, when)
  };
}
function projectSection(input) {
  const { plan, requirement: r, marks } = input;
  const results = input.checks.filter((c) => c.requirement === r.id);
  const health = healthOf(results);
  const alignment = input.report?.alignment.find((a) => a.requirement === r.id);
  const touching = input.openChanges.filter((c) => c.change.deltas.some((d) => deltaTarget(d) === r.id));
  const delta = touching[0]?.change.deltas.find((d) => deltaTarget(d) === r.id);
  const contested = plan.contested.has(r.id);
  const threads = plan.annotations.filter((a) => a.requirement === r.id && a.replyTo === undefined && !isAnnotationRemoved(plan, a.id)).length;
  const approval = approvalOf(plan, r.id);
  const approved = approval?.verdict === "approved" && !approval.stale;
  const declined = approval?.verdict === "declined" && !approval.stale;
  const tags = [];
  if (alignment?.mismatch === "claims-hold-work-open")
    tags.push("close");
  if (health === "danger")
    tags.push("violated");
  if (declined)
    tags.push("declined");
  if (tags.length > 0 || touching.length > 0 || contested)
    tags.push("attention");
  if (!approved)
    tags.push("unapproved");
  const note = [
    alignment?.mismatch === "claims-hold-work-open" ? "close?" : "",
    alignment?.mismatch === "work-closed-claims-violated" ? "reopen?" : "",
    contested ? "contested" : "",
    declined ? "declined" : "",
    touching.length > 0 ? plural(touching.length, "change") : "",
    threads > 0 ? plural(threads, "thread") : ""
  ].filter((s) => s !== "").join(" \xB7 ");
  const items = alignment?.items ?? (r.workItems ?? []).map((id) => ({ id, state: undefined }));
  const properties = [
    ...items.map((i) => ({
      label: i.state === undefined ? i.id : `${i.id} \xB7 ${i.state}`,
      ...i.state === "closed" ? { intent: "success" } : {}
    })),
    ...r.claims.length === 0 ? [] : results.length === 0 ? [{ label: plural(r.claims.length, "claim") }] : [
      {
        label: `${results.filter((x) => x.outcome === "holds").length}/${results.length} claims hold`,
        intent: health
      }
    ],
    ...approval === undefined ? [] : [verdictChip(approval)]
  ];
  const decisions = [...input.state.decisions.values()].filter((d) => d.planId === plan.id && d.requirement === r.id && d.status !== "applied");
  const decided = (item) => decisions.some((d) => d.item === item);
  const verb = (d) => d === "close" ? "Close" : "Reopen";
  const flags = [];
  for (const d of decisions) {
    const button = (label) => ({
      action: "decide",
      label,
      item: d.item,
      decision: d.decision,
      primary: true
    });
    if (d.status === "recorded") {
      flags.push({
        text: `${d.recordedBy} proposes: ${d.decision} ${d.item}. \u201C${d.reason}\u201D`,
        intent: "primary",
        buttons: [button(`${verb(d.decision)} ${d.item}`)]
      });
    } else if (d.status === "finalized") {
      flags.push({
        text: `Decided: ${d.decision} ${d.item}. Waiting to be applied to the tracker.`,
        intent: "warning"
      });
    } else {
      flags.push({
        text: `Could not ${d.decision} ${d.item}: ${d.outcome ?? "no reason given"}`,
        intent: "danger",
        buttons: [button("Try again")]
      });
    }
  }
  if (alignment?.mismatch === "claims-hold-work-open") {
    const open = alignment.items.filter((i) => i.state !== "closed" && !decided(i.id));
    if (open.length > 0) {
      flags.push({
        text: `Every claim holds but ${open.map((i) => i.id).join(", ")} ${open.length === 1 ? "is" : "are"} still open.`,
        intent: "primary",
        buttons: open.map((i) => ({
          action: "decide",
          label: `Close ${i.id}`,
          item: i.id,
          decision: "close",
          primary: true
        }))
      });
    }
  }
  if (alignment?.mismatch === "work-closed-claims-violated") {
    const closed = alignment.items.filter((i) => !decided(i.id));
    if (closed.length > 0) {
      flags.push({
        text: "The work is closed but a claim is violated: closed too early, or regressed.",
        intent: "danger",
        buttons: closed.map((i) => ({
          action: "decide",
          label: `Reopen ${i.id}`,
          item: i.id,
          decision: "reopen"
        }))
      });
    }
  }
  if (contested) {
    flags.push({
      text: "Edited on two branches at once. Edit it to settle which text stands.",
      intent: "warning"
    });
  }
  const quoted = plan.annotations.filter((a) => a.requirement === r.id && marks.has(a.id));
  const evidence = r.claims.map((claim, i) => {
    const result = results[i];
    const expression = `${claim.kind} ${claim.expression}${claim.expect ? "" : " (expect none)"}`;
    return result === undefined ? { label: `${expression} \xB7 not checked` } : { label: `${expression} \xB7 ${result.evidence}`, intent: OUTCOME_INTENT[result.outcome] };
  });
  return {
    id: r.id,
    title: r.title,
    version: r.revision,
    health,
    ...note === "" ? {} : { note },
    tags,
    properties,
    body: {
      kind: "markdown",
      source: r.text,
      ...quoted.length > 0 ? { marks: quoted.map((a) => ({ text: a.quote ?? "", id: marks.get(a.id) ?? "" })) } : {}
    },
    ...delta === undefined ? {} : {
      proposed: {
        kind: "diff",
        before: r.text,
        after: delta.op === "remove" ? "" : delta.requirement.text
      }
    },
    evidence,
    ...flags.length > 0 ? { flags } : {},
    ...approved ? {} : {
      buttons: [
        {
          action: "approve",
          label: approval?.verdict === "approved" ? "Approve again" : "Approve"
        },
        ...declined ? [] : [{ action: DECLINE_ACTION, label: "Decline" }]
      ]
    },
    editable: { title: r.title, text: r.text }
  };
}
function projectThreads(plan, state, marks, atOf, isAgent, when, you) {
  const removed = (a) => isAnnotationRemoved(plan, a.id);
  const removable = (a) => you !== undefined && !removed(a) && a.author === you;
  const byId = new Map(plan.annotations.map((a) => [a.id, a]));
  const rootOf = (a) => {
    let current = a;
    const seen = new Set;
    while (current.replyTo !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.replyTo);
      if (parent === undefined)
        break;
      current = parent;
    }
    return current;
  };
  const reply = (a) => ({
    id: a.id,
    ...removable(a) ? { removable: true } : {},
    author: a.author,
    ...isAgent(a.author) ? { agent: true } : {},
    when: when(atOf.get(a.id)),
    body: a.body
  });
  const roots = plan.annotations.filter((a) => rootOf(a) === a);
  return roots.flatMap((a) => {
    const replies = plan.annotations.filter((b) => b !== a && rootOf(b) === a && !removed(b));
    if (removed(a) && replies.length === 0)
      return [];
    const mark = marks.get(a.id);
    return [
      {
        ...reply(a),
        id: a.id,
        section: a.requirement,
        ...mark === undefined ? {} : { mark },
        ...a.quote === undefined || a.quote === "" || removed(a) ? {} : { quote: a.quote },
        ...removed(a) ? { body: "", removed: true } : {},
        outdated: isAnnotationOutdated(state, plan.id, a),
        replies: replies.map(reply)
      }
    ];
  });
}
function verdictChip(approval) {
  if (approval.stale) {
    return { label: `${approval.verdict} by ${approval.by}, changed since`, intent: "warning" };
  }
  return approval.verdict === "approved" ? { label: `approved by ${approval.by}`, intent: "success" } : { label: `declined by ${approval.by}: ${approval.reason ?? ""}`, intent: "danger" };
}
function projectActivity(options, plan, state, isAgent, when) {
  const titleOf = (id) => plan.heads.get(id)?.title ?? id;
  const changeTitle = (id) => state.changes.get(id)?.change.title ?? id;
  const ofPlan = (changeId) => state.changes.get(changeId)?.change.planId === plan.id;
  const sentence = (event) => {
    switch (event.type) {
      case "revision-recorded":
        if (event.planId !== plan.id)
          return;
        return event.base === undefined ? `added \u201C${event.requirement.title}\u201D` : `revised \u201C${event.requirement.title}\u201D`;
      case "requirement-removed":
        return event.planId === plan.id ? `removed ${event.id}` : undefined;
      case "change-opened":
        return event.change.planId === plan.id ? `opened \u201C${event.change.title}\u201D` : undefined;
      case "change-archived":
        return ofPlan(event.changeId) ? `accepted \u201C${changeTitle(event.changeId)}\u201D` : undefined;
      case "change-abandoned":
        return ofPlan(event.changeId) ? `rejected \u201C${changeTitle(event.changeId)}\u201D: ${event.reason}` : undefined;
      case "status-changed": {
        if (event.planId !== plan.id)
          return;
        const by = event.proposal === undefined ? undefined : state.proposals.get(event.proposal);
        return by === undefined || by.proposedBy === event.actor ? `moved the plan to ${event.to}` : `accepted ${by.proposedBy}'s proposal: moved the plan to ${event.to}`;
      }
      case "status-proposed": {
        if (event.planId !== plan.id)
          return;
        const p = state.proposals.get(event.eventId);
        return p?.status === "accepted" && p.decidedBy === event.actor ? undefined : `proposed moving the plan to ${event.to}: ${event.reason}`;
      }
      case "status-declined": {
        const p = state.proposals.get(event.proposalId);
        return p?.planId === plan.id ? `declined moving the plan to ${p.to}: ${event.reason}` : undefined;
      }
      case "requirement-approved":
        return event.planId === plan.id ? `approved \u201C${titleOf(event.requirement)}\u201D` : undefined;
      case "requirement-declined":
        return event.planId === plan.id ? `declined \u201C${titleOf(event.requirement)}\u201D: ${event.reason}` : undefined;
      case "annotation-removed": {
        if (event.planId !== plan.id)
          return;
        const gone = plan.annotations.find((a) => a.id === event.annotationId);
        return gone === undefined ? undefined : `removed a ${gone.replyTo === undefined ? "comment" : "reply"} on \u201C${titleOf(gone.requirement)}\u201D`;
      }
      case "annotation-added":
        if (event.planId !== plan.id)
          return;
        return event.annotation.replyTo === undefined ? `commented on \u201C${titleOf(event.annotation.requirement)}\u201D` : `replied on \u201C${titleOf(event.annotation.requirement)}\u201D`;
      case "decision-recorded": {
        if (event.planId !== plan.id)
          return;
        const d = state.decisions.get(event.eventId);
        return d?.finalizedBy === event.actor ? undefined : `proposed to ${event.decision} ${event.item}: ${event.reason}`;
      }
      case "decision-finalized":
      case "decision-applied":
      case "decision-failed": {
        const d = state.decisions.get(event.decisionId);
        if (d === undefined || d.planId !== plan.id)
          return;
        if (event.type === "decision-finalized") {
          return `decided to ${d.decision} ${d.item}: ${d.reason}`;
        }
        if (event.type === "decision-applied")
          return `applied the decision: ${event.note}`;
        return `could not ${d.decision} ${d.item}: ${event.error}`;
      }
      case "work-linked":
        return event.planId === plan.id ? `linked ${event.workItems.length === 0 ? "no work items" : event.workItems.join(", ")}` : undefined;
    }
  };
  const out = [];
  for (let i = options.events.length - 1;i >= 0 && out.length < ACTIVITY_LIMIT; i--) {
    const event = options.events[i];
    if (event === undefined)
      continue;
    const what = sentence(event);
    if (what === undefined)
      continue;
    out.push({
      id: event.eventId,
      who: event.actor,
      kind: options.you !== undefined && event.actor === options.you ? "you" : isAgent(event.actor) ? "agent" : "person",
      what,
      when: when(event.at)
    });
  }
  return out;
}
function projectCallouts(plan, waiting, weigh) {
  const notes = weigh.length > 0 ? weigh : [{ label: "every requirement approved; no open threads or changes", intent: "success" }];
  const verb = (to) => to === "accepted" ? "Accept the plan" : `Move to ${to}`;
  if (waiting.length > 0) {
    return waiting.map((p) => ({
      id: `${PROPOSAL_CALLOUT}${p.id}`,
      text: `${p.proposedBy} proposes moving this plan from ${plan.status} to ${p.to}: \u201C${p.reason}\u201D`,
      intent: "primary",
      notes,
      buttons: [
        { action: "confirm", label: verb(p.to), decision: p.to, primary: true },
        { action: "decline", label: "Not yet" }
      ]
    }));
  }
  const next = NEXT_STATUS[plan.status];
  if (next === undefined)
    return [];
  return [
    {
      id: NEXT_CALLOUT,
      text: plan.status === "draft" ? "This plan is a draft. Accept it once its requirements say what you want." : `This plan is ${plan.status}. Move it to ${next} when that is true.`,
      intent: "neutral",
      notes,
      buttons: [{ action: "confirm", label: verb(next), decision: next }]
    }
  ];
}
// yojana/src/session.ts
import { mkdirSync as mkdirSync4, writeFileSync as writeFileSync2 } from "fs";
import { basename as basename2, join as join5, relative as relative2, sep as sep2 } from "path";

// yojana/src/status.ts
var DAY_MS = 24 * 60 * 60 * 1000;
async function status(options) {
  const state = foldLog(await options.store.events());
  const dry = await ingest({
    store: options.store,
    parser: options.parser,
    bases: options.bases,
    files: options.files,
    actor: "status",
    dryRun: true
  });
  const fileFor = new Map;
  const untracked = [];
  for (const report of dry.files) {
    if (report.planId === undefined || report.outcome === "invalid" || !state.plans.has(report.planId)) {
      untracked.push({ source: report.source, planId: report.planId, issues: report.issues });
      continue;
    }
    const ids = (movement) => report.requirements.filter((r) => r.movement === movement).map((r) => r.id);
    fileFor.set(report.planId, {
      kind: "file",
      source: report.source,
      unrecorded: [...ids("edited"), ...ids("resolved")],
      behind: ids("behind"),
      conflicts: ids("conflict"),
      statusUnrecorded: report.status?.movement === "edited",
      workItemsUnrecorded: report.workItemsChanged
    });
  }
  const progressFor = new Map;
  if (options.worklink !== undefined) {
    for (const p of await progress({
      store: options.store,
      worklink: options.worklink,
      planId: options.planId
    })) {
      progressFor.set(p.planId, p);
    }
  }
  const plans = [];
  for (const plan of state.plans.values()) {
    if (options.planId !== undefined && plan.id !== options.planId)
      continue;
    const heads = [...plan.heads.values()];
    const openChanges = [...state.changes.values()].filter((c) => c.status === "open" && c.change.planId === plan.id).map((c) => {
      const ageDays = Math.floor((options.now - c.openedAt) / DAY_MS);
      return {
        id: c.change.id,
        title: c.change.title,
        ageDays,
        stale: ageDays > options.staleDays
      };
    });
    plans.push({
      planId: plan.id,
      status: plan.status,
      statusSince: plan.statusHistory.at(-1)?.at,
      requirements: heads.length,
      claims: heads.reduce((n, r) => n + r.claims.length, 0),
      file: fileFor.get(plan.id) ?? { kind: "none" },
      contested: [...plan.contested.keys()],
      openChanges,
      progress: progressFor.get(plan.id),
      alignment: await align(plan.id, heads, options.checks, options.worklink)
    });
  }
  return { plans, untracked, anomalies: openAnomalies(state) };
}
async function align(planId, heads, checks, worklink) {
  const linked = heads.filter((r) => (r.workItems ?? []).length > 0);
  if (checks === undefined || worklink === undefined || linked.length === 0)
    return [];
  const ids = [...new Set(linked.flatMap((r) => r.workItems ?? []))];
  const lookup = await worklink.get(ids);
  if (!lookup.ok)
    return [];
  const byId = new Map(lookup.items.map((item) => [item.id, item]));
  const results = checks.plans.find((p) => p.planId === planId)?.results ?? [];
  return linked.map((requirement) => {
    const items = (requirement.workItems ?? []).map((id) => byId.get(id) ?? { id, title: "", state: "missing" });
    const own = results.filter((r) => r.requirement === requirement.id);
    const count = (outcome) => own.filter((r) => r.outcome === outcome).length;
    const holds = count("holds");
    const violated = count("violated");
    const unverifiable = count("unverifiable");
    const allHold = own.length > 0 && holds === own.length;
    const allClosed = items.every((i) => i.state === "closed");
    const someOpen = items.some((i) => i.state !== "closed" && i.state !== "missing");
    const mismatch = allHold && someOpen ? "claims-hold-work-open" : violated > 0 && allClosed ? "work-closed-claims-violated" : undefined;
    return { requirement: requirement.id, items, holds, violated, unverifiable, mismatch };
  });
}

// yojana/src/workspace.ts
import {
  existsSync as existsSync4,
  mkdirSync as mkdirSync3,
  readdirSync,
  readFileSync as readFileSync4,
  renameSync as renameSync3,
  statSync,
  writeFileSync
} from "fs";
import { basename, join as join4, relative, sep } from "path";

// yojana-store/src/base-store.ts
import {
  closeSync,
  existsSync as existsSync2,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync as readFileSync2,
  renameSync,
  rmSync,
  writeSync
} from "fs";
import { join as join3 } from "path";
class FileBaseStore {
  name = "file";
  dir;
  constructor(options) {
    this.dir = options.dir;
  }
  #path(planId, extension = "jsonl") {
    return join3(this.dir, `${encodeURIComponent(planId)}.${extension}`);
  }
  async get(planId) {
    const path = this.#path(planId);
    if (existsSync2(path))
      return parseBaseLines(path, planId, readFileSync2(path, "utf8"));
    const legacy = this.#path(planId, "json");
    if (existsSync2(legacy))
      return parseLegacyBase(legacy, planId, readFileSync2(legacy, "utf8"));
    return;
  }
  async set(base) {
    mkdirSync(this.dir, { recursive: true });
    const lines = [
      JSON.stringify({ planId: base.planId, status: base.status }),
      ...Object.entries(base.revisions).sort(([a], [b]) => a.localeCompare(b)).map(([id, revision]) => JSON.stringify({ id, revision }))
    ];
    const path = this.#path(base.planId);
    const temp = `${path}.tmp`;
    const fd = openSync(temp, "w");
    try {
      writeSync(fd, `${lines.join(`
`)}
`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    rmSync(this.#path(base.planId, "json"), { force: true });
  }
}
function unreadable(path, why, cause) {
  return new YojanaError("BASE_UNREADABLE", `${path}: ${why}`, {
    hint: "restore it from git, or delete it and ingest with --trust-file",
    cause
  });
}
function asStatus(value) {
  return PLAN_STATUSES.find((s) => s === value);
}
function parseBaseLines(path, planId, text) {
  let status;
  let sawHeader = false;
  const revisions = {};
  for (const [index, line] of text.split(`
`).entries()) {
    if (line.trim() === "")
      continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw unreadable(path, `line ${index + 1} is not JSON`, error);
    }
    const entry = value ?? {};
    if (typeof entry.planId === "string") {
      if (entry.planId !== planId)
        throw unreadable(path, `is a base for ${entry.planId}`);
      sawHeader = true;
      status = asStatus(entry.status);
    } else if (typeof entry.id === "string" && typeof entry.revision === "string") {
      revisions[entry.id] = entry.revision;
    } else {
      throw unreadable(path, `line ${index + 1} is neither a header nor a requirement`);
    }
  }
  if (!sawHeader)
    throw unreadable(path, "has no header line");
  return { planId, status, revisions };
}
function parseLegacyBase(path, planId, text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw unreadable(path, "is not valid JSON", error);
  }
  const base = raw ?? {};
  if (base.planId !== planId || typeof base.revisions !== "object" || base.revisions === null) {
    throw unreadable(path, `is not a base for ${planId}`);
  }
  return { planId, status: asStatus(base.status), revisions: base.revisions };
}
// yojana-store/src/errors.ts
class StoreClosedError extends YojanaError {
  constructor(store) {
    super("STORE_CLOSED", `the ${store} store is not open`, { hint: "call open() first" });
    this.name = "StoreClosedError";
  }
}

class CorruptStoreError extends YojanaError {
  source;
  atSeq;
  constructor(source, atSeq) {
    super("STORE_CORRUPT", `${source} is unreadable from event ${atSeq}; writes are refused`, {
      hint: "run repair to move the unreadable tail aside and keep every good event"
    });
    this.name = "CorruptStoreError";
    this.source = source;
    this.atSeq = atSeq;
  }
}
// yojana-store/src/file-store.ts
import {
  closeSync as closeSync2,
  existsSync as existsSync3,
  fsyncSync as fsyncSync2,
  mkdirSync as mkdirSync2,
  openSync as openSync2,
  readFileSync as readFileSync3,
  renameSync as renameSync2,
  writeSync as writeSync2
} from "fs";
import { dirname } from "path";
function decodeLine(line, seq) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return;
  const { eventId, seq: _storedSeq, at, actor, ...input } = value;
  if (typeof input.type !== "string" || typeof at !== "number" || typeof actor !== "string") {
    return;
  }
  const event = input;
  const id = typeof eventId === "string" ? eventId : computeEventId(event, at, actor);
  return { ...event, eventId: id, seq, at, actor };
}
function encodeLine(event) {
  const { seq: _position, ...stored } = event;
  return `${JSON.stringify(stored)}
`;
}

class FileStore {
  name = "file";
  path;
  #now;
  #opened = false;
  #log = [];
  #badTail;
  constructor(options) {
    this.path = options.path;
    this.#now = options.now ?? Date.now;
  }
  async open() {
    this.#opened = true;
    this.#log = [];
    this.#badTail = undefined;
    if (!existsSync3(this.path))
      return { status: "ok" };
    const lines = readFileSync3(this.path, "utf8").split(`
`);
    const ids = new Set;
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "")
        continue;
      const position = this.#log.length + 1;
      const event = decodeLine(line, position);
      if (event === undefined || ids.has(event.eventId)) {
        this.#badTail = lines.slice(index).join(`
`);
        return { status: "corrupt", source: this.path, atSeq: position };
      }
      ids.add(event.eventId);
      this.#log.push(event);
    }
    return { status: "ok" };
  }
  async close() {
    this.#opened = false;
  }
  async append(event, actor) {
    this.#assertOpen();
    if (this.#badTail !== undefined) {
      throw new CorruptStoreError(this.path, this.#log.length + 1);
    }
    const at = this.#now();
    const seq = this.#log.length + 1;
    const stored = {
      ...event,
      eventId: computeEventId(event, at, actor, seq),
      seq,
      at,
      actor
    };
    mkdirSync2(dirname(this.path), { recursive: true });
    const fd = openSync2(this.path, "a");
    try {
      writeSync2(fd, encodeLine(stored));
      fsyncSync2(fd);
    } finally {
      closeSync2(fd);
    }
    this.#log.push(stored);
    return stored;
  }
  async events(afterSeq = 0, limit = Number.POSITIVE_INFINITY) {
    this.#assertOpen();
    return this.#log.filter((e) => e.seq > afterSeq).slice(0, limit);
  }
  async head() {
    this.#assertOpen();
    return this.#log.length;
  }
  async repair() {
    this.#assertOpen();
    if (this.#badTail === undefined)
      return { kept: this.#log.length, quarantined: undefined };
    const quarantined = `${this.path}.corrupt-${this.#now()}`;
    writeDurably(quarantined, this.#badTail);
    const temp = `${this.path}.tmp`;
    writeDurably(temp, this.#log.map(encodeLine).join(""));
    renameSync2(temp, this.path);
    this.#badTail = undefined;
    return { kept: this.#log.length, quarantined };
  }
  #assertOpen() {
    if (!this.#opened)
      throw new StoreClosedError(this.name);
  }
}
function writeDurably(path, text) {
  const fd = openSync2(path, "w");
  try {
    writeSync2(fd, text);
    fsyncSync2(fd);
  } finally {
    closeSync2(fd);
  }
}
// yojana/src/workspace.ts
function openWorkspace(root, options) {
  const store = new FileStore({ path: join4(root, ".yojana", "log.jsonl") });
  return {
    root,
    plansDir: join4(root, options?.plansDir ?? "plans"),
    changesDir: join4(root, options?.changesDir ?? "changes"),
    store,
    bases: new FileBaseStore({ dir: join4(root, ".yojana", "base") }),
    parser: new MarkdownParser,
    repairLog: () => store.repair()
  };
}
function loadPlanFiles(root, dir) {
  const files = [];
  if (!existsSync4(dir))
    return files;
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const path = join4(current, name);
      if (statSync(path).isDirectory())
        walk(path);
      else if (name.endsWith(".md")) {
        files.push({
          source: relative(root, path).split(sep).join("/"),
          text: readFileSync4(path, "utf8")
        });
      }
    }
  };
  walk(dir);
  return files;
}
function settleChangeFile(root, source, folder, date) {
  const from = join4(root, source);
  if (!existsSync4(from))
    return;
  const dir = join4(from, "..", folder);
  mkdirSync3(dir, { recursive: true });
  const to = join4(dir, `${date.toISOString().slice(0, "yyyy-mm-dd".length)}-${basename(from)}`);
  renameSync3(from, to);
  return relative(root, to).split(sep).join("/");
}
var GIT_ATTRIBUTES = `# Written by yojana. The log and the bases hold one fact per line, so git can merge two branches
# by keeping both sides' lines; yojana reads the result and reports any requirement both edited.
log.jsonl merge=union
base/*.jsonl merge=union
`;
function ensureGitAttributes(root) {
  mkdirSync3(join4(root, ".yojana"), { recursive: true });
  const attributes = join4(root, ".yojana", ".gitattributes");
  if (!existsSync4(attributes))
    writeFileSync(attributes, GIT_ATTRIBUTES);
  const ignore = join4(root, ".yojana", ".gitignore");
  if (!existsSync4(ignore))
    writeFileSync(ignore, `# Written by yojana: generated review pages.
review/
`);
}

// yojana/src/session.ts
var REVIEW_TEMPLATE = "review-document";
var STALE_DAYS = 14;
var refuse2 = (code, message, current) => current === undefined ? { ok: false, code, message } : { ok: false, code, message, current };
var PAGE = { ok: true, update: { kind: "page" } };
function reviewSession(options) {
  const now = options.now ?? Date.now;
  const toSource = (path) => relative2(options.root, path).split(sep2).join("/");
  let lastWrite = Promise.resolve();
  const withLog = (work, write) => {
    const run = async () => {
      const ws = openWorkspace(options.root, {
        plansDir: options.plansDir,
        changesDir: options.changesDir
      });
      const opened = await ws.store.open();
      if (opened.status === "corrupt") {
        await ws.store.close();
        throw new YojanaError("STORE_CORRUPT", `the log is unreadable from event ${opened.atSeq}`, {
          hint: "run yojana repair"
        });
      }
      try {
        return await work(ws);
      } finally {
        await ws.store.close();
      }
    };
    if (!write)
      return run();
    return (async () => {
      const previous = lastWrite;
      let release = () => {
        return;
      };
      lastWrite = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await run();
      } finally {
        release();
      }
    })();
  };
  const workCache = new Map;
  const tracker = options.worklink();
  const remember = (key, ask) => {
    const known = workCache.get(key);
    if (known !== undefined)
      return known;
    const answer = ask().then((lookup) => {
      if (!lookup.ok)
        workCache.delete(key);
      return lookup;
    });
    workCache.set(key, answer);
    return answer;
  };
  const worklink = {
    name: tracker.name,
    get: (ids) => remember(`get ${ids.join(" ")}`, () => tracker.get(ids)),
    children: (id) => remember(`children ${id}`, () => tracker.children(id))
  };
  const checked = new Map;
  const runChecks = async (ws, planId) => {
    const report = await check({ store: ws.store, verifiers: options.verifiers(), planId });
    const entry = { report, at: now() };
    checked.set(planId, entry);
    return entry;
  };
  const project = async (ws, planId) => {
    const cached = options.runCheck ? checked.get(planId) ?? await runChecks(ws, planId) : undefined;
    const files = loadPlanFiles(options.root, ws.plansDir);
    const at = now();
    const report = await status({
      store: ws.store,
      parser: ws.parser,
      bases: ws.bases,
      files,
      worklink,
      checks: cached?.report,
      now: at,
      staleDays: STALE_DAYS,
      planId
    });
    const plan = files.map((f) => ws.parser.parse(f.source, f.text)).find((p) => p.ok && p.plan.id === planId);
    return projectReview({
      events: await ws.store.events(),
      planId,
      plan: plan?.ok ? plan.plan : undefined,
      report: report.plans.find((p) => p.planId === planId),
      checks: cached?.report.plans.find((p) => p.planId === planId)?.results ?? [],
      checkedAt: cached?.at,
      now: at,
      mode: options.mode ?? "suggest",
      repository: basename2(options.root),
      you: options.you
    });
  };
  const sectionOf = async (ws, planId, id) => (await project(ws, planId))?.sections.find((s) => s.id === id);
  const handleIn = async (ws, intent) => {
    const planId = intent.document;
    const key = intent.target.key;
    const field = (name) => intent.payload[name] ?? "";
    const files = () => loadPlanFiles(options.root, ws.plansDir);
    const writePlan = (source, text) => writeFileSync2(join5(options.root, source), text);
    switch (intent.action) {
      case "refresh": {
        workCache.clear();
        if (options.runCheck)
          await runChecks(ws, planId);
        return PAGE;
      }
      case "comment":
      case "reply": {
        let requirement = key;
        let replyTo;
        if (intent.action === "reply") {
          const plan = foldLog(await ws.store.events()).plans.get(planId);
          const thread = plan?.annotations.find((a) => a.id === key);
          if (thread === undefined) {
            return refuse2("NOT_FOUND", "That comment is gone; reload the page.");
          }
          requirement = thread.requirement;
          replyTo = thread.id;
        }
        const result = await comment({
          store: ws.store,
          planId,
          requirement,
          body: field("body"),
          author: intent.actor,
          quote: field("quote") || undefined,
          replyTo
        });
        return result.ok ? PAGE : refuse2(result.code, result.message);
      }
      case "remove": {
        const result = await removeComment({
          store: ws.store,
          planId,
          id: field("item") || key,
          actor: intent.actor
        });
        return result.ok ? PAGE : refuse2(result.code, result.message);
      }
      case "edit":
      case "suggest": {
        const request = {
          store: ws.store,
          parser: ws.parser,
          planId,
          requirementId: key,
          expectedRevision: intent.version ?? "",
          title: field("title"),
          text: field("text"),
          actor: intent.actor
        };
        const result = intent.action === "edit" ? await editRequirement({ ...request, bases: ws.bases, files: files(), writePlan }) : await suggestEdit({
          ...request,
          why: field("why"),
          changesDir: toSource(ws.changesDir),
          writeChange: (source, text) => {
            mkdirSync4(join5(options.root, source, ".."), { recursive: true });
            writeFileSync2(join5(options.root, source), text);
          }
        });
        if (result.ok) {
          if (intent.action === "suggest")
            return PAGE;
          const section = await sectionOf(ws, planId, key);
          return section === undefined ? PAGE : { ok: true, update: { kind: "part", part: "section", key, content: section } };
        }
        if (result.code === "STALE") {
          return refuse2("STALE", `This requirement changed since the page was loaded. It now reads: \u201C${result.current.text}\u201D. Your text is kept below; reload to work on the current version.`, await sectionOf(ws, planId, key));
        }
        return refuse2(result.code, result.message);
      }
      case "accept": {
        const result = await archiveChange({
          store: ws.store,
          bases: ws.bases,
          parser: ws.parser,
          changeId: key,
          actor: intent.actor,
          planFiles: files(),
          writePlan
        });
        if (result.outcome !== "archived") {
          const why = [
            ...result.problems.map((p) => p.message),
            ...result.conflicts.map((c) => `${c.requirement} changed since this change was opened; reject it, or suggest it again on the current text`)
          ].join("; ");
          return refuse2(result.conflicts.length > 0 ? "CONFLICT" : "REFUSED", why);
        }
        if (result.change?.source !== undefined) {
          settleChangeFile(options.root, result.change.source, "archive", new Date(now()));
        }
        return PAGE;
      }
      case "reject": {
        const result = await abandonChange({
          store: ws.store,
          changeId: key,
          reason: field("reason"),
          actor: intent.actor
        });
        if (result.outcome !== "abandoned") {
          const problem = result.problems[0];
          return refuse2(problem?.code ?? "REFUSED", result.problems.map((p) => p.message).join("; "));
        }
        if (result.change?.source !== undefined) {
          settleChangeFile(options.root, result.change.source, "abandoned", new Date(now()));
        }
        return PAGE;
      }
      case "decide": {
        const recorded = await recordDecision({
          store: ws.store,
          planId,
          requirement: key,
          item: field("item"),
          decision: field("decision"),
          reason: field("reason"),
          actor: intent.actor,
          finalize: true
        });
        if (!recorded.ok)
          return refuse2(recorded.code, recorded.message);
        await applyDecisions({
          store: ws.store,
          worklink: tracker,
          actor: intent.actor,
          ids: [recorded.decision.id]
        });
        workCache.clear();
        return PAGE;
      }
      case "approve": {
        const result = await approveRequirement({
          store: ws.store,
          planId,
          requirement: key,
          revision: intent.version,
          actor: intent.actor,
          agent: false
        });
        if (!result.ok) {
          return refuse2(result.code, result.code === "STALE" ? "This requirement changed since the page was loaded; reload and read it again before approving." : result.message);
        }
        return PAGE;
      }
      case DECLINE_ACTION: {
        const result = await declineRequirement({
          store: ws.store,
          planId,
          requirement: key,
          reason: field("reason"),
          revision: intent.version,
          actor: intent.actor,
          agent: false
        });
        if (!result.ok) {
          return refuse2(result.code, result.code === "STALE" ? "This requirement changed since the page was loaded; reload and read it again before declining." : result.message);
        }
        return PAGE;
      }
      case "confirm":
      case "decline": {
        const proposalId = key.startsWith(PROPOSAL_CALLOUT) ? key.slice(PROPOSAL_CALLOUT.length) : undefined;
        const decided = proposalId === undefined ? intent.action === "confirm" && key === NEXT_CALLOUT ? await proposeStatus({
          store: ws.store,
          planId,
          to: field("decision"),
          reason: field("reason") || "on the review page",
          actor: intent.actor,
          agent: false,
          finalize: true
        }) : {
          ok: false,
          code: "NOT_FOUND",
          message: "Nothing is proposed here; reload the page."
        } : intent.action === "confirm" ? await finalizeStatus({
          store: ws.store,
          proposalId,
          reason: field("reason"),
          actor: intent.actor,
          agent: false
        }) : await declineStatus({
          store: ws.store,
          proposalId,
          reason: field("reason"),
          actor: intent.actor,
          agent: false
        });
        if (!decided.ok)
          return refuse2(decided.code, decided.message);
        await settleStatusLine({
          store: ws.store,
          parser: ws.parser,
          bases: ws.bases,
          files: files(),
          writePlan,
          proposal: decided.proposal
        });
        return PAGE;
      }
      default:
        return refuse2("UNSUPPORTED", `There is no action ${intent.action} on a plan.`);
    }
  };
  return {
    load: (template, document) => template === REVIEW_TEMPLATE ? withLog((ws) => project(ws, document), false) : Promise.resolve(undefined),
    handle: (intent) => intent.template === REVIEW_TEMPLATE ? withLog((ws) => handleIn(ws, intent), true) : Promise.resolve(refuse2("NOT_FOUND", `No template ${intent.template} here.`)),
    plans: () => withLog(async (ws) => {
      const state = foldLog(await ws.store.events());
      return [...state.plans.values()].map((p) => ({
        id: p.id,
        status: p.status,
        requirements: p.heads.size
      }));
    }, false)
  };
}

// yojana/src/index.ts
var VERSION = "0.0.0";

// yojana-verify/src/evidence.ts
var EVIDENCE_ITEMS = 3;
function listed(items) {
  const shown = items.slice(0, EVIDENCE_ITEMS).join(", ");
  const rest = items.length - EVIDENCE_ITEMS;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

// yojana-verify/src/anvesa.ts
function spawnAnvesa(bin, root) {
  return async (args) => {
    const child = Bun.spawn([bin, ...args, "--root", root, "--json"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe"
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ]);
    return { exitCode, stdout, stderr };
  };
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return;
  }
}
function parseOutput(result) {
  const value = parseJson(result.stdout) ?? parseJson(result.stderr);
  if (value === undefined) {
    const text = (result.stderr || result.stdout).trim();
    return { ok: false, why: `anvesa did not answer in JSON (exit ${result.exitCode}): ${text}` };
  }
  if (typeof value !== "object" || value === null) {
    return { ok: false, why: "anvesa answered with something other than an object" };
  }
  const record = value;
  const error = record.error;
  if (error !== undefined) {
    const hint = typeof error.hint === "string" ? ` (${error.hint})` : "";
    return { ok: false, why: `${String(error.code)}: ${String(error.message)}${hint}` };
  }
  return { ok: true, value: record };
}

class AnvesaVerifier {
  name = "anvesa";
  kinds = ["wql", "dependents"];
  #run;
  constructor(run) {
    this.#run = run;
  }
  async verify(requirement, claim) {
    const result = (outcome, evidence) => ({
      requirement,
      claim,
      outcome,
      evidence
    });
    const judge = (found, evidence) => result(found === claim.expect ? "holds" : "violated", evidence);
    let output;
    try {
      output = await this.#run(this.#args(claim));
    } catch (error) {
      return result("unverifiable", `could not run anvesa (${String(error)}); install it or set ANVESA_BIN`);
    }
    const parsed = parseOutput(output);
    if (!parsed.ok)
      return result("unverifiable", parsed.why);
    if (claim.kind === "wql") {
      const { within } = splitWql(claim.expression);
      const items = (Array.isArray(parsed.value.items) ? parsed.value.items : []).map((item) => item);
      const places = items.filter((i) => within === undefined || String(i.path).startsWith(within)).map((i) => `${String(i.path)}:${String(i.startLine)}`);
      const scope = within === undefined ? "" : ` in ${within}`;
      const overall = within === undefined ? "" : ` (${items.length} ${items.length === 1 ? "match" : "matches"} in all)`;
      return judge(places.length > 0, places.length > 0 ? `matches${scope} ${listed(places)}${overall}` : `no match${scope}${overall}`);
    }
    const { from } = splitDependents(claim.expression);
    const all = Array.isArray(parsed.value.dependents) ? parsed.value.dependents : [];
    const paths = all.map((d) => String(d.path)).filter((path) => from === undefined || path.startsWith(from));
    const scope = from === undefined ? "" : ` under ${from}`;
    const overall = from === undefined ? "" : ` (${all.length} ${all.length === 1 ? "file imports" : "files import"} it in all)`;
    const count = `${paths.length} ${paths.length === 1 ? "file" : "files"}`;
    return judge(paths.length > 0, paths.length > 0 ? `imported${scope} by ${listed(paths)} (${count})${overall}` : `nothing${scope} imports it${overall}`);
  }
  #args(claim) {
    if (claim.kind === "wql") {
      const { query, within } = splitWql(claim.expression);
      const limit = within === undefined ? 1 : Number.MAX_SAFE_INTEGER;
      return ["query", query, "--limit", String(limit)];
    }
    const { target } = splitDependents(claim.expression);
    return [
      "dependents",
      target,
      "--depth",
      String(Number.MAX_SAFE_INTEGER),
      "--limit",
      String(Number.MAX_SAFE_INTEGER)
    ];
  }
}
function splitWql(expression) {
  const match = /^(.+)\s+in\s+([^\s[\]()"']+)$/.exec(expression.trim());
  if (match === null)
    return { query: expression.trim(), within: undefined };
  return { query: (match[1] ?? "").trim(), within: match[2] };
}
function splitDependents(expression) {
  const match = /^(.*?)\s+from\s+(\S+)$/.exec(expression.trim());
  if (match === null)
    return { target: expression.trim(), from: undefined };
  return { target: (match[1] ?? "").trim(), from: match[2] };
}
// yojana-verify/src/path.ts
import { existsSync as existsSync5 } from "fs";
import { join as join6 } from "path";
class PathVerifier {
  name = "path";
  kinds = ["path"];
  #root;
  constructor(root) {
    this.#root = root;
  }
  async verify(requirement, claim) {
    const pattern = claim.expression.trim();
    const isGlob = /[*?[{]/.test(pattern);
    const matches = isGlob ? Array.from(new Bun.Glob(pattern).scanSync({ cwd: this.#root, dot: true })) : existsSync5(join6(this.#root, pattern)) ? [pattern] : [];
    const found = matches.length > 0;
    return {
      requirement,
      claim,
      outcome: found === claim.expect ? "holds" : "violated",
      evidence: found ? `${matches.length} ${matches.length === 1 ? "match" : "matches"}: ${listed(matches.sort())}` : `${pattern} does not exist`
    };
  }
}
// yojana-verify/src/text.ts
import { existsSync as existsSync6, readFileSync as readFileSync5, statSync as statSync2 } from "fs";
import { join as join7 } from "path";
class TextVerifier {
  name = "text";
  kinds = ["text"];
  #root;
  constructor(root) {
    this.#root = root;
  }
  async verify(requirement, claim) {
    const result = (outcome, evidence) => ({
      requirement,
      claim,
      outcome,
      evidence
    });
    const split = /^(.+)\s+in\s+(\S+)$/.exec(claim.expression.trim());
    if (split === null) {
      return result("unverifiable", "write the claim as `<pattern> in <path or glob>`");
    }
    const [, patternText = "", where = ""] = split;
    let pattern;
    try {
      pattern = toRegExp(patternText.trim());
    } catch (error) {
      return result("unverifiable", `not a valid pattern: ${String(error)}`);
    }
    const files = this.#files(where);
    if (files.length === 0)
      return result("unverifiable", `no file matches ${where}`);
    const hits = [];
    for (const file of files) {
      const lines = readFileSync5(join7(this.#root, file), "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        pattern.lastIndex = 0;
        if (pattern.test(line))
          hits.push(`${file}:${index + 1}`);
      });
    }
    const searched = `${files.length} ${files.length === 1 ? "file" : "files"} searched`;
    const found = hits.length > 0;
    return result(found === claim.expect ? "holds" : "violated", found ? `found at ${listed(hits)} (${hits.length} ${hits.length === 1 ? "line" : "lines"}, ${searched})` : `not found (${searched})`);
  }
  #files(where) {
    if (/[*?[{]/.test(where)) {
      return Array.from(new Bun.Glob(where).scanSync({ cwd: this.#root, dot: true })).map((f) => f.split("\\").join("/")).sort();
    }
    const path = join7(this.#root, where);
    return existsSync6(path) && statSync2(path).isFile() ? [where] : [];
  }
}
function toRegExp(text) {
  const literal = /^\/(.+)\/([a-z]*)$/.exec(text);
  return literal === null ? new RegExp(text) : new RegExp(literal[1] ?? "", literal[2]);
}
// yojana-work/src/bd.ts
function spawnBd(bin, cwd) {
  return async (args) => {
    const child = Bun.spawn([bin, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ]);
    return { exitCode, stdout, stderr };
  };
}
var STATES = {
  open: "open",
  in_progress: "in-progress",
  blocked: "blocked",
  closed: "closed",
  deferred: "deferred"
};
function toItem(raw) {
  const rawState = String(raw.status);
  return {
    id: String(raw.id),
    title: String(raw.title ?? ""),
    state: STATES[rawState] ?? "unknown",
    rawState
  };
}
var NONE_FOUND = /no issues found/i;

class BdWorkLink {
  name = "bd";
  #run;
  constructor(run) {
    this.#run = run;
  }
  async get(ids) {
    if (ids.length === 0)
      return { ok: true, items: [] };
    const answer = await this.#call(["show", ...ids, "--json"]);
    if (!answer.ok)
      return answer;
    const found = new Map;
    if (Array.isArray(answer.value)) {
      for (const raw of answer.value) {
        const item = toItem(raw);
        found.set(item.id, item);
      }
    } else {
      const error = answer.value?.error;
      if (!(typeof error === "string" && NONE_FOUND.test(error))) {
        return {
          ok: false,
          error: `bd show answered unexpectedly: ${JSON.stringify(answer.value)}`
        };
      }
    }
    return {
      ok: true,
      items: ids.map((id) => found.get(id) ?? { id, title: "", state: "missing" })
    };
  }
  async children(id) {
    const answer = await this.#call(["list", "--parent", id, "--all", "--json", "--limit", "0"]);
    if (!answer.ok)
      return answer;
    if (!Array.isArray(answer.value)) {
      return { ok: false, error: `bd list answered unexpectedly: ${JSON.stringify(answer.value)}` };
    }
    return { ok: true, items: answer.value.map((raw) => toItem(raw)) };
  }
  close(id, reason) {
    return this.#change(["close", id, "--reason", reason]);
  }
  reopen(id, reason) {
    return this.#change(["reopen", id, "--reason", reason]);
  }
  async#change(args) {
    let result;
    try {
      result = await this.#run(args);
    } catch (error) {
      return { ok: false, error: `could not run bd (${String(error)}); install it or set BD_BIN` };
    }
    if (result.exitCode === 0)
      return { ok: true };
    const text = (result.stderr || result.stdout).trim();
    return {
      ok: false,
      error: `bd ${args[0]} ${args[1]} failed (exit ${result.exitCode}): ${text}`
    };
  }
  async#call(args) {
    let result;
    try {
      result = await this.#run(args);
    } catch (error) {
      return { ok: false, error: `could not run bd (${String(error)}); install it or set BD_BIN` };
    }
    try {
      return { ok: true, value: JSON.parse(result.stdout) };
    } catch {
      const text = (result.stderr || result.stdout).trim();
      return { ok: false, error: `bd did not answer in JSON (exit ${result.exitCode}): ${text}` };
    }
  }
}
// cli/src/config.ts
import { existsSync as existsSync7, readFileSync as readFileSync6 } from "fs";
import { homedir } from "os";
import { dirname as dirname2, resolve } from "path";
var FONT_ROLES = ["reading", "ui", "mono"];
var EMPTY = {
  path: undefined,
  found: false,
  vars: {},
  home: undefined,
  theme: { css: undefined, fonts: {}, tokens: {}, dark: {} }
};
var TOKEN_NAME = /^[a-z][a-z0-9-]*$/;
var VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
var UNSAFE_VALUE = /[;{}<>\\]/;
function loadConfig(env = process.env) {
  const named = env.YOJANA_CONFIG;
  if (named === undefined || named === "")
    return EMPTY;
  const path = resolve(named);
  if (!existsSync7(path))
    return { ...EMPTY, path };
  let raw;
  try {
    raw = JSON.parse(readFileSync6(path, "utf8"));
  } catch (cause) {
    throw invalid2(path, `is not JSON: ${cause.message}`);
  }
  const top = record(path, raw, "the file", ["vars", "home", "theme"]);
  const vars = {};
  for (const [name, value] of Object.entries(record(path, top.vars ?? {}, "vars"))) {
    if (!VAR_NAME.test(name))
      throw invalid2(path, `vars: ${name} is not a name usable as \${name}`);
    vars[name] = expandPath(path, text(path, value, `vars.${name}`), vars, env);
  }
  const home = top.home === undefined ? undefined : expandPath(path, text(path, top.home, "home"), vars, env);
  const theme = record(path, top.theme ?? {}, "theme", ["css", "fonts", "tokens", "dark"]);
  const css = theme.css === undefined ? undefined : expandPath(path, text(path, theme.css, "theme.css"), vars, env);
  if (css !== undefined && !existsSync7(css))
    throw invalid2(path, `theme.css: no file at ${css}`);
  const fonts = {};
  for (const [role, value] of Object.entries(record(path, theme.fonts ?? {}, "theme.fonts", FONT_ROLES))) {
    fonts[role] = cssValue(path, value, `theme.fonts.${role}`);
  }
  return {
    path,
    found: true,
    vars,
    home,
    theme: {
      css,
      fonts,
      tokens: tokens2(path, theme.tokens, "theme.tokens"),
      dark: tokens2(path, theme.dark, "theme.dark")
    }
  };
}
function themeStylesheet(config, defaultThemeFile, env = process.env) {
  const parts = [];
  const extra = env.YOJANA_THEME_CSS;
  if (extra)
    parts.push(readFileSync6(extra, "utf8"));
  parts.push(readFileSync6(config.theme.css ?? defaultThemeFile, "utf8"));
  const light = {
    ...Object.fromEntries(Object.entries(config.theme.fonts).map(([r, v]) => [`font-${r}`, v])),
    ...config.theme.tokens
  };
  if (Object.keys(light).length > 0)
    parts.push(`:root {
${declarations(light, "  ")}}`);
  const { dark } = config.theme;
  if (Object.keys(dark).length > 0) {
    parts.push(`@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${declarations(dark, "    ")}  }
}`, `:root[data-theme="dark"] {
${declarations(dark, "  ")}}`);
  }
  return `${parts.join(`
`)}
`;
}
function declarations(values, indent) {
  return Object.entries(values).map(([name, value]) => `${indent}--${name}: ${value};
`).join("");
}
function expandPath(file, value, vars, env) {
  const expanded = value.replace(/^~(?=$|[/\\])/, homedir()).replace(/\$\{([^}]*)\}/g, (_, name) => {
    const found = vars[name] ?? env[name];
    if (found === undefined) {
      throw invalid2(file, `\${${name}} in "${value}" is neither a var nor set in the environment`);
    }
    return found;
  });
  return resolve(dirname2(file), expanded);
}
function tokens2(file, value, at) {
  const out = {};
  for (const [key, v] of Object.entries(record(file, value ?? {}, at))) {
    const name = key.replace(/^--/, "");
    if (!TOKEN_NAME.test(name))
      throw invalid2(file, `${at}: ${key} is not a token name`);
    out[name] = cssValue(file, v, `${at}.${key}`);
  }
  return out;
}
function cssValue(file, value, at) {
  const v = text(file, value, at).trim();
  if (v === "" || UNSAFE_VALUE.test(v)) {
    throw invalid2(file, `${at}: "${v}" is not a CSS value (no ; { } < > or \\)`);
  }
  return v;
}
function record(file, value, at, known) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid2(file, `${at} must be an object`);
  }
  const out = value;
  for (const key of Object.keys(out)) {
    if (known !== undefined && !known.includes(key)) {
      throw invalid2(file, `${at}: unknown setting "${key}" (known: ${known.join(", ")})`);
    }
  }
  return out;
}
function text(file, value, at) {
  if (typeof value !== "string")
    throw invalid2(file, `${at} must be a string`);
  return value;
}
function invalid2(file, message) {
  return new YojanaError("CONFIG_INVALID", `${file}: ${message}`, {
    hint: "fix the file, or unset YOJANA_CONFIG to use the defaults"
  });
}

// node_modules/.bun/@cntxt-labs+patra-serve@..+vendor+patra+cntxt-labs-patra-serve-0.0.0.tgz/node_modules/@cntxt-labs/patra-serve/src/runtime.ts
var RUNTIME_SCRIPT = String.raw`
(function () {
  var cfg = JSON.parse(document.getElementById('patra-config').textContent);
  var enc = encodeURIComponent;
  var base = '/' + enc(cfg.template) + '/' + enc(cfg.document) + '/';
  var urls = {
    form: function (action) { return '/f' + base + enc(action); },
    intent: function (action) { return '/i' + base + enc(action); },
    refresh: '/refresh' + base
  };
  document.documentElement.setAttribute('data-patra-live', '');

  // Page-level answers (a refresh, an error with nowhere else to go) appear here.
  var status = document.createElement('div');
  status.className = 'patra-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  document.body.appendChild(status);
  function refresh() {
    status.textContent = 'Refreshing\u2026';
    return htmx.ajax('POST', urls.refresh, { target: status, swap: 'innerHTML' });
  }
  document.body.setAttribute('hx-headers', JSON.stringify({ 'x-patra-token': cfg.token }));

  function itemOf(el) { return el && el.closest('[data-patra-part][data-patra-key]'); }
  function slotOf(item) {
    var slots = item.querySelectorAll('[data-patra-slot]');
    for (var i = 0; i < slots.length; i++) if (itemOf(slots[i]) === item) return slots[i];
    return null;
  }
  function actionsFor(part) {
    return Object.keys(cfg.actions).filter(function (name) { return cfg.actions[name].part === part; });
  }

  // Modes, kept in the URL so a reload or a shared link keeps them.
  var root = document.querySelector('[data-mode]');
  function setMode(mode) {
    if (!root) return;
    root.setAttribute('data-mode', mode);
    document.querySelectorAll('[data-patra-mode]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-patra-mode') === mode));
    });
    var url = new URL(location.href);
    url.searchParams.set('mode', mode);
    history.replaceState(null, '', url);
  }
  var urlMode = new URL(location.href).searchParams.get('mode');
  if (urlMode && document.querySelector('[data-patra-mode="' + CSS.escape(urlMode) + '"]')) setMode(urlMode);
  else if (root) setMode(root.getAttribute('data-mode'));

  // Tabs.
  document.querySelectorAll('[data-patra-tabs]').forEach(function (group) {
    var tabs = group.querySelectorAll('[data-patra-tab]');
    function show(name) {
      tabs.forEach(function (t) { t.setAttribute('aria-selected', String(t.getAttribute('data-patra-tab') === name)); });
      group.querySelectorAll('[data-patra-panel]').forEach(function (p) { p.hidden = p.getAttribute('data-patra-panel') !== name; });
    }
    tabs.forEach(function (t) { t.addEventListener('click', function () { show(t.getAttribute('data-patra-tab')); }); });
    if (tabs.length > 0) show(tabs[0].getAttribute('data-patra-tab'));
  });

  // Filters: one active at a time; clicking the active one shows everything.
  var activeFilter = null;
  function applyFilter() {
    document.querySelectorAll('[data-patra-filter]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-patra-filter') === activeFilter));
    });
    document.querySelectorAll('[data-patra-tags]').forEach(function (el) {
      var tags = (el.getAttribute('data-patra-tags') || '').split(/\s+/);
      el.hidden = activeFilter !== null && tags.indexOf(activeFilter) === -1;
    });
  }
  var initial = document.querySelector('[data-patra-filter][data-active="true"]');
  if (initial) activeFilter = initial.getAttribute('data-patra-filter');
  applyFilter();

  // Opening forms and posting actions.
  function params(item, button, extra) {
    var p = new URLSearchParams();
    p.set('key', item.getAttribute('data-patra-key'));
    ['item', 'decision'].forEach(function (name) {
      var value = button && button.getAttribute('data-patra-' + name);
      if (value) p.set(name, value);
    });
    Object.keys(extra || {}).forEach(function (k) { p.set(k, extra[k]); });
    return p;
  }
  function act(action, item, button, extra, target) {
    var spec = cfg.actions[action];
    if (!spec || !item) return Promise.resolve();
    var slot = target || slotOf(item);
    if (spec.form) {
      return htmx.ajax('GET', urls.form(action) + '?' + params(item, button, extra), { target: slot, swap: 'innerHTML' }).then(function () {
        var input = slot && slot.querySelector('textarea, input:not([type=hidden])');
        if (input) input.focus();
      });
    }
    return htmx.ajax('POST', urls.intent(action), {
      target: slot,
      swap: 'innerHTML',
      values: { _key: item.getAttribute('data-patra-key'), _version: item.getAttribute('data-patra-version') || '' }
    });
  }

  document.addEventListener('click', function (event) {
    var cancel = event.target.closest('[data-patra-cancel]');
    if (cancel) {
      var form = cancel.closest('form');
      if (form) form.remove();
      hidePop();
      return;
    }
    var mode = event.target.closest('[data-patra-mode]');
    if (mode) { setMode(mode.getAttribute('data-patra-mode')); return; }
    var filter = event.target.closest('[data-patra-filter]');
    if (filter) {
      var id = filter.getAttribute('data-patra-filter');
      activeFilter = activeFilter === id ? null : id;
      applyFilter();
      return;
    }
    if (event.target.closest('[data-patra-refresh]')) {
      refresh();
      return;
    }
    var button = event.target.closest('[data-patra-action]');
    if (button) act(button.getAttribute('data-patra-action'), itemOf(button), button);
  });

  // Submitting a form posts its intent; the answer replaces the form (a refusal, with what was
  // typed) or, when it went through, the item itself (the server retargets).
  document.addEventListener('submit', function (event) {
    var form = event.target.closest('form[data-patra-form]');
    if (!form) return;
    event.preventDefault();
    var item = itemOf(form) || popFor;
    if (!item) return;
    var values = { _key: item.getAttribute('data-patra-key'), _version: item.getAttribute('data-patra-version') || '' };
    new FormData(form).forEach(function (value, name) { values[name] = value; });
    form.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    htmx.ajax('POST', urls.intent(form.getAttribute('data-patra-form')), { source: form, target: form, swap: 'outerHTML', values: values });
  });

  // After any swap, newly arrived items follow the current filter.
  document.body.addEventListener('htmx:afterSettle', applyFilter);

  // Selection: a small toolbar by the selection offers the item's comment and suggest.
  var bar = document.createElement('div');
  bar.className = 'patra-selbar';
  bar.hidden = true;
  var pop = document.createElement('div');
  pop.className = 'patra-pop';
  pop.hidden = true;
  document.body.appendChild(bar);
  document.body.appendChild(pop);
  var picked = null;
  var popFor = null;
  function hideBar() { bar.hidden = true; }
  function hidePop() { pop.hidden = true; pop.textContent = ''; popFor = null; showQuote(null); }
  // While the comment popover is open the page keeps the quoted text marked (the selection itself
  // goes when the focus moves to the box), where the browser has the CSS Custom Highlight API.
  function showQuote(range) {
    if (!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return;
    if (range) CSS.highlights.set('patra-quote', new Highlight(range));
    else CSS.highlights.delete('patra-quote');
  }
  function place(el, rect, below) {
    el.style.top = (window.scrollY + (below ? rect.bottom + 8 : rect.top - 44)) + 'px';
    el.style.left = Math.max(16, Math.min(window.scrollX + rect.left, window.scrollX + document.documentElement.clientWidth - el.offsetWidth - 16)) + 'px';
  }
  // The text box a selection belongs to: the one it starts in, else (a drag begun on a heading or
  // in a gap) the first one it reaches.
  function boxOf(range) {
    var start = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    var box = start && start.closest('[data-patra-select]');
    if (box) return box;
    var all = document.querySelectorAll('[data-patra-select]');
    for (var i = 0; i < all.length; i++) if (range.intersectsNode(all[i])) return all[i];
    return null;
  }
  // The part of a range inside one box: a triple-click, or a drag that runs on into the buttons or
  // the next section, still quotes only this item's text.
  function within(range, box) {
    var inside = document.createRange();
    inside.selectNodeContents(box);
    var r = range.cloneRange();
    if (r.compareBoundaryPoints(Range.START_TO_START, inside) < 0) r.setStart(inside.startContainer, inside.startOffset);
    if (r.compareBoundaryPoints(Range.END_TO_END, inside) > 0) r.setEnd(inside.endContainer, inside.endOffset);
    return r;
  }
  function selection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    var whole = sel.getRangeAt(0);
    var box = boxOf(whole);
    if (!box) return null;
    var range = within(whole, box);
    var item = itemOf(box);
    var text = range.toString().replace(/\s+/g, ' ').trim();
    if (!item || text === '') return null;
    var offered = ['comment', 'suggest'].filter(function (a) { return actionsFor(item.getAttribute('data-patra-part')).indexOf(a) !== -1; });
    if (offered.length === 0) return null;
    return { item: item, quote: text, range: range, rect: range.getBoundingClientRect(), offered: offered };
  }
  var TOP_CLEARANCE = 80;
  function onSelection(action) {
    var chosen = picked;
    if (!chosen) return;
    hideBar();
    if (action !== 'comment') { act(action, chosen.item, null, {}); return; }
    popFor = chosen.item;
    act('comment', chosen.item, null, { quote: chosen.quote }, pop).then(function () {
      pop.hidden = false;
      place(pop, chosen.range.getBoundingClientRect(), true);
      showQuote(chosen.range);
      pop.scrollIntoView({ block: 'nearest' });
      var box = pop.querySelector('textarea');
      if (box) box.focus({ preventScroll: true });
    });
  }
  var pending = false;
  document.addEventListener('selectionchange', function () {
    if (pending || pop.contains(document.activeElement)) return;
    pending = true;
    setTimeout(function () {
      pending = false;
      picked = selection();
      if (!picked) { hideBar(); return; }
      bar.textContent = '';
      picked.offered.forEach(function (action) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = action === 'comment' ? 'Comment' : 'Suggest edit';
        b.title = action === 'comment' ? 'Comment on the selection (c)' : 'Suggest an edit (s)';
        b.setAttribute('data-patra-sel', action);
        bar.appendChild(b);
      });
      bar.hidden = false;
      // Above the selection, unless the sticky bar at the top of the page would cover it.
      place(bar, picked.rect, picked.rect.top < TOP_CLEARANCE);
    });
  });
  bar.addEventListener('mousedown', function (event) { event.preventDefault(); });
  bar.addEventListener('click', function (event) {
    var b = event.target.closest('[data-patra-sel]');
    if (!b || !picked) return;
    onSelection(b.getAttribute('data-patra-sel'));
  });
  document.body.addEventListener('htmx:afterRequest', function (event) {
    if (pop.contains(event.target) && event.detail.successful) hidePop();
  });
  document.addEventListener('mousedown', function (event) {
    if (!pop.hidden && !pop.contains(event.target) && !bar.contains(event.target)) hidePop();
  });

  // Keyboard.
  var help = document.createElement('div');
  help.className = 'patra-help';
  help.hidden = true;
  help.setAttribute('role', 'dialog');
  help.setAttribute('aria-label', 'Keyboard shortcuts');
  [['j / k', 'next / previous item'], ['e', 'edit'], ['s', 'suggest an edit'], ['c', 'comment (on the selection, if any)'], ['Ctrl+Enter', 'send the open form'], ['r', 'refresh'], ['?', 'this help'], ['Esc', 'close']].forEach(function (row) {
    var line = document.createElement('div');
    var key = document.createElement('kbd');
    key.textContent = row[0];
    line.appendChild(key);
    line.appendChild(document.createTextNode(' ' + row[1]));
    help.appendChild(line);
  });
  document.body.appendChild(help);
  var current = null;
  function items() {
    var main = document.querySelector('main') || document.body;
    return Array.prototype.filter.call(main.querySelectorAll('[data-patra-part][data-patra-key]'), function (el) {
      return !el.hidden && itemOf(el.parentElement) === null;
    });
  }
  function focusItem(el) {
    if (!el) return;
    if (current) current.removeAttribute('data-patra-current');
    current = el;
    el.setAttribute('data-patra-current', '');
    el.scrollIntoView({ block: 'nearest' });
  }
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { hideBar(); hidePop(); help.hidden = true; return; }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      var sending = event.target && event.target.closest && event.target.closest('form[data-patra-form]');
      if (sending) { event.preventDefault(); sending.requestSubmit(); }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    var t = event.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    var list = items();
    var at = current ? list.indexOf(current) : -1;
    if (event.key === 'j') focusItem(list[Math.min(list.length - 1, at + 1)]);
    else if (event.key === 'k') focusItem(list[Math.max(0, at - 1)]);
    else if (event.key === '?') help.hidden = !help.hidden;
    else if (event.key === 'r') refresh();
    else if (event.key === 'c' && picked && !bar.hidden) onSelection('comment');
    else if (current && (event.key === 'e' || event.key === 's' || event.key === 'c')) {
      var name = { e: 'edit', s: 'suggest', c: 'comment' }[event.key];
      var button = current.querySelector('[data-patra-action="' + name + '"]');
      if (button && button.offsetParent !== null) { event.preventDefault(); act(name, current, button); }
    } else return;
    event.preventDefault();
  });
})();
`;
var RUNTIME_STYLES = `
.patra-selbar { position: absolute; z-index: 20; display: flex; gap: 2px; padding: 3px; background: var(--text); border-radius: var(--radius-md); box-shadow: 0 6px 18px rgba(0,0,0,.25); }
.patra-selbar[hidden], .patra-pop[hidden], .patra-help[hidden] { display: none; }
.patra-selbar button { background: transparent; border: 0; color: var(--surface-raised); padding: 4px 10px; font: 500 13px var(--font-ui); cursor: pointer; border-radius: var(--radius-sm); }
.patra-selbar button:hover, .patra-selbar button:focus-visible { background: color-mix(in srgb, var(--surface-raised) 18%, transparent); }
::highlight(patra-quote) { background-color: var(--mark); color: inherit; }
.patra-pop blockquote { margin: 10px 0 4px; padding-left: 8px; border-left: 3px solid var(--mark); color: var(--text-muted); font: italic 13.5px / 1.5 var(--font-reading); max-height: 6.5em; overflow: auto; }
.patra-pop { position: absolute; z-index: 20; width: min(420px, calc(100vw - 32px)); background: var(--surface-raised); border: 1px solid var(--intent-primary); border-radius: var(--radius-md); padding: 4px 14px 14px; box-shadow: 0 8px 24px rgba(0,0,0,.2); }
.patra-status:empty { display: none; }
.patra-status { position: fixed; z-index: 30; left: 16px; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); max-width: min(520px, calc(100vw - 32px)); padding: 8px 12px; background: var(--surface-raised); border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: 0 8px 24px rgba(0,0,0,.2); font: 13.5px var(--font-ui); color: var(--text); }
.patra-status .error { margin: 0; }
.patra-help { position: fixed; z-index: 30; right: 16px; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); display: grid; gap: 4px; padding: 12px 16px; background: var(--surface-raised); border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: 0 8px 24px rgba(0,0,0,.2); font: 13px var(--font-ui); color: var(--text); }
.patra-help kbd { font: 500 12px var(--font-mono); border: 1px solid var(--border); border-bottom-width: 2px; border-radius: var(--radius-sm); padding: 0 5px; }
[data-patra-current] { outline: 2px solid var(--intent-primary); outline-offset: 6px; border-radius: var(--radius-sm); }
`;
// node_modules/.bun/@cntxt-labs+patra-serve@..+vendor+patra+cntxt-labs-patra-serve-0.0.0.tgz/node_modules/@cntxt-labs/patra-serve/src/server.ts
import { randomUUID as randomUUID3 } from "crypto";

// node_modules/.bun/htmx.org@2.0.4/node_modules/htmx.org/dist/htmx.min.js
var htmx_min_default = 'var htmx=function(){"use strict";const Q={onLoad:null,process:null,on:null,off:null,trigger:null,ajax:null,find:null,findAll:null,closest:null,values:function(e,t){const n=cn(e,t||"post");return n.values},remove:null,addClass:null,removeClass:null,toggleClass:null,takeClass:null,swap:null,defineExtension:null,removeExtension:null,logAll:null,logNone:null,logger:null,config:{historyEnabled:true,historyCacheSize:10,refreshOnHistoryMiss:false,defaultSwapStyle:"innerHTML",defaultSwapDelay:0,defaultSettleDelay:20,includeIndicatorStyles:true,indicatorClass:"htmx-indicator",requestClass:"htmx-request",addedClass:"htmx-added",settlingClass:"htmx-settling",swappingClass:"htmx-swapping",allowEval:true,allowScriptTags:true,inlineScriptNonce:"",inlineStyleNonce:"",attributesToSettle:["class","style","width","height"],withCredentials:false,timeout:0,wsReconnectDelay:"full-jitter",wsBinaryType:"blob",disableSelector:"[hx-disable], [data-hx-disable]",scrollBehavior:"instant",defaultFocusScroll:false,getCacheBusterParam:false,globalViewTransitions:false,methodsThatUseUrlParams:["get","delete"],selfRequestsOnly:true,ignoreTitle:false,scrollIntoViewOnBoost:true,triggerSpecsCache:null,disableInheritance:false,responseHandling:[{code:"204",swap:false},{code:"[23]..",swap:true},{code:"[45]..",swap:false,error:true}],allowNestedOobSwaps:true},parseInterval:null,_:null,version:"2.0.4"};Q.onLoad=j;Q.process=kt;Q.on=ye;Q.off=be;Q.trigger=he;Q.ajax=Rn;Q.find=u;Q.findAll=x;Q.closest=g;Q.remove=z;Q.addClass=K;Q.removeClass=G;Q.toggleClass=W;Q.takeClass=Z;Q.swap=$e;Q.defineExtension=Fn;Q.removeExtension=Bn;Q.logAll=V;Q.logNone=_;Q.parseInterval=d;Q._=e;const n={addTriggerHandler:St,bodyContains:le,canAccessLocalStorage:B,findThisElement:Se,filterValues:hn,swap:$e,hasAttribute:s,getAttributeValue:te,getClosestAttributeValue:re,getClosestMatch:o,getExpressionVars:En,getHeaders:fn,getInputValues:cn,getInternalData:ie,getSwapSpecification:gn,getTriggerSpecs:st,getTarget:Ee,makeFragment:P,mergeObjects:ce,makeSettleInfo:xn,oobSwap:He,querySelectorExt:ae,settleImmediately:Kt,shouldCancel:ht,triggerEvent:he,triggerErrorEvent:fe,withExtensions:Ft};const r=["get","post","put","delete","patch"];const H=r.map(function(e){return"[hx-"+e+"], [data-hx-"+e+"]"}).join(", ");function d(e){if(e==undefined){return undefined}let t=NaN;if(e.slice(-2)=="ms"){t=parseFloat(e.slice(0,-2))}else if(e.slice(-1)=="s"){t=parseFloat(e.slice(0,-1))*1e3}else if(e.slice(-1)=="m"){t=parseFloat(e.slice(0,-1))*1e3*60}else{t=parseFloat(e)}return isNaN(t)?undefined:t}function ee(e,t){return e instanceof Element&&e.getAttribute(t)}function s(e,t){return!!e.hasAttribute&&(e.hasAttribute(t)||e.hasAttribute("data-"+t))}function te(e,t){return ee(e,t)||ee(e,"data-"+t)}function c(e){const t=e.parentElement;if(!t&&e.parentNode instanceof ShadowRoot)return e.parentNode;return t}function ne(){return document}function m(e,t){return e.getRootNode?e.getRootNode({composed:t}):ne()}function o(e,t){while(e&&!t(e)){e=c(e)}return e||null}function i(e,t,n){const r=te(t,n);const o=te(t,"hx-disinherit");var i=te(t,"hx-inherit");if(e!==t){if(Q.config.disableInheritance){if(i&&(i==="*"||i.split(" ").indexOf(n)>=0)){return r}else{return null}}if(o&&(o==="*"||o.split(" ").indexOf(n)>=0)){return"unset"}}return r}function re(t,n){let r=null;o(t,function(e){return!!(r=i(t,ue(e),n))});if(r!=="unset"){return r}}function h(e,t){const n=e instanceof Element&&(e.matches||e.matchesSelector||e.msMatchesSelector||e.mozMatchesSelector||e.webkitMatchesSelector||e.oMatchesSelector);return!!n&&n.call(e,t)}function T(e){const t=/<([a-z][^\\/\\0>\\x20\\t\\r\\n\\f]*)/i;const n=t.exec(e);if(n){return n[1].toLowerCase()}else{return""}}function q(e){const t=new DOMParser;return t.parseFromString(e,"text/html")}function L(e,t){while(t.childNodes.length>0){e.append(t.childNodes[0])}}function A(e){const t=ne().createElement("script");se(e.attributes,function(e){t.setAttribute(e.name,e.value)});t.textContent=e.textContent;t.async=false;if(Q.config.inlineScriptNonce){t.nonce=Q.config.inlineScriptNonce}return t}function N(e){return e.matches("script")&&(e.type==="text/javascript"||e.type==="module"||e.type==="")}function I(e){Array.from(e.querySelectorAll("script")).forEach(e=>{if(N(e)){const t=A(e);const n=e.parentNode;try{n.insertBefore(t,e)}catch(e){O(e)}finally{e.remove()}}})}function P(e){const t=e.replace(/<head(\\s[^>]*)?>[\\s\\S]*?<\\/head>/i,"");const n=T(t);let r;if(n==="html"){r=new DocumentFragment;const i=q(e);L(r,i.body);r.title=i.title}else if(n==="body"){r=new DocumentFragment;const i=q(t);L(r,i.body);r.title=i.title}else{const i=q(\'<body><template class="internal-htmx-wrapper">\'+t+"</template></body>");r=i.querySelector("template").content;r.title=i.title;var o=r.querySelector("title");if(o&&o.parentNode===r){o.remove();r.title=o.innerText}}if(r){if(Q.config.allowScriptTags){I(r)}else{r.querySelectorAll("script").forEach(e=>e.remove())}}return r}function oe(e){if(e){e()}}function t(e,t){return Object.prototype.toString.call(e)==="[object "+t+"]"}function k(e){return typeof e==="function"}function D(e){return t(e,"Object")}function ie(e){const t="htmx-internal-data";let n=e[t];if(!n){n=e[t]={}}return n}function M(t){const n=[];if(t){for(let e=0;e<t.length;e++){n.push(t[e])}}return n}function se(t,n){if(t){for(let e=0;e<t.length;e++){n(t[e])}}}function X(e){const t=e.getBoundingClientRect();const n=t.top;const r=t.bottom;return n<window.innerHeight&&r>=0}function le(e){return e.getRootNode({composed:true})===document}function F(e){return e.trim().split(/\\s+/)}function ce(e,t){for(const n in t){if(t.hasOwnProperty(n)){e[n]=t[n]}}return e}function S(e){try{return JSON.parse(e)}catch(e){O(e);return null}}function B(){const e="htmx:localStorageTest";try{localStorage.setItem(e,e);localStorage.removeItem(e);return true}catch(e){return false}}function U(t){try{const e=new URL(t);if(e){t=e.pathname+e.search}if(!/^\\/$/.test(t)){t=t.replace(/\\/+$/,"")}return t}catch(e){return t}}function e(e){return vn(ne().body,function(){return eval(e)})}function j(t){const e=Q.on("htmx:load",function(e){t(e.detail.elt)});return e}function V(){Q.logger=function(e,t,n){if(console){console.log(t,e,n)}}}function _(){Q.logger=null}function u(e,t){if(typeof e!=="string"){return e.querySelector(t)}else{return u(ne(),e)}}function x(e,t){if(typeof e!=="string"){return e.querySelectorAll(t)}else{return x(ne(),e)}}function E(){return window}function z(e,t){e=y(e);if(t){E().setTimeout(function(){z(e);e=null},t)}else{c(e).removeChild(e)}}function ue(e){return e instanceof Element?e:null}function $(e){return e instanceof HTMLElement?e:null}function J(e){return typeof e==="string"?e:null}function f(e){return e instanceof Element||e instanceof Document||e instanceof DocumentFragment?e:null}function K(e,t,n){e=ue(y(e));if(!e){return}if(n){E().setTimeout(function(){K(e,t);e=null},n)}else{e.classList&&e.classList.add(t)}}function G(e,t,n){let r=ue(y(e));if(!r){return}if(n){E().setTimeout(function(){G(r,t);r=null},n)}else{if(r.classList){r.classList.remove(t);if(r.classList.length===0){r.removeAttribute("class")}}}}function W(e,t){e=y(e);e.classList.toggle(t)}function Z(e,t){e=y(e);se(e.parentElement.children,function(e){G(e,t)});K(ue(e),t)}function g(e,t){e=ue(y(e));if(e&&e.closest){return e.closest(t)}else{do{if(e==null||h(e,t)){return e}}while(e=e&&ue(c(e)));return null}}function l(e,t){return e.substring(0,t.length)===t}function Y(e,t){return e.substring(e.length-t.length)===t}function ge(e){const t=e.trim();if(l(t,"<")&&Y(t,"/>")){return t.substring(1,t.length-2)}else{return t}}function p(t,r,n){if(r.indexOf("global ")===0){return p(t,r.slice(7),true)}t=y(t);const o=[];{let t=0;let n=0;for(let e=0;e<r.length;e++){const l=r[e];if(l===","&&t===0){o.push(r.substring(n,e));n=e+1;continue}if(l==="<"){t++}else if(l==="/"&&e<r.length-1&&r[e+1]===">"){t--}}if(n<r.length){o.push(r.substring(n))}}const i=[];const s=[];while(o.length>0){const r=ge(o.shift());let e;if(r.indexOf("closest ")===0){e=g(ue(t),ge(r.substr(8)))}else if(r.indexOf("find ")===0){e=u(f(t),ge(r.substr(5)))}else if(r==="next"||r==="nextElementSibling"){e=ue(t).nextElementSibling}else if(r.indexOf("next ")===0){e=pe(t,ge(r.substr(5)),!!n)}else if(r==="previous"||r==="previousElementSibling"){e=ue(t).previousElementSibling}else if(r.indexOf("previous ")===0){e=me(t,ge(r.substr(9)),!!n)}else if(r==="document"){e=document}else if(r==="window"){e=window}else if(r==="body"){e=document.body}else if(r==="root"){e=m(t,!!n)}else if(r==="host"){e=t.getRootNode().host}else{s.push(r)}if(e){i.push(e)}}if(s.length>0){const e=s.join(",");const c=f(m(t,!!n));i.push(...M(c.querySelectorAll(e)))}return i}var pe=function(t,e,n){const r=f(m(t,n)).querySelectorAll(e);for(let e=0;e<r.length;e++){const o=r[e];if(o.compareDocumentPosition(t)===Node.DOCUMENT_POSITION_PRECEDING){return o}}};var me=function(t,e,n){const r=f(m(t,n)).querySelectorAll(e);for(let e=r.length-1;e>=0;e--){const o=r[e];if(o.compareDocumentPosition(t)===Node.DOCUMENT_POSITION_FOLLOWING){return o}}};function ae(e,t){if(typeof e!=="string"){return p(e,t)[0]}else{return p(ne().body,e)[0]}}function y(e,t){if(typeof e==="string"){return u(f(t)||document,e)}else{return e}}function xe(e,t,n,r){if(k(t)){return{target:ne().body,event:J(e),listener:t,options:n}}else{return{target:y(e),event:J(t),listener:n,options:r}}}function ye(t,n,r,o){Vn(function(){const e=xe(t,n,r,o);e.target.addEventListener(e.event,e.listener,e.options)});const e=k(n);return e?n:r}function be(t,n,r){Vn(function(){const e=xe(t,n,r);e.target.removeEventListener(e.event,e.listener)});return k(n)?n:r}const ve=ne().createElement("output");function we(e,t){const n=re(e,t);if(n){if(n==="this"){return[Se(e,t)]}else{const r=p(e,n);if(r.length===0){O(\'The selector "\'+n+\'" on \'+t+" returned no matches!");return[ve]}else{return r}}}}function Se(e,t){return ue(o(e,function(e){return te(ue(e),t)!=null}))}function Ee(e){const t=re(e,"hx-target");if(t){if(t==="this"){return Se(e,"hx-target")}else{return ae(e,t)}}else{const n=ie(e);if(n.boosted){return ne().body}else{return e}}}function Ce(t){const n=Q.config.attributesToSettle;for(let e=0;e<n.length;e++){if(t===n[e]){return true}}return false}function Oe(t,n){se(t.attributes,function(e){if(!n.hasAttribute(e.name)&&Ce(e.name)){t.removeAttribute(e.name)}});se(n.attributes,function(e){if(Ce(e.name)){t.setAttribute(e.name,e.value)}})}function Re(t,e){const n=Un(e);for(let e=0;e<n.length;e++){const r=n[e];try{if(r.isInlineSwap(t)){return true}}catch(e){O(e)}}return t==="outerHTML"}function He(e,o,i,t){t=t||ne();let n="#"+ee(o,"id");let s="outerHTML";if(e==="true"){}else if(e.indexOf(":")>0){s=e.substring(0,e.indexOf(":"));n=e.substring(e.indexOf(":")+1)}else{s=e}o.removeAttribute("hx-swap-oob");o.removeAttribute("data-hx-swap-oob");const r=p(t,n,false);if(r){se(r,function(e){let t;const n=o.cloneNode(true);t=ne().createDocumentFragment();t.appendChild(n);if(!Re(s,e)){t=f(n)}const r={shouldSwap:true,target:e,fragment:t};if(!he(e,"htmx:oobBeforeSwap",r))return;e=r.target;if(r.shouldSwap){qe(t);_e(s,e,e,t,i);Te()}se(i.elts,function(e){he(e,"htmx:oobAfterSwap",r)})});o.parentNode.removeChild(o)}else{o.parentNode.removeChild(o);fe(ne().body,"htmx:oobErrorNoTarget",{content:o})}return e}function Te(){const e=u("#--htmx-preserve-pantry--");if(e){for(const t of[...e.children]){const n=u("#"+t.id);n.parentNode.moveBefore(t,n);n.remove()}e.remove()}}function qe(e){se(x(e,"[hx-preserve], [data-hx-preserve]"),function(e){const t=te(e,"id");const n=ne().getElementById(t);if(n!=null){if(e.moveBefore){let e=u("#--htmx-preserve-pantry--");if(e==null){ne().body.insertAdjacentHTML("afterend","<div id=\'--htmx-preserve-pantry--\'></div>");e=u("#--htmx-preserve-pantry--")}e.moveBefore(n,null)}else{e.parentNode.replaceChild(n,e)}}})}function Le(l,e,c){se(e.querySelectorAll("[id]"),function(t){const n=ee(t,"id");if(n&&n.length>0){const r=n.replace("\'","\\\\\'");const o=t.tagName.replace(":","\\\\:");const e=f(l);const i=e&&e.querySelector(o+"[id=\'"+r+"\']");if(i&&i!==e){const s=t.cloneNode();Oe(t,i);c.tasks.push(function(){Oe(t,s)})}}})}function Ae(e){return function(){G(e,Q.config.addedClass);kt(ue(e));Ne(f(e));he(e,"htmx:load")}}function Ne(e){const t="[autofocus]";const n=$(h(e,t)?e:e.querySelector(t));if(n!=null){n.focus()}}function a(e,t,n,r){Le(e,n,r);while(n.childNodes.length>0){const o=n.firstChild;K(ue(o),Q.config.addedClass);e.insertBefore(o,t);if(o.nodeType!==Node.TEXT_NODE&&o.nodeType!==Node.COMMENT_NODE){r.tasks.push(Ae(o))}}}function Ie(e,t){let n=0;while(n<e.length){t=(t<<5)-t+e.charCodeAt(n++)|0}return t}function Pe(t){let n=0;if(t.attributes){for(let e=0;e<t.attributes.length;e++){const r=t.attributes[e];if(r.value){n=Ie(r.name,n);n=Ie(r.value,n)}}}return n}function ke(t){const n=ie(t);if(n.onHandlers){for(let e=0;e<n.onHandlers.length;e++){const r=n.onHandlers[e];be(t,r.event,r.listener)}delete n.onHandlers}}function De(e){const t=ie(e);if(t.timeout){clearTimeout(t.timeout)}if(t.listenerInfos){se(t.listenerInfos,function(e){if(e.on){be(e.on,e.trigger,e.listener)}})}ke(e);se(Object.keys(t),function(e){if(e!=="firstInitCompleted")delete t[e]})}function b(e){he(e,"htmx:beforeCleanupElement");De(e);if(e.children){se(e.children,function(e){b(e)})}}function Me(t,e,n){if(t instanceof Element&&t.tagName==="BODY"){return Ve(t,e,n)}let r;const o=t.previousSibling;const i=c(t);if(!i){return}a(i,t,e,n);if(o==null){r=i.firstChild}else{r=o.nextSibling}n.elts=n.elts.filter(function(e){return e!==t});while(r&&r!==t){if(r instanceof Element){n.elts.push(r)}r=r.nextSibling}b(t);if(t instanceof Element){t.remove()}else{t.parentNode.removeChild(t)}}function Xe(e,t,n){return a(e,e.firstChild,t,n)}function Fe(e,t,n){return a(c(e),e,t,n)}function Be(e,t,n){return a(e,null,t,n)}function Ue(e,t,n){return a(c(e),e.nextSibling,t,n)}function je(e){b(e);const t=c(e);if(t){return t.removeChild(e)}}function Ve(e,t,n){const r=e.firstChild;a(e,r,t,n);if(r){while(r.nextSibling){b(r.nextSibling);e.removeChild(r.nextSibling)}b(r);e.removeChild(r)}}function _e(t,e,n,r,o){switch(t){case"none":return;case"outerHTML":Me(n,r,o);return;case"afterbegin":Xe(n,r,o);return;case"beforebegin":Fe(n,r,o);return;case"beforeend":Be(n,r,o);return;case"afterend":Ue(n,r,o);return;case"delete":je(n);return;default:var i=Un(e);for(let e=0;e<i.length;e++){const s=i[e];try{const l=s.handleSwap(t,n,r,o);if(l){if(Array.isArray(l)){for(let e=0;e<l.length;e++){const c=l[e];if(c.nodeType!==Node.TEXT_NODE&&c.nodeType!==Node.COMMENT_NODE){o.tasks.push(Ae(c))}}}return}}catch(e){O(e)}}if(t==="innerHTML"){Ve(n,r,o)}else{_e(Q.config.defaultSwapStyle,e,n,r,o)}}}function ze(e,n,r){var t=x(e,"[hx-swap-oob], [data-hx-swap-oob]");se(t,function(e){if(Q.config.allowNestedOobSwaps||e.parentElement===null){const t=te(e,"hx-swap-oob");if(t!=null){He(t,e,n,r)}}else{e.removeAttribute("hx-swap-oob");e.removeAttribute("data-hx-swap-oob")}});return t.length>0}function $e(e,t,r,o){if(!o){o={}}e=y(e);const i=o.contextElement?m(o.contextElement,false):ne();const n=document.activeElement;let s={};try{s={elt:n,start:n?n.selectionStart:null,end:n?n.selectionEnd:null}}catch(e){}const l=xn(e);if(r.swapStyle==="textContent"){e.textContent=t}else{let n=P(t);l.title=n.title;if(o.selectOOB){const u=o.selectOOB.split(",");for(let t=0;t<u.length;t++){const a=u[t].split(":",2);let e=a[0].trim();if(e.indexOf("#")===0){e=e.substring(1)}const f=a[1]||"true";const h=n.querySelector("#"+e);if(h){He(f,h,l,i)}}}ze(n,l,i);se(x(n,"template"),function(e){if(e.content&&ze(e.content,l,i)){e.remove()}});if(o.select){const d=ne().createDocumentFragment();se(n.querySelectorAll(o.select),function(e){d.appendChild(e)});n=d}qe(n);_e(r.swapStyle,o.contextElement,e,n,l);Te()}if(s.elt&&!le(s.elt)&&ee(s.elt,"id")){const g=document.getElementById(ee(s.elt,"id"));const p={preventScroll:r.focusScroll!==undefined?!r.focusScroll:!Q.config.defaultFocusScroll};if(g){if(s.start&&g.setSelectionRange){try{g.setSelectionRange(s.start,s.end)}catch(e){}}g.focus(p)}}e.classList.remove(Q.config.swappingClass);se(l.elts,function(e){if(e.classList){e.classList.add(Q.config.settlingClass)}he(e,"htmx:afterSwap",o.eventInfo)});if(o.afterSwapCallback){o.afterSwapCallback()}if(!r.ignoreTitle){kn(l.title)}const c=function(){se(l.tasks,function(e){e.call()});se(l.elts,function(e){if(e.classList){e.classList.remove(Q.config.settlingClass)}he(e,"htmx:afterSettle",o.eventInfo)});if(o.anchor){const e=ue(y("#"+o.anchor));if(e){e.scrollIntoView({block:"start",behavior:"auto"})}}yn(l.elts,r);if(o.afterSettleCallback){o.afterSettleCallback()}};if(r.settleDelay>0){E().setTimeout(c,r.settleDelay)}else{c()}}function Je(e,t,n){const r=e.getResponseHeader(t);if(r.indexOf("{")===0){const o=S(r);for(const i in o){if(o.hasOwnProperty(i)){let e=o[i];if(D(e)){n=e.target!==undefined?e.target:n}else{e={value:e}}he(n,i,e)}}}else{const s=r.split(",");for(let e=0;e<s.length;e++){he(n,s[e].trim(),[])}}}const Ke=/\\s/;const v=/[\\s,]/;const Ge=/[_$a-zA-Z]/;const We=/[_$a-zA-Z0-9]/;const Ze=[\'"\',"\'","/"];const w=/[^\\s]/;const Ye=/[{(]/;const Qe=/[})]/;function et(e){const t=[];let n=0;while(n<e.length){if(Ge.exec(e.charAt(n))){var r=n;while(We.exec(e.charAt(n+1))){n++}t.push(e.substring(r,n+1))}else if(Ze.indexOf(e.charAt(n))!==-1){const o=e.charAt(n);var r=n;n++;while(n<e.length&&e.charAt(n)!==o){if(e.charAt(n)==="\\\\"){n++}n++}t.push(e.substring(r,n+1))}else{const i=e.charAt(n);t.push(i)}n++}return t}function tt(e,t,n){return Ge.exec(e.charAt(0))&&e!=="true"&&e!=="false"&&e!=="this"&&e!==n&&t!=="."}function nt(r,o,i){if(o[0]==="["){o.shift();let e=1;let t=" return (function("+i+"){ return (";let n=null;while(o.length>0){const s=o[0];if(s==="]"){e--;if(e===0){if(n===null){t=t+"true"}o.shift();t+=")})";try{const l=vn(r,function(){return Function(t)()},function(){return true});l.source=t;return l}catch(e){fe(ne().body,"htmx:syntax:error",{error:e,source:t});return null}}}else if(s==="["){e++}if(tt(s,n,i)){t+="(("+i+"."+s+") ? ("+i+"."+s+") : (window."+s+"))"}else{t=t+s}n=o.shift()}}}function C(e,t){let n="";while(e.length>0&&!t.test(e[0])){n+=e.shift()}return n}function rt(e){let t;if(e.length>0&&Ye.test(e[0])){e.shift();t=C(e,Qe).trim();e.shift()}else{t=C(e,v)}return t}const ot="input, textarea, select";function it(e,t,n){const r=[];const o=et(t);do{C(o,w);const l=o.length;const c=C(o,/[,\\[\\s]/);if(c!==""){if(c==="every"){const u={trigger:"every"};C(o,w);u.pollInterval=d(C(o,/[,\\[\\s]/));C(o,w);var i=nt(e,o,"event");if(i){u.eventFilter=i}r.push(u)}else{const a={trigger:c};var i=nt(e,o,"event");if(i){a.eventFilter=i}C(o,w);while(o.length>0&&o[0]!==","){const f=o.shift();if(f==="changed"){a.changed=true}else if(f==="once"){a.once=true}else if(f==="consume"){a.consume=true}else if(f==="delay"&&o[0]===":"){o.shift();a.delay=d(C(o,v))}else if(f==="from"&&o[0]===":"){o.shift();if(Ye.test(o[0])){var s=rt(o)}else{var s=C(o,v);if(s==="closest"||s==="find"||s==="next"||s==="previous"){o.shift();const h=rt(o);if(h.length>0){s+=" "+h}}}a.from=s}else if(f==="target"&&o[0]===":"){o.shift();a.target=rt(o)}else if(f==="throttle"&&o[0]===":"){o.shift();a.throttle=d(C(o,v))}else if(f==="queue"&&o[0]===":"){o.shift();a.queue=C(o,v)}else if(f==="root"&&o[0]===":"){o.shift();a[f]=rt(o)}else if(f==="threshold"&&o[0]===":"){o.shift();a[f]=C(o,v)}else{fe(e,"htmx:syntax:error",{token:o.shift()})}C(o,w)}r.push(a)}}if(o.length===l){fe(e,"htmx:syntax:error",{token:o.shift()})}C(o,w)}while(o[0]===","&&o.shift());if(n){n[t]=r}return r}function st(e){const t=te(e,"hx-trigger");let n=[];if(t){const r=Q.config.triggerSpecsCache;n=r&&r[t]||it(e,t,r)}if(n.length>0){return n}else if(h(e,"form")){return[{trigger:"submit"}]}else if(h(e,\'input[type="button"], input[type="submit"]\')){return[{trigger:"click"}]}else if(h(e,ot)){return[{trigger:"change"}]}else{return[{trigger:"click"}]}}function lt(e){ie(e).cancelled=true}function ct(e,t,n){const r=ie(e);r.timeout=E().setTimeout(function(){if(le(e)&&r.cancelled!==true){if(!gt(n,e,Mt("hx:poll:trigger",{triggerSpec:n,target:e}))){t(e)}ct(e,t,n)}},n.pollInterval)}function ut(e){return location.hostname===e.hostname&&ee(e,"href")&&ee(e,"href").indexOf("#")!==0}function at(e){return g(e,Q.config.disableSelector)}function ft(t,n,e){if(t instanceof HTMLAnchorElement&&ut(t)&&(t.target===""||t.target==="_self")||t.tagName==="FORM"&&String(ee(t,"method")).toLowerCase()!=="dialog"){n.boosted=true;let r,o;if(t.tagName==="A"){r="get";o=ee(t,"href")}else{const i=ee(t,"method");r=i?i.toLowerCase():"get";o=ee(t,"action");if(o==null||o===""){o=ne().location.href}if(r==="get"&&o.includes("?")){o=o.replace(/\\?[^#]+/,"")}}e.forEach(function(e){pt(t,function(e,t){const n=ue(e);if(at(n)){b(n);return}de(r,o,n,t)},n,e,true)})}}function ht(e,t){const n=ue(t);if(!n){return false}if(e.type==="submit"||e.type==="click"){if(n.tagName==="FORM"){return true}if(h(n,\'input[type="submit"], button\')&&(h(n,"[form]")||g(n,"form")!==null)){return true}if(n instanceof HTMLAnchorElement&&n.href&&(n.getAttribute("href")==="#"||n.getAttribute("href").indexOf("#")!==0)){return true}}return false}function dt(e,t){return ie(e).boosted&&e instanceof HTMLAnchorElement&&t.type==="click"&&(t.ctrlKey||t.metaKey)}function gt(e,t,n){const r=e.eventFilter;if(r){try{return r.call(t,n)!==true}catch(e){const o=r.source;fe(ne().body,"htmx:eventFilter:error",{error:e,source:o});return true}}return false}function pt(l,c,e,u,a){const f=ie(l);let t;if(u.from){t=p(l,u.from)}else{t=[l]}if(u.changed){if(!("lastValue"in f)){f.lastValue=new WeakMap}t.forEach(function(e){if(!f.lastValue.has(u)){f.lastValue.set(u,new WeakMap)}f.lastValue.get(u).set(e,e.value)})}se(t,function(i){const s=function(e){if(!le(l)){i.removeEventListener(u.trigger,s);return}if(dt(l,e)){return}if(a||ht(e,l)){e.preventDefault()}if(gt(u,l,e)){return}const t=ie(e);t.triggerSpec=u;if(t.handledFor==null){t.handledFor=[]}if(t.handledFor.indexOf(l)<0){t.handledFor.push(l);if(u.consume){e.stopPropagation()}if(u.target&&e.target){if(!h(ue(e.target),u.target)){return}}if(u.once){if(f.triggeredOnce){return}else{f.triggeredOnce=true}}if(u.changed){const n=event.target;const r=n.value;const o=f.lastValue.get(u);if(o.has(n)&&o.get(n)===r){return}o.set(n,r)}if(f.delayed){clearTimeout(f.delayed)}if(f.throttle){return}if(u.throttle>0){if(!f.throttle){he(l,"htmx:trigger");c(l,e);f.throttle=E().setTimeout(function(){f.throttle=null},u.throttle)}}else if(u.delay>0){f.delayed=E().setTimeout(function(){he(l,"htmx:trigger");c(l,e)},u.delay)}else{he(l,"htmx:trigger");c(l,e)}}};if(e.listenerInfos==null){e.listenerInfos=[]}e.listenerInfos.push({trigger:u.trigger,listener:s,on:i});i.addEventListener(u.trigger,s)})}let mt=false;let xt=null;function yt(){if(!xt){xt=function(){mt=true};window.addEventListener("scroll",xt);window.addEventListener("resize",xt);setInterval(function(){if(mt){mt=false;se(ne().querySelectorAll("[hx-trigger*=\'revealed\'],[data-hx-trigger*=\'revealed\']"),function(e){bt(e)})}},200)}}function bt(e){if(!s(e,"data-hx-revealed")&&X(e)){e.setAttribute("data-hx-revealed","true");const t=ie(e);if(t.initHash){he(e,"revealed")}else{e.addEventListener("htmx:afterProcessNode",function(){he(e,"revealed")},{once:true})}}}function vt(e,t,n,r){const o=function(){if(!n.loaded){n.loaded=true;he(e,"htmx:trigger");t(e)}};if(r>0){E().setTimeout(o,r)}else{o()}}function wt(t,n,e){let i=false;se(r,function(r){if(s(t,"hx-"+r)){const o=te(t,"hx-"+r);i=true;n.path=o;n.verb=r;e.forEach(function(e){St(t,e,n,function(e,t){const n=ue(e);if(g(n,Q.config.disableSelector)){b(n);return}de(r,o,n,t)})})}});return i}function St(r,e,t,n){if(e.trigger==="revealed"){yt();pt(r,n,t,e);bt(ue(r))}else if(e.trigger==="intersect"){const o={};if(e.root){o.root=ae(r,e.root)}if(e.threshold){o.threshold=parseFloat(e.threshold)}const i=new IntersectionObserver(function(t){for(let e=0;e<t.length;e++){const n=t[e];if(n.isIntersecting){he(r,"intersect");break}}},o);i.observe(ue(r));pt(ue(r),n,t,e)}else if(!t.firstInitCompleted&&e.trigger==="load"){if(!gt(e,r,Mt("load",{elt:r}))){vt(ue(r),n,t,e.delay)}}else if(e.pollInterval>0){t.polling=true;ct(ue(r),n,e)}else{pt(r,n,t,e)}}function Et(e){const t=ue(e);if(!t){return false}const n=t.attributes;for(let e=0;e<n.length;e++){const r=n[e].name;if(l(r,"hx-on:")||l(r,"data-hx-on:")||l(r,"hx-on-")||l(r,"data-hx-on-")){return true}}return false}const Ct=(new XPathEvaluator).createExpression(\'.//*[@*[ starts-with(name(), "hx-on:") or starts-with(name(), "data-hx-on:") or\'+\' starts-with(name(), "hx-on-") or starts-with(name(), "data-hx-on-") ]]\');function Ot(e,t){if(Et(e)){t.push(ue(e))}const n=Ct.evaluate(e);let r=null;while(r=n.iterateNext())t.push(ue(r))}function Rt(e){const t=[];if(e instanceof DocumentFragment){for(const n of e.childNodes){Ot(n,t)}}else{Ot(e,t)}return t}function Ht(e){if(e.querySelectorAll){const n=", [hx-boost] a, [data-hx-boost] a, a[hx-boost], a[data-hx-boost]";const r=[];for(const i in Mn){const s=Mn[i];if(s.getSelectors){var t=s.getSelectors();if(t){r.push(t)}}}const o=e.querySelectorAll(H+n+", form, [type=\'submit\'],"+" [hx-ext], [data-hx-ext], [hx-trigger], [data-hx-trigger]"+r.flat().map(e=>", "+e).join(""));return o}else{return[]}}function Tt(e){const t=g(ue(e.target),"button, input[type=\'submit\']");const n=Lt(e);if(n){n.lastButtonClicked=t}}function qt(e){const t=Lt(e);if(t){t.lastButtonClicked=null}}function Lt(e){const t=g(ue(e.target),"button, input[type=\'submit\']");if(!t){return}const n=y("#"+ee(t,"form"),t.getRootNode())||g(t,"form");if(!n){return}return ie(n)}function At(e){e.addEventListener("click",Tt);e.addEventListener("focusin",Tt);e.addEventListener("focusout",qt)}function Nt(t,e,n){const r=ie(t);if(!Array.isArray(r.onHandlers)){r.onHandlers=[]}let o;const i=function(e){vn(t,function(){if(at(t)){return}if(!o){o=new Function("event",n)}o.call(t,e)})};t.addEventListener(e,i);r.onHandlers.push({event:e,listener:i})}function It(t){ke(t);for(let e=0;e<t.attributes.length;e++){const n=t.attributes[e].name;const r=t.attributes[e].value;if(l(n,"hx-on")||l(n,"data-hx-on")){const o=n.indexOf("-on")+3;const i=n.slice(o,o+1);if(i==="-"||i===":"){let e=n.slice(o+1);if(l(e,":")){e="htmx"+e}else if(l(e,"-")){e="htmx:"+e.slice(1)}else if(l(e,"htmx-")){e="htmx:"+e.slice(5)}Nt(t,e,r)}}}}function Pt(t){if(g(t,Q.config.disableSelector)){b(t);return}const n=ie(t);const e=Pe(t);if(n.initHash!==e){De(t);n.initHash=e;he(t,"htmx:beforeProcessNode");const r=st(t);const o=wt(t,n,r);if(!o){if(re(t,"hx-boost")==="true"){ft(t,n,r)}else if(s(t,"hx-trigger")){r.forEach(function(e){St(t,e,n,function(){})})}}if(t.tagName==="FORM"||ee(t,"type")==="submit"&&s(t,"form")){At(t)}n.firstInitCompleted=true;he(t,"htmx:afterProcessNode")}}function kt(e){e=y(e);if(g(e,Q.config.disableSelector)){b(e);return}Pt(e);se(Ht(e),function(e){Pt(e)});se(Rt(e),It)}function Dt(e){return e.replace(/([a-z0-9])([A-Z])/g,"$1-$2").toLowerCase()}function Mt(e,t){let n;if(window.CustomEvent&&typeof window.CustomEvent==="function"){n=new CustomEvent(e,{bubbles:true,cancelable:true,composed:true,detail:t})}else{n=ne().createEvent("CustomEvent");n.initCustomEvent(e,true,true,t)}return n}function fe(e,t,n){he(e,t,ce({error:t},n))}function Xt(e){return e==="htmx:afterProcessNode"}function Ft(e,t){se(Un(e),function(e){try{t(e)}catch(e){O(e)}})}function O(e){if(console.error){console.error(e)}else if(console.log){console.log("ERROR: ",e)}}function he(e,t,n){e=y(e);if(n==null){n={}}n.elt=e;const r=Mt(t,n);if(Q.logger&&!Xt(t)){Q.logger(e,t,n)}if(n.error){O(n.error);he(e,"htmx:error",{errorInfo:n})}let o=e.dispatchEvent(r);const i=Dt(t);if(o&&i!==t){const s=Mt(i,r.detail);o=o&&e.dispatchEvent(s)}Ft(ue(e),function(e){o=o&&(e.onEvent(t,r)!==false&&!r.defaultPrevented)});return o}let Bt=location.pathname+location.search;function Ut(){const e=ne().querySelector("[hx-history-elt],[data-hx-history-elt]");return e||ne().body}function jt(t,e){if(!B()){return}const n=_t(e);const r=ne().title;const o=window.scrollY;if(Q.config.historyCacheSize<=0){localStorage.removeItem("htmx-history-cache");return}t=U(t);const i=S(localStorage.getItem("htmx-history-cache"))||[];for(let e=0;e<i.length;e++){if(i[e].url===t){i.splice(e,1);break}}const s={url:t,content:n,title:r,scroll:o};he(ne().body,"htmx:historyItemCreated",{item:s,cache:i});i.push(s);while(i.length>Q.config.historyCacheSize){i.shift()}while(i.length>0){try{localStorage.setItem("htmx-history-cache",JSON.stringify(i));break}catch(e){fe(ne().body,"htmx:historyCacheError",{cause:e,cache:i});i.shift()}}}function Vt(t){if(!B()){return null}t=U(t);const n=S(localStorage.getItem("htmx-history-cache"))||[];for(let e=0;e<n.length;e++){if(n[e].url===t){return n[e]}}return null}function _t(e){const t=Q.config.requestClass;const n=e.cloneNode(true);se(x(n,"."+t),function(e){G(e,t)});se(x(n,"[data-disabled-by-htmx]"),function(e){e.removeAttribute("disabled")});return n.innerHTML}function zt(){const e=Ut();const t=Bt||location.pathname+location.search;let n;try{n=ne().querySelector(\'[hx-history="false" i],[data-hx-history="false" i]\')}catch(e){n=ne().querySelector(\'[hx-history="false"],[data-hx-history="false"]\')}if(!n){he(ne().body,"htmx:beforeHistorySave",{path:t,historyElt:e});jt(t,e)}if(Q.config.historyEnabled)history.replaceState({htmx:true},ne().title,window.location.href)}function $t(e){if(Q.config.getCacheBusterParam){e=e.replace(/org\\.htmx\\.cache-buster=[^&]*&?/,"");if(Y(e,"&")||Y(e,"?")){e=e.slice(0,-1)}}if(Q.config.historyEnabled){history.pushState({htmx:true},"",e)}Bt=e}function Jt(e){if(Q.config.historyEnabled)history.replaceState({htmx:true},"",e);Bt=e}function Kt(e){se(e,function(e){e.call(undefined)})}function Gt(o){const e=new XMLHttpRequest;const i={path:o,xhr:e};he(ne().body,"htmx:historyCacheMiss",i);e.open("GET",o,true);e.setRequestHeader("HX-Request","true");e.setRequestHeader("HX-History-Restore-Request","true");e.setRequestHeader("HX-Current-URL",ne().location.href);e.onload=function(){if(this.status>=200&&this.status<400){he(ne().body,"htmx:historyCacheMissLoad",i);const e=P(this.response);const t=e.querySelector("[hx-history-elt],[data-hx-history-elt]")||e;const n=Ut();const r=xn(n);kn(e.title);qe(e);Ve(n,t,r);Te();Kt(r.tasks);Bt=o;he(ne().body,"htmx:historyRestore",{path:o,cacheMiss:true,serverResponse:this.response})}else{fe(ne().body,"htmx:historyCacheMissLoadError",i)}};e.send()}function Wt(e){zt();e=e||location.pathname+location.search;const t=Vt(e);if(t){const n=P(t.content);const r=Ut();const o=xn(r);kn(t.title);qe(n);Ve(r,n,o);Te();Kt(o.tasks);E().setTimeout(function(){window.scrollTo(0,t.scroll)},0);Bt=e;he(ne().body,"htmx:historyRestore",{path:e,item:t})}else{if(Q.config.refreshOnHistoryMiss){window.location.reload(true)}else{Gt(e)}}}function Zt(e){let t=we(e,"hx-indicator");if(t==null){t=[e]}se(t,function(e){const t=ie(e);t.requestCount=(t.requestCount||0)+1;e.classList.add.call(e.classList,Q.config.requestClass)});return t}function Yt(e){let t=we(e,"hx-disabled-elt");if(t==null){t=[]}se(t,function(e){const t=ie(e);t.requestCount=(t.requestCount||0)+1;e.setAttribute("disabled","");e.setAttribute("data-disabled-by-htmx","")});return t}function Qt(e,t){se(e.concat(t),function(e){const t=ie(e);t.requestCount=(t.requestCount||1)-1});se(e,function(e){const t=ie(e);if(t.requestCount===0){e.classList.remove.call(e.classList,Q.config.requestClass)}});se(t,function(e){const t=ie(e);if(t.requestCount===0){e.removeAttribute("disabled");e.removeAttribute("data-disabled-by-htmx")}})}function en(t,n){for(let e=0;e<t.length;e++){const r=t[e];if(r.isSameNode(n)){return true}}return false}function tn(e){const t=e;if(t.name===""||t.name==null||t.disabled||g(t,"fieldset[disabled]")){return false}if(t.type==="button"||t.type==="submit"||t.tagName==="image"||t.tagName==="reset"||t.tagName==="file"){return false}if(t.type==="checkbox"||t.type==="radio"){return t.checked}return true}function nn(t,e,n){if(t!=null&&e!=null){if(Array.isArray(e)){e.forEach(function(e){n.append(t,e)})}else{n.append(t,e)}}}function rn(t,n,r){if(t!=null&&n!=null){let e=r.getAll(t);if(Array.isArray(n)){e=e.filter(e=>n.indexOf(e)<0)}else{e=e.filter(e=>e!==n)}r.delete(t);se(e,e=>r.append(t,e))}}function on(t,n,r,o,i){if(o==null||en(t,o)){return}else{t.push(o)}if(tn(o)){const s=ee(o,"name");let e=o.value;if(o instanceof HTMLSelectElement&&o.multiple){e=M(o.querySelectorAll("option:checked")).map(function(e){return e.value})}if(o instanceof HTMLInputElement&&o.files){e=M(o.files)}nn(s,e,n);if(i){sn(o,r)}}if(o instanceof HTMLFormElement){se(o.elements,function(e){if(t.indexOf(e)>=0){rn(e.name,e.value,n)}else{t.push(e)}if(i){sn(e,r)}});new FormData(o).forEach(function(e,t){if(e instanceof File&&e.name===""){return}nn(t,e,n)})}}function sn(e,t){const n=e;if(n.willValidate){he(n,"htmx:validation:validate");if(!n.checkValidity()){t.push({elt:n,message:n.validationMessage,validity:n.validity});he(n,"htmx:validation:failed",{message:n.validationMessage,validity:n.validity})}}}function ln(n,e){for(const t of e.keys()){n.delete(t)}e.forEach(function(e,t){n.append(t,e)});return n}function cn(e,t){const n=[];const r=new FormData;const o=new FormData;const i=[];const s=ie(e);if(s.lastButtonClicked&&!le(s.lastButtonClicked)){s.lastButtonClicked=null}let l=e instanceof HTMLFormElement&&e.noValidate!==true||te(e,"hx-validate")==="true";if(s.lastButtonClicked){l=l&&s.lastButtonClicked.formNoValidate!==true}if(t!=="get"){on(n,o,i,g(e,"form"),l)}on(n,r,i,e,l);if(s.lastButtonClicked||e.tagName==="BUTTON"||e.tagName==="INPUT"&&ee(e,"type")==="submit"){const u=s.lastButtonClicked||e;const a=ee(u,"name");nn(a,u.value,o)}const c=we(e,"hx-include");se(c,function(e){on(n,r,i,ue(e),l);if(!h(e,"form")){se(f(e).querySelectorAll(ot),function(e){on(n,r,i,e,l)})}});ln(r,o);return{errors:i,formData:r,values:An(r)}}function un(e,t,n){if(e!==""){e+="&"}if(String(n)==="[object Object]"){n=JSON.stringify(n)}const r=encodeURIComponent(n);e+=encodeURIComponent(t)+"="+r;return e}function an(e){e=qn(e);let n="";e.forEach(function(e,t){n=un(n,t,e)});return n}function fn(e,t,n){const r={"HX-Request":"true","HX-Trigger":ee(e,"id"),"HX-Trigger-Name":ee(e,"name"),"HX-Target":te(t,"id"),"HX-Current-URL":ne().location.href};bn(e,"hx-headers",false,r);if(n!==undefined){r["HX-Prompt"]=n}if(ie(e).boosted){r["HX-Boosted"]="true"}return r}function hn(n,e){const t=re(e,"hx-params");if(t){if(t==="none"){return new FormData}else if(t==="*"){return n}else if(t.indexOf("not ")===0){se(t.slice(4).split(","),function(e){e=e.trim();n.delete(e)});return n}else{const r=new FormData;se(t.split(","),function(t){t=t.trim();if(n.has(t)){n.getAll(t).forEach(function(e){r.append(t,e)})}});return r}}else{return n}}function dn(e){return!!ee(e,"href")&&ee(e,"href").indexOf("#")>=0}function gn(e,t){const n=t||re(e,"hx-swap");const r={swapStyle:ie(e).boosted?"innerHTML":Q.config.defaultSwapStyle,swapDelay:Q.config.defaultSwapDelay,settleDelay:Q.config.defaultSettleDelay};if(Q.config.scrollIntoViewOnBoost&&ie(e).boosted&&!dn(e)){r.show="top"}if(n){const s=F(n);if(s.length>0){for(let e=0;e<s.length;e++){const l=s[e];if(l.indexOf("swap:")===0){r.swapDelay=d(l.slice(5))}else if(l.indexOf("settle:")===0){r.settleDelay=d(l.slice(7))}else if(l.indexOf("transition:")===0){r.transition=l.slice(11)==="true"}else if(l.indexOf("ignoreTitle:")===0){r.ignoreTitle=l.slice(12)==="true"}else if(l.indexOf("scroll:")===0){const c=l.slice(7);var o=c.split(":");const u=o.pop();var i=o.length>0?o.join(":"):null;r.scroll=u;r.scrollTarget=i}else if(l.indexOf("show:")===0){const a=l.slice(5);var o=a.split(":");const f=o.pop();var i=o.length>0?o.join(":"):null;r.show=f;r.showTarget=i}else if(l.indexOf("focus-scroll:")===0){const h=l.slice("focus-scroll:".length);r.focusScroll=h=="true"}else if(e==0){r.swapStyle=l}else{O("Unknown modifier in hx-swap: "+l)}}}}return r}function pn(e){return re(e,"hx-encoding")==="multipart/form-data"||h(e,"form")&&ee(e,"enctype")==="multipart/form-data"}function mn(t,n,r){let o=null;Ft(n,function(e){if(o==null){o=e.encodeParameters(t,r,n)}});if(o!=null){return o}else{if(pn(n)){return ln(new FormData,qn(r))}else{return an(r)}}}function xn(e){return{tasks:[],elts:[e]}}function yn(e,t){const n=e[0];const r=e[e.length-1];if(t.scroll){var o=null;if(t.scrollTarget){o=ue(ae(n,t.scrollTarget))}if(t.scroll==="top"&&(n||o)){o=o||n;o.scrollTop=0}if(t.scroll==="bottom"&&(r||o)){o=o||r;o.scrollTop=o.scrollHeight}}if(t.show){var o=null;if(t.showTarget){let e=t.showTarget;if(t.showTarget==="window"){e="body"}o=ue(ae(n,e))}if(t.show==="top"&&(n||o)){o=o||n;o.scrollIntoView({block:"start",behavior:Q.config.scrollBehavior})}if(t.show==="bottom"&&(r||o)){o=o||r;o.scrollIntoView({block:"end",behavior:Q.config.scrollBehavior})}}}function bn(r,e,o,i){if(i==null){i={}}if(r==null){return i}const s=te(r,e);if(s){let e=s.trim();let t=o;if(e==="unset"){return null}if(e.indexOf("javascript:")===0){e=e.slice(11);t=true}else if(e.indexOf("js:")===0){e=e.slice(3);t=true}if(e.indexOf("{")!==0){e="{"+e+"}"}let n;if(t){n=vn(r,function(){return Function("return ("+e+")")()},{})}else{n=S(e)}for(const l in n){if(n.hasOwnProperty(l)){if(i[l]==null){i[l]=n[l]}}}}return bn(ue(c(r)),e,o,i)}function vn(e,t,n){if(Q.config.allowEval){return t()}else{fe(e,"htmx:evalDisallowedError");return n}}function wn(e,t){return bn(e,"hx-vars",true,t)}function Sn(e,t){return bn(e,"hx-vals",false,t)}function En(e){return ce(wn(e),Sn(e))}function Cn(t,n,r){if(r!==null){try{t.setRequestHeader(n,r)}catch(e){t.setRequestHeader(n,encodeURIComponent(r));t.setRequestHeader(n+"-URI-AutoEncoded","true")}}}function On(t){if(t.responseURL&&typeof URL!=="undefined"){try{const e=new URL(t.responseURL);return e.pathname+e.search}catch(e){fe(ne().body,"htmx:badResponseUrl",{url:t.responseURL})}}}function R(e,t){return t.test(e.getAllResponseHeaders())}function Rn(t,n,r){t=t.toLowerCase();if(r){if(r instanceof Element||typeof r==="string"){return de(t,n,null,null,{targetOverride:y(r)||ve,returnPromise:true})}else{let e=y(r.target);if(r.target&&!e||r.source&&!e&&!y(r.source)){e=ve}return de(t,n,y(r.source),r.event,{handler:r.handler,headers:r.headers,values:r.values,targetOverride:e,swapOverride:r.swap,select:r.select,returnPromise:true})}}else{return de(t,n,null,null,{returnPromise:true})}}function Hn(e){const t=[];while(e){t.push(e);e=e.parentElement}return t}function Tn(e,t,n){let r;let o;if(typeof URL==="function"){o=new URL(t,document.location.href);const i=document.location.origin;r=i===o.origin}else{o=t;r=l(t,document.location.origin)}if(Q.config.selfRequestsOnly){if(!r){return false}}return he(e,"htmx:validateUrl",ce({url:o,sameHost:r},n))}function qn(e){if(e instanceof FormData)return e;const t=new FormData;for(const n in e){if(e.hasOwnProperty(n)){if(e[n]&&typeof e[n].forEach==="function"){e[n].forEach(function(e){t.append(n,e)})}else if(typeof e[n]==="object"&&!(e[n]instanceof Blob)){t.append(n,JSON.stringify(e[n]))}else{t.append(n,e[n])}}}return t}function Ln(r,o,e){return new Proxy(e,{get:function(t,e){if(typeof e==="number")return t[e];if(e==="length")return t.length;if(e==="push"){return function(e){t.push(e);r.append(o,e)}}if(typeof t[e]==="function"){return function(){t[e].apply(t,arguments);r.delete(o);t.forEach(function(e){r.append(o,e)})}}if(t[e]&&t[e].length===1){return t[e][0]}else{return t[e]}},set:function(e,t,n){e[t]=n;r.delete(o);e.forEach(function(e){r.append(o,e)});return true}})}function An(o){return new Proxy(o,{get:function(e,t){if(typeof t==="symbol"){const r=Reflect.get(e,t);if(typeof r==="function"){return function(){return r.apply(o,arguments)}}else{return r}}if(t==="toJSON"){return()=>Object.fromEntries(o)}if(t in e){if(typeof e[t]==="function"){return function(){return o[t].apply(o,arguments)}}else{return e[t]}}const n=o.getAll(t);if(n.length===0){return undefined}else if(n.length===1){return n[0]}else{return Ln(e,t,n)}},set:function(t,n,e){if(typeof n!=="string"){return false}t.delete(n);if(e&&typeof e.forEach==="function"){e.forEach(function(e){t.append(n,e)})}else if(typeof e==="object"&&!(e instanceof Blob)){t.append(n,JSON.stringify(e))}else{t.append(n,e)}return true},deleteProperty:function(e,t){if(typeof t==="string"){e.delete(t)}return true},ownKeys:function(e){return Reflect.ownKeys(Object.fromEntries(e))},getOwnPropertyDescriptor:function(e,t){return Reflect.getOwnPropertyDescriptor(Object.fromEntries(e),t)}})}function de(t,n,r,o,i,D){let s=null;let l=null;i=i!=null?i:{};if(i.returnPromise&&typeof Promise!=="undefined"){var e=new Promise(function(e,t){s=e;l=t})}if(r==null){r=ne().body}const M=i.handler||Dn;const X=i.select||null;if(!le(r)){oe(s);return e}const c=i.targetOverride||ue(Ee(r));if(c==null||c==ve){fe(r,"htmx:targetError",{target:te(r,"hx-target")});oe(l);return e}let u=ie(r);const a=u.lastButtonClicked;if(a){const L=ee(a,"formaction");if(L!=null){n=L}const A=ee(a,"formmethod");if(A!=null){if(A.toLowerCase()!=="dialog"){t=A}}}const f=re(r,"hx-confirm");if(D===undefined){const K=function(e){return de(t,n,r,o,i,!!e)};const G={target:c,elt:r,path:n,verb:t,triggeringEvent:o,etc:i,issueRequest:K,question:f};if(he(r,"htmx:confirm",G)===false){oe(s);return e}}let h=r;let d=re(r,"hx-sync");let g=null;let F=false;if(d){const N=d.split(":");const I=N[0].trim();if(I==="this"){h=Se(r,"hx-sync")}else{h=ue(ae(r,I))}d=(N[1]||"drop").trim();u=ie(h);if(d==="drop"&&u.xhr&&u.abortable!==true){oe(s);return e}else if(d==="abort"){if(u.xhr){oe(s);return e}else{F=true}}else if(d==="replace"){he(h,"htmx:abort")}else if(d.indexOf("queue")===0){const W=d.split(" ");g=(W[1]||"last").trim()}}if(u.xhr){if(u.abortable){he(h,"htmx:abort")}else{if(g==null){if(o){const P=ie(o);if(P&&P.triggerSpec&&P.triggerSpec.queue){g=P.triggerSpec.queue}}if(g==null){g="last"}}if(u.queuedRequests==null){u.queuedRequests=[]}if(g==="first"&&u.queuedRequests.length===0){u.queuedRequests.push(function(){de(t,n,r,o,i)})}else if(g==="all"){u.queuedRequests.push(function(){de(t,n,r,o,i)})}else if(g==="last"){u.queuedRequests=[];u.queuedRequests.push(function(){de(t,n,r,o,i)})}oe(s);return e}}const p=new XMLHttpRequest;u.xhr=p;u.abortable=F;const m=function(){u.xhr=null;u.abortable=false;if(u.queuedRequests!=null&&u.queuedRequests.length>0){const e=u.queuedRequests.shift();e()}};const B=re(r,"hx-prompt");if(B){var x=prompt(B);if(x===null||!he(r,"htmx:prompt",{prompt:x,target:c})){oe(s);m();return e}}if(f&&!D){if(!confirm(f)){oe(s);m();return e}}let y=fn(r,c,x);if(t!=="get"&&!pn(r)){y["Content-Type"]="application/x-www-form-urlencoded"}if(i.headers){y=ce(y,i.headers)}const U=cn(r,t);let b=U.errors;const j=U.formData;if(i.values){ln(j,qn(i.values))}const V=qn(En(r));const v=ln(j,V);let w=hn(v,r);if(Q.config.getCacheBusterParam&&t==="get"){w.set("org.htmx.cache-buster",ee(c,"id")||"true")}if(n==null||n===""){n=ne().location.href}const S=bn(r,"hx-request");const _=ie(r).boosted;let E=Q.config.methodsThatUseUrlParams.indexOf(t)>=0;const C={boosted:_,useUrlParams:E,formData:w,parameters:An(w),unfilteredFormData:v,unfilteredParameters:An(v),headers:y,target:c,verb:t,errors:b,withCredentials:i.credentials||S.credentials||Q.config.withCredentials,timeout:i.timeout||S.timeout||Q.config.timeout,path:n,triggeringEvent:o};if(!he(r,"htmx:configRequest",C)){oe(s);m();return e}n=C.path;t=C.verb;y=C.headers;w=qn(C.parameters);b=C.errors;E=C.useUrlParams;if(b&&b.length>0){he(r,"htmx:validation:halted",C);oe(s);m();return e}const z=n.split("#");const $=z[0];const O=z[1];let R=n;if(E){R=$;const Z=!w.keys().next().done;if(Z){if(R.indexOf("?")<0){R+="?"}else{R+="&"}R+=an(w);if(O){R+="#"+O}}}if(!Tn(r,R,C)){fe(r,"htmx:invalidPath",C);oe(l);return e}p.open(t.toUpperCase(),R,true);p.overrideMimeType("text/html");p.withCredentials=C.withCredentials;p.timeout=C.timeout;if(S.noHeaders){}else{for(const k in y){if(y.hasOwnProperty(k)){const Y=y[k];Cn(p,k,Y)}}}const H={xhr:p,target:c,requestConfig:C,etc:i,boosted:_,select:X,pathInfo:{requestPath:n,finalRequestPath:R,responsePath:null,anchor:O}};p.onload=function(){try{const t=Hn(r);H.pathInfo.responsePath=On(p);M(r,H);if(H.keepIndicators!==true){Qt(T,q)}he(r,"htmx:afterRequest",H);he(r,"htmx:afterOnLoad",H);if(!le(r)){let e=null;while(t.length>0&&e==null){const n=t.shift();if(le(n)){e=n}}if(e){he(e,"htmx:afterRequest",H);he(e,"htmx:afterOnLoad",H)}}oe(s);m()}catch(e){fe(r,"htmx:onLoadError",ce({error:e},H));throw e}};p.onerror=function(){Qt(T,q);fe(r,"htmx:afterRequest",H);fe(r,"htmx:sendError",H);oe(l);m()};p.onabort=function(){Qt(T,q);fe(r,"htmx:afterRequest",H);fe(r,"htmx:sendAbort",H);oe(l);m()};p.ontimeout=function(){Qt(T,q);fe(r,"htmx:afterRequest",H);fe(r,"htmx:timeout",H);oe(l);m()};if(!he(r,"htmx:beforeRequest",H)){oe(s);m();return e}var T=Zt(r);var q=Yt(r);se(["loadstart","loadend","progress","abort"],function(t){se([p,p.upload],function(e){e.addEventListener(t,function(e){he(r,"htmx:xhr:"+t,{lengthComputable:e.lengthComputable,loaded:e.loaded,total:e.total})})})});he(r,"htmx:beforeSend",H);const J=E?null:mn(p,r,w);p.send(J);return e}function Nn(e,t){const n=t.xhr;let r=null;let o=null;if(R(n,/HX-Push:/i)){r=n.getResponseHeader("HX-Push");o="push"}else if(R(n,/HX-Push-Url:/i)){r=n.getResponseHeader("HX-Push-Url");o="push"}else if(R(n,/HX-Replace-Url:/i)){r=n.getResponseHeader("HX-Replace-Url");o="replace"}if(r){if(r==="false"){return{}}else{return{type:o,path:r}}}const i=t.pathInfo.finalRequestPath;const s=t.pathInfo.responsePath;const l=re(e,"hx-push-url");const c=re(e,"hx-replace-url");const u=ie(e).boosted;let a=null;let f=null;if(l){a="push";f=l}else if(c){a="replace";f=c}else if(u){a="push";f=s||i}if(f){if(f==="false"){return{}}if(f==="true"){f=s||i}if(t.pathInfo.anchor&&f.indexOf("#")===-1){f=f+"#"+t.pathInfo.anchor}return{type:a,path:f}}else{return{}}}function In(e,t){var n=new RegExp(e.code);return n.test(t.toString(10))}function Pn(e){for(var t=0;t<Q.config.responseHandling.length;t++){var n=Q.config.responseHandling[t];if(In(n,e.status)){return n}}return{swap:false}}function kn(e){if(e){const t=u("title");if(t){t.innerHTML=e}else{window.document.title=e}}}function Dn(o,i){const s=i.xhr;let l=i.target;const e=i.etc;const c=i.select;if(!he(o,"htmx:beforeOnLoad",i))return;if(R(s,/HX-Trigger:/i)){Je(s,"HX-Trigger",o)}if(R(s,/HX-Location:/i)){zt();let e=s.getResponseHeader("HX-Location");var t;if(e.indexOf("{")===0){t=S(e);e=t.path;delete t.path}Rn("get",e,t).then(function(){$t(e)});return}const n=R(s,/HX-Refresh:/i)&&s.getResponseHeader("HX-Refresh")==="true";if(R(s,/HX-Redirect:/i)){i.keepIndicators=true;location.href=s.getResponseHeader("HX-Redirect");n&&location.reload();return}if(n){i.keepIndicators=true;location.reload();return}if(R(s,/HX-Retarget:/i)){if(s.getResponseHeader("HX-Retarget")==="this"){i.target=o}else{i.target=ue(ae(o,s.getResponseHeader("HX-Retarget")))}}const u=Nn(o,i);const r=Pn(s);const a=r.swap;let f=!!r.error;let h=Q.config.ignoreTitle||r.ignoreTitle;let d=r.select;if(r.target){i.target=ue(ae(o,r.target))}var g=e.swapOverride;if(g==null&&r.swapOverride){g=r.swapOverride}if(R(s,/HX-Retarget:/i)){if(s.getResponseHeader("HX-Retarget")==="this"){i.target=o}else{i.target=ue(ae(o,s.getResponseHeader("HX-Retarget")))}}if(R(s,/HX-Reswap:/i)){g=s.getResponseHeader("HX-Reswap")}var p=s.response;var m=ce({shouldSwap:a,serverResponse:p,isError:f,ignoreTitle:h,selectOverride:d,swapOverride:g},i);if(r.event&&!he(l,r.event,m))return;if(!he(l,"htmx:beforeSwap",m))return;l=m.target;p=m.serverResponse;f=m.isError;h=m.ignoreTitle;d=m.selectOverride;g=m.swapOverride;i.target=l;i.failed=f;i.successful=!f;if(m.shouldSwap){if(s.status===286){lt(o)}Ft(o,function(e){p=e.transformResponse(p,s,o)});if(u.type){zt()}var x=gn(o,g);if(!x.hasOwnProperty("ignoreTitle")){x.ignoreTitle=h}l.classList.add(Q.config.swappingClass);let n=null;let r=null;if(c){d=c}if(R(s,/HX-Reselect:/i)){d=s.getResponseHeader("HX-Reselect")}const y=re(o,"hx-select-oob");const b=re(o,"hx-select");let e=function(){try{if(u.type){he(ne().body,"htmx:beforeHistoryUpdate",ce({history:u},i));if(u.type==="push"){$t(u.path);he(ne().body,"htmx:pushedIntoHistory",{path:u.path})}else{Jt(u.path);he(ne().body,"htmx:replacedInHistory",{path:u.path})}}$e(l,p,x,{select:d||b,selectOOB:y,eventInfo:i,anchor:i.pathInfo.anchor,contextElement:o,afterSwapCallback:function(){if(R(s,/HX-Trigger-After-Swap:/i)){let e=o;if(!le(o)){e=ne().body}Je(s,"HX-Trigger-After-Swap",e)}},afterSettleCallback:function(){if(R(s,/HX-Trigger-After-Settle:/i)){let e=o;if(!le(o)){e=ne().body}Je(s,"HX-Trigger-After-Settle",e)}oe(n)}})}catch(e){fe(o,"htmx:swapError",i);oe(r);throw e}};let t=Q.config.globalViewTransitions;if(x.hasOwnProperty("transition")){t=x.transition}if(t&&he(o,"htmx:beforeTransition",i)&&typeof Promise!=="undefined"&&document.startViewTransition){const v=new Promise(function(e,t){n=e;r=t});const w=e;e=function(){document.startViewTransition(function(){w();return v})}}if(x.swapDelay>0){E().setTimeout(e,x.swapDelay)}else{e()}}if(f){fe(o,"htmx:responseError",ce({error:"Response Status Error Code "+s.status+" from "+i.pathInfo.requestPath},i))}}const Mn={};function Xn(){return{init:function(e){return null},getSelectors:function(){return null},onEvent:function(e,t){return true},transformResponse:function(e,t,n){return e},isInlineSwap:function(e){return false},handleSwap:function(e,t,n,r){return false},encodeParameters:function(e,t,n){return null}}}function Fn(e,t){if(t.init){t.init(n)}Mn[e]=ce(Xn(),t)}function Bn(e){delete Mn[e]}function Un(e,n,r){if(n==undefined){n=[]}if(e==undefined){return n}if(r==undefined){r=[]}const t=te(e,"hx-ext");if(t){se(t.split(","),function(e){e=e.replace(/ /g,"");if(e.slice(0,7)=="ignore:"){r.push(e.slice(7));return}if(r.indexOf(e)<0){const t=Mn[e];if(t&&n.indexOf(t)<0){n.push(t)}}})}return Un(ue(c(e)),n,r)}var jn=false;ne().addEventListener("DOMContentLoaded",function(){jn=true});function Vn(e){if(jn||ne().readyState==="complete"){e()}else{ne().addEventListener("DOMContentLoaded",e)}}function _n(){if(Q.config.includeIndicatorStyles!==false){const e=Q.config.inlineStyleNonce?` nonce="${Q.config.inlineStyleNonce}"`:"";ne().head.insertAdjacentHTML("beforeend","<style"+e+">      ."+Q.config.indicatorClass+"{opacity:0}      ."+Q.config.requestClass+" ."+Q.config.indicatorClass+"{opacity:1; transition: opacity 200ms ease-in;}      ."+Q.config.requestClass+"."+Q.config.indicatorClass+"{opacity:1; transition: opacity 200ms ease-in;}      </style>")}}function zn(){const e=ne().querySelector(\'meta[name="htmx-config"]\');if(e){return S(e.content)}else{return null}}function $n(){const e=zn();if(e){Q.config=ce(Q.config,e)}}Vn(function(){$n();_n();let e=ne().body;kt(e);const t=ne().querySelectorAll("[hx-trigger=\'restored\'],[data-hx-trigger=\'restored\']");e.addEventListener("htmx:abort",function(e){const t=e.target;const n=ie(t);if(n&&n.xhr){n.xhr.abort()}});const n=window.onpopstate?window.onpopstate.bind(window):null;window.onpopstate=function(e){if(e.state&&e.state.htmx){Wt();se(t,function(e){he(e,"htmx:restored",{document:ne(),triggerEvent:he})})}else{if(n){n(e)}}};E().setTimeout(function(){he(e,"htmx:load",{});e=null},0)});return Q}();';

// node_modules/.bun/@cntxt-labs+patra-serve@..+vendor+patra+cntxt-labs-patra-serve-0.0.0.tgz/node_modules/@cntxt-labs/patra-serve/src/server.ts
var HTMX_CONFIG = JSON.stringify({
  responseHandling: [
    { code: "204", swap: false },
    { code: "[23]..", swap: true },
    { code: "4..", swap: true, error: false },
    { code: "...", swap: false, error: true }
  ]
});
var DEFAULT_IDLE_SECONDS = 120;
var RESERVED = new Set(["_key", "_version"]);
function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...headers
    }
  });
}
function errorHtml(message) {
  return `<p class="error" role="alert">${escapeHtml(message)}</p>`;
}
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function itemSelector(part, key) {
  const quote = (v) => `"${v.replaceAll("\\", "\\\\").replaceAll('"', "\\\"")}"`;
  return `[data-patra-part=${quote(part)}][data-patra-key=${quote(key)}]`;
}
function outOfBand(rendered, selector) {
  const attribute = ` hx-swap-oob="outerHTML:${escapeHtml(selector)}"`;
  return rendered.replace(/^(\s*<[a-zA-Z][\w-]*)/, `$1${attribute}`);
}
function serve(options) {
  const token = randomUUID3();
  const templates = new Map(options.templates.map((t) => [t.manifest.id, t]));
  let lastWrite = Promise.resolve();
  const oneAtATime = async (work) => {
    const previous = lastWrite;
    let release = () => {
      return;
    };
    lastWrite = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };
  const config = (template, document) => JSON.stringify({
    template: template.manifest.id,
    document,
    token,
    actions: Object.fromEntries(Object.entries(template.manifest.actions).map(([name, a]) => [
      name,
      { part: a.part, form: a.form !== undefined }
    ]))
  }).replace(/</g, "\\u003c");
  const page = async (template, document) => {
    const content = await options.source.load(template.manifest.id, document);
    if (content === undefined)
      return html(errorHtml(`No document ${document}.`), 404);
    const head = pageHead(template, options.themeCss, [
      ...options.head ?? [],
      `<style>${RUNTIME_STYLES}</style>`,
      `<meta name="htmx-config" content="${escapeHtml(HTMX_CONFIG)}">`,
      '<script src="/assets/htmx.js"></script>'
    ]);
    const foot = new SafeHtml(`<script type="application/json" id="patra-config">${config(template, document)}</script>
<script src="/assets/patra.js"></script>`);
    const rendered = renderPage(template, content, { head, foot, document });
    if (!rendered.ok) {
      const lines = rendered.problems.map((p) => `${p.file}${p.at}: ${p.message}`).join(`
`);
      return html(`<pre>${escapeHtml(`This document does not fit the template:
${lines}`)}</pre>`, 500);
    }
    return html(rendered.html);
  };
  const findItem = async (template, document, part, key) => {
    const spec = template.parts.get(part);
    const content = await options.source.load(template.manifest.id, document);
    if (spec?.collection === undefined || spec.key === undefined || content === undefined) {
      return;
    }
    const items = resolvePointer(content, spec.collection);
    if (!Array.isArray(items))
      return;
    const keyField = spec.key;
    return items.find((i) => isRecord4(i) && i[keyField] === key);
  };
  const formHtml = (template, action, item, values, error) => {
    const spec = template.manifest.actions[action];
    if (spec?.form === undefined)
      return;
    const rendered = renderPart(template, spec.form, {
      ...item,
      values,
      ...error === undefined ? {} : { error }
    });
    return rendered.ok ? rendered.html : errorHtml(rendered.problems.map((p) => p.message).join("; "));
  };
  const form = async (template, document, action, query) => {
    const spec = template.manifest.actions[action];
    if (spec === undefined)
      return html(errorHtml(`No action ${action}.`), 404);
    const key = query.get("key") ?? "";
    const item = await findItem(template, document, spec.part, key);
    if (item === undefined)
      return html(errorHtml(`${key} is not on this page any more; reload it.`), 404);
    const values = {};
    for (const [field, pointer] of Object.entries(spec.defaults ?? {})) {
      const value = resolvePointer(item, pointer);
      if (typeof value === "string")
        values[field] = value;
    }
    for (const field of spec.fields) {
      const given = query.get(field);
      if (given !== null)
        values[field] = given;
    }
    return html(formHtml(template, action, item, values) ?? errorHtml(`${action} has no form.`));
  };
  const answer = async (template, document, intent, result) => {
    if (result.ok) {
      if (result.update.kind === "page")
        return html("", 200, { "HX-Refresh": "true" });
      const { part, key, content } = result.update;
      const main = renderPart(template, part, content);
      if (!main.ok)
        return html(errorHtml(main.problems.map((p) => p.message).join("; ")), 500);
      const collection = template.parts.get(part)?.collection;
      const others = [...template.parts.values()].filter((p) => p.name !== part && p.collection !== undefined && p.collection === collection).flatMap((p) => {
        const rendered = renderPart(template, p.name, content);
        return rendered.ok ? [outOfBand(rendered.html, itemSelector(p.name, key))] : [];
      });
      return html([main.html, ...others].join(`
`), 200, {
        "HX-Retarget": itemSelector(part, key),
        "HX-Reswap": "outerHTML"
      });
    }
    const status = result.code === "STALE" ? 409 : 400;
    const item = await findItem(template, document, intent.target.part, intent.target.key);
    const message = result.code === "STALE" && result.current !== undefined ? `${result.message} Reload to see the current version; what you typed is kept below.` : result.message;
    const again = item === undefined ? undefined : formHtml(template, intent.action, item, { ...intent.payload }, message);
    return html(again ?? errorHtml(message), status);
  };
  const intent = async (template, document, action, request) => {
    const spec = template.manifest.actions[action];
    if (spec === undefined && action !== "refresh")
      return html(errorHtml(`No action ${action}.`), 404);
    const fields = {};
    const type = request.headers.get("content-type") ?? "";
    if (type.includes("form-urlencoded") || type.includes("multipart/form-data")) {
      (await request.formData()).forEach((value, name) => {
        if (typeof value === "string")
          fields[name] = value;
      });
    }
    const payload = Object.fromEntries(Object.entries(fields).filter(([name]) => !RESERVED.has(name) && (spec?.fields.includes(name) ?? false)));
    const built = {
      template: template.manifest.id,
      document,
      action,
      target: { part: spec?.part ?? "", key: fields._key ?? "" },
      ...fields._version ? { version: fields._version } : {},
      payload,
      actor: options.actor
    };
    const result = await oneAtATime(() => options.handle(built));
    return answer(template, document, built, result);
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    idleTimeout: options.idleTimeout ?? DEFAULT_IDLE_SECONDS,
    async fetch(request) {
      const url = new URL(request.url);
      const host = request.headers.get("host") ?? "";
      if (host !== `127.0.0.1:${url.port}` && host !== `localhost:${url.port}`) {
        return html(errorHtml("Unexpected host."), 403);
      }
      if (url.pathname === "/assets/htmx.js") {
        return new Response(htmx_min_default, {
          headers: { "content-type": "text/javascript; charset=utf-8" }
        });
      }
      if (url.pathname === "/assets/patra.js") {
        return new Response(RUNTIME_SCRIPT, {
          headers: { "content-type": "text/javascript; charset=utf-8" }
        });
      }
      const [, kind, templateId = "", document = "", action = ""] = url.pathname.split("/").map((p) => decodeURIComponent(p));
      const template = templates.get(templateId);
      if (template === undefined)
        return html(errorHtml("Not found."), 404);
      try {
        if (request.method === "GET" && kind === "d")
          return await page(template, document);
        if (request.method === "GET" && kind === "f")
          return await form(template, document, action, url.searchParams);
        if (request.method === "POST" && (kind === "i" || kind === "refresh")) {
          if (request.headers.get("x-patra-token") !== token) {
            return html(errorHtml("This page is out of date; reload it."), 403);
          }
          return await intent(template, document, kind === "refresh" ? "refresh" : action, request);
        }
        return html(errorHtml("Not found."), 404);
      } catch (error) {
        const message = error instanceof PatraError ? error.message : String(error);
        return html(errorHtml(message), 500);
      }
    }
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    token,
    page: (template, document) => `http://127.0.0.1:${server.port}/d/${encodeURIComponent(template)}/${encodeURIComponent(document)}`,
    stop: () => server.stop(true)
  };
}
// node_modules/.bun/@cntxt-labs+patra-templates@..+vendor+patra+cntxt-labs-patra-templates-0.0.0.tgz/node_modules/@cntxt-labs/patra-templates/index.ts
import { join as join8 } from "path";
function templateDir(name) {
  return join8(import.meta.dir, name);
}

// cli/src/serve.ts
function reviewTemplate() {
  const loaded = loadTemplate(templateDir(REVIEW_TEMPLATE));
  if (!loaded.ok) {
    throw new YojanaError("TEMPLATE_INVALID", `patra's ${REVIEW_TEMPLATE} template did not load: ${loaded.problems.map((p) => `${p.file} ${p.message}`).join("; ")}`);
  }
  return loaded.template;
}
function startReviewServer(options) {
  const session = reviewSession({
    root: options.root,
    plansDir: options.plansDir,
    changesDir: options.changesDir,
    runCheck: options.runCheck,
    verifiers: options.verifiers,
    worklink: options.worklink,
    you: options.actor
  });
  const server = serve({
    templates: [reviewTemplate()],
    themeCss: themeStylesheet(loadConfig(), themeFile("default")),
    source: { load: (template, document) => session.load(template, document) },
    handle: (intent) => session.handle(intent),
    actor: options.actor,
    port: options.port
  });
  return {
    url: server.url,
    token: server.token,
    plans: async () => (await session.plans()).map((p) => ({ ...p, url: server.page(REVIEW_TEMPLATE, p.id) })),
    stop: () => server.stop()
  };
}

// cli/src/main.ts
var USAGE = `yojana ${VERSION}: plans as checkable contracts

Usage:
  yojana ingest [--trust-file]              record edits to plan files
  yojana change open <file>                 open a change file against the log
  yojana changes [--all]                    list open changes (--all: closed ones too)
  yojana archive <change>                   apply a change if what it edits has not moved
  yojana abandon <change> --reason <text>   close a change without applying it
  yojana refresh                            bring log changes into plan files that fell behind
  yojana status [plan] [--check]            plans, progress, pending edits, open changes
  yojana repair                             keep a corrupt log's readable events, move the rest aside
  yojana comment <plan> <req> "<text>"      note on a requirement [--quote "<span>"] [--reply <id>]
  yojana remove-comment <plan> <id>         take your own comment or reply off the page
  yojana review [plan] [--check] [--out f]  write a read-only copy of the page (.yojana/review/)
  yojana review [plan] --content            print the page's content as JSON (the plan and its
                                            state: claims, progress, threads, changes); no file
  yojana review --serve [--port n]          the review page, live: comment, edit, suggest, accept
  yojana decide <plan> <req> <item> close|reopen --reason <text> [--final]
                                            propose a decision on a work item (--final: decide it)
  yojana decisions [--apply] [--finalize <id>] [--decline <id> --reason <text>]
                                            what waits on a person: decisions on work items and
                                            status proposals; --apply runs finalized decisions
                                            through bd (bd close / bd reopen), retrying failures
  yojana propose-status <plan> <status> --reason <text> [--final]
                                            propose moving a plan (--final: a person moves it)
  yojana approve <plan> <req>               approve a requirement as it reads now (a person)
  yojana decline <plan> <req> --reason <text>
                                            decline it as it reads now, saying why (a person)
  yojana import <file> --id <plan-id>       start a plan from an existing Markdown roadmap
                [--prefix <bead-prefix>] [--out <path>] [--force]
  yojana check [plan] [--strict]            verify plan claims against the code
  yojana config                             the settings in effect from YOJANA_CONFIG
  yojana --version

Options:
  --root <dir>       repository root (default: current directory)
  --plans <dir>      plan folder, relative to the root (default: plans)
  --changes <dir>    change folder, relative to the root (default: changes)
  --json             machine-readable output
  --strict           check: also fail when a claim cannot be verified
  --check            status: also run the claim checks
  --stale-days <n>   status: an open change older than this is stale (default 14)

An agent (YOJANA_AGENT set, YOJANA_ACTOR not) proposes; only a person finalizes or declines a
status change or approves a requirement. When an agent ingests, a changed status line becomes a
proposal.

Exit codes: 0 done; 1 refused, violated, invalid or failed (the output says which); 2 usage error.
Errors carry a code (STORE_CORRUPT, CLI_USAGE, ...) and usually a hint; with --json they are
printed as {"error": {"code", "message", "hint"}}.

YOJANA_CONFIG names a yojana.config.json (paths, fonts, theme tokens, a theme file) that review
pages use; the Claude Code plugin keeps one in its data folder.

Claims run through anvesa (wql, dependents) and progress through bd; set ANVESA_BIN or BD_BIN if
they are not on PATH.
`;
var DEFAULT_STALE_DAYS = 14;
var DEFAULT_PORT = 4317;
var MAX_PORT = 65535;
function parseFlags(argv) {
  const flags = {
    root: process.cwd(),
    plans: undefined,
    changes: undefined,
    json: false,
    trustFile: false,
    all: false,
    strict: false,
    runCheck: false,
    staleDays: DEFAULT_STALE_DAYS,
    reason: undefined,
    id: undefined,
    prefix: undefined,
    out: undefined,
    force: false,
    quote: undefined,
    reply: undefined,
    serve: false,
    content: false,
    port: DEFAULT_PORT,
    apply: false,
    final: false,
    finalize: undefined,
    decline: undefined,
    positional: []
  };
  for (let i = 0;i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const value = () => {
      const next = argv[++i];
      if (next === undefined)
        throw new YojanaError("CLI_USAGE", `${arg} needs a value`);
      return next;
    };
    if (arg === "--root")
      flags.root = resolve2(value());
    else if (arg === "--plans")
      flags.plans = value();
    else if (arg === "--changes")
      flags.changes = value();
    else if (arg === "--reason")
      flags.reason = value();
    else if (arg === "--id")
      flags.id = value();
    else if (arg === "--prefix")
      flags.prefix = value();
    else if (arg === "--out")
      flags.out = value();
    else if (arg === "--force")
      flags.force = true;
    else if (arg === "--quote")
      flags.quote = value();
    else if (arg === "--reply")
      flags.reply = value();
    else if (arg === "--serve")
      flags.serve = true;
    else if (arg === "--content")
      flags.content = true;
    else if (arg === "--apply")
      flags.apply = true;
    else if (arg === "--final")
      flags.final = true;
    else if (arg === "--finalize")
      flags.finalize = value();
    else if (arg === "--decline")
      flags.decline = value();
    else if (arg === "--port") {
      const port = Number(value());
      if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) {
        throw new YojanaError("CLI_USAGE", "--port needs a port number");
      }
      flags.port = port;
    } else if (arg === "--json")
      flags.json = true;
    else if (arg === "--trust-file")
      flags.trustFile = true;
    else if (arg === "--all")
      flags.all = true;
    else if (arg === "--strict")
      flags.strict = true;
    else if (arg === "--check")
      flags.runCheck = true;
    else if (arg === "--stale-days") {
      const days = Number(value());
      if (!Number.isInteger(days) || days < 0) {
        throw new YojanaError("CLI_USAGE", "--stale-days needs a whole number of days");
      }
      flags.staleDays = days;
    } else if (arg.startsWith("--"))
      throw new YojanaError("CLI_USAGE", `unknown option ${arg}`);
    else
      flags.positional.push(arg);
  }
  return flags;
}
function actor() {
  return process.env.YOJANA_ACTOR ?? process.env.YOJANA_AGENT ?? person();
}
function person() {
  return process.env.YOJANA_ACTOR ?? userInfo().username;
}
function isAgent() {
  return process.env.YOJANA_ACTOR === undefined && (process.env.YOJANA_AGENT ?? "") !== "";
}
function toSource(root, path) {
  return relative3(root, path).split(sep3).join("/");
}
async function withWorkspace(flags, body, options) {
  const workspace = openWorkspace(flags.root, { plansDir: flags.plans, changesDir: flags.changes });
  const opened = await workspace.store.open();
  ensureGitAttributes(flags.root);
  if (opened.status === "corrupt" && options?.allowCorrupt !== true) {
    await workspace.store.close();
    throw new YojanaError("STORE_CORRUPT", `${opened.source} is unreadable from event ${opened.atSeq}; nothing was done`, { hint: "run yojana repair: it keeps every readable event and moves the rest aside" });
  }
  try {
    return await body(workspace);
  } finally {
    await workspace.store.close();
  }
}
function emit(flags, write, value, text) {
  write(flags.json ? `${JSON.stringify(value, null, 2)}
` : text);
}
function describeProblems(problems) {
  return problems.map((p) => `  ${p.requirement === undefined ? "" : `${p.requirement}  `}${p.code}  ${p.message}`);
}
function describeFile(file) {
  const count = file.appended === 1 ? " (1 event)" : file.appended > 1 ? ` (${file.appended} events)` : "";
  const head = `${file.source}  ${file.outcome}${count}`;
  const lines = [file.planId === undefined ? head : `${head}  ${file.planId}`];
  for (const issue of file.issues) {
    lines.push(`  ${issue.line === undefined ? "" : `line ${issue.line}: `}${issue.code} ${issue.message}`);
  }
  if (file.missingBase && file.outcome === "refused") {
    lines.push("  no base for this plan: re-run with --trust-file to record the file on top of the log");
  }
  const s = file.status;
  if (s?.proposed === true) {
    lines.push(`  status  ${s.file} proposed (stays ${s.log ?? "draft"} until a person finalizes it: yojana decisions)`);
  } else if (s !== undefined && s.log === undefined && s.movement === "edited") {
    lines.push(`  status  ${s.file}  (new plan)`);
  } else if (s !== undefined) {
    lines.push(`  status  ${s.movement}  file ${s.file} \xB7 base ${s.base ?? "-"} \xB7 log ${s.log ?? "-"}`);
  }
  for (const r of file.requirements) {
    const what = r.movement === "edited" ? r.action ?? "edited" : r.movement;
    const detail = r.movement === "edited" ? "" : `  file ${r.file ?? "-"} \xB7 base ${r.base ?? "-"} \xB7 log ${r.log ?? "-"}`;
    lines.push(`  ${r.id}  ${what}${detail}`);
  }
  return lines;
}
function describeIngest(report) {
  if (report.files.length === 0)
    return `no plan files found
`;
  const lines = report.files.flatMap(describeFile);
  if (report.files.some((f) => f.requirements.some((r) => r.movement === "behind"))) {
    lines.push("", "behind: the log changed since the file was last ingested; the file was left as it is");
  }
  if (report.files.some((f) => f.outcome === "refused")) {
    lines.push("", "refused: the file and the log both changed the same thing; nothing from that file was recorded");
  }
  return `${lines.join(`
`)}
`;
}
function runIngest(flags, write) {
  return withWorkspace(flags, async (ws) => {
    const report = await ingest({
      store: ws.store,
      parser: ws.parser,
      bases: ws.bases,
      files: loadPlanFiles(flags.root, ws.plansDir),
      actor: actor(),
      trustFile: flags.trustFile,
      agent: isAgent()
    });
    emit(flags, write, report, describeIngest(report));
    return report.files.some((f) => f.outcome === "refused" || f.outcome === "invalid") ? 1 : 0;
  });
}
function runChangeOpen(flags, write) {
  const [, file] = flags.positional;
  if (file === undefined)
    throw new YojanaError("CLI_USAGE", "usage: yojana change open <file>");
  return withWorkspace(flags, async (ws) => {
    const path = resolve2(flags.root, file);
    const source = toSource(flags.root, path);
    let text;
    try {
      text = await Bun.file(path).text();
    } catch (error) {
      throw new YojanaError("FILE_NOT_FOUND", `cannot read ${source}`, { cause: error });
    }
    const parsed = ws.parser.parseChange(source, text);
    if (!parsed.ok) {
      const lines = parsed.issues.map((i) => `  ${i.line === undefined ? "" : `line ${i.line}: `}${i.code} ${i.message}`);
      emit(flags, write, parsed, `${source}  invalid
${lines.join(`
`)}
`);
      return 1;
    }
    const result = await openChange({
      store: ws.store,
      draft: parsed.change,
      actor: actor()
    });
    const lines = [`${parsed.change.id}  ${result.outcome}  ${parsed.change.planId}`];
    if (result.outcome === "opened") {
      for (const d of result.change?.deltas ?? []) {
        const id = d.op === "remove" ? d.id : d.requirement.id;
        lines.push(`  ${id}  ${d.op}${d.base === undefined ? "" : `  on ${d.base}`}`);
      }
    }
    lines.push(...describeProblems(result.problems));
    emit(flags, write, result, `${lines.join(`
`)}
`);
    return result.outcome === "opened" ? 0 : 1;
  });
}
function runChanges(flags, write) {
  return withWorkspace(flags, async (ws) => {
    const state = foldLog(await ws.store.events());
    const rows = [...state.changes.values()].filter((c) => flags.all || c.status === "open");
    const value = rows.map((c) => ({
      id: c.change.id,
      plan: c.change.planId,
      title: c.change.title,
      status: c.status,
      openedAt: new Date(c.openedAt).toISOString(),
      deltas: c.change.deltas.length,
      reason: c.reason
    }));
    const lines = rows.length === 0 ? [flags.all ? "no changes" : "no open changes"] : value.map((c) => `${c.id}  ${c.status}  ${c.plan}  ${c.deltas} edit${c.deltas === 1 ? "" : "s"}  opened ${c.openedAt.slice(0, "yyyy-mm-dd".length)}  ${c.title}${c.reason === undefined ? "" : `  (${c.reason})`}`);
    emit(flags, write, value, `${lines.join(`
`)}
`);
    return 0;
  });
}
function runArchive(flags, write) {
  const [changeId] = flags.positional;
  if (changeId === undefined)
    throw new YojanaError("CLI_USAGE", "usage: yojana archive <change>");
  return withWorkspace(flags, async (ws) => {
    const result = await archiveChange({
      store: ws.store,
      bases: ws.bases,
      parser: ws.parser,
      changeId,
      actor: actor(),
      planFiles: loadPlanFiles(flags.root, ws.plansDir),
      writePlan: (source, text) => writeFileSync3(join9(flags.root, source), text)
    });
    const lines = [`${changeId}  ${result.outcome}`];
    lines.push(...describeProblems(result.problems));
    for (const c of result.conflicts) {
      lines.push(`  ${c.requirement}  ${c.op}  written against ${c.expected ?? "no requirement"}, the plan now has ${c.actual ?? "none"}`);
    }
    if (result.conflicts.length > 0) {
      lines.push("", "another change or edit got there first. Rewrite this change against the current plan and open it under a new id, or abandon it.");
    }
    let moved;
    if (result.outcome === "archived") {
      const file = result.planFile;
      if (file?.updated === true)
        lines.push(`  ${file.source}  updated to match`);
      else if (file?.reason === "out-of-step") {
        lines.push(`  ${file.source}  not updated: it has edits the log does not (run ingest, then edit it by hand)`);
      } else
        lines.push("  no plan file found for this plan; only the log was updated");
      const source = result.change?.source;
      if (source !== undefined) {
        moved = settleChangeFile(flags.root, source, "archive", new Date);
        if (moved !== undefined)
          lines.push(`  ${source}  moved to ${moved}`);
      }
    }
    emit(flags, write, { ...result, movedTo: moved }, `${lines.join(`
`)}
`);
    return result.outcome === "archived" ? 0 : 1;
  });
}
function describeCheck(report) {
  if (report.plans.length === 0)
    return `no plans in the log; run yojana ingest first
`;
  const lines = [];
  for (const plan of report.plans) {
    lines.push(plan.planId);
    if (plan.results.length === 0)
      lines.push("  no claims");
    for (const r of plan.results) {
      const expectation = r.claim.expect ? "" : " (expect none)";
      lines.push(`  ${r.requirement}  ${r.outcome}  ${r.claim.kind} ${r.claim.expression}${expectation}`);
      lines.push(`      ${r.evidence}`);
    }
  }
  lines.push("", `${report.holds} hold \xB7 ${report.violated} violated \xB7 ${report.unverifiable} could not be checked`);
  return `${lines.join(`
`)}
`;
}
function verifiers(root) {
  return [
    new PathVerifier(root),
    new TextVerifier(root),
    new AnvesaVerifier(spawnAnvesa(process.env.ANVESA_BIN ?? "anvesa", root))
  ];
}
function runCheck(flags, write) {
  const [planId] = flags.positional;
  return withWorkspace(flags, async (ws) => {
    const report = await check({ store: ws.store, verifiers: verifiers(flags.root), planId });
    emit(flags, write, report, describeCheck(report));
    if (report.violated > 0)
      return 1;
    return flags.strict && report.unverifiable > 0 ? 1 : 0;
  });
}
function runComment(flags, write) {
  const [planId, requirement, ...words] = flags.positional;
  const body = words.join(" ");
  if (planId === undefined || requirement === undefined || body === "") {
    throw new YojanaError("CLI_USAGE", 'usage: yojana comment <plan> <requirement> "<text>" [--quote "<span>"] [--reply <id>]');
  }
  return withWorkspace(flags, async (ws) => {
    const result = await comment({
      store: ws.store,
      planId,
      requirement,
      body,
      author: actor(),
      quote: flags.quote,
      replyTo: flags.reply
    });
    if (!result.ok) {
      emit(flags, write, result, `${result.code}: ${result.message}
`);
      return 1;
    }
    const a = result.annotation;
    emit(flags, write, result, `${a.id}  on ${planId} ${a.requirement} (revision ${a.revision})
`);
    return 0;
  });
}
function runRemoveComment(flags, write) {
  const [planId, id] = flags.positional;
  if (planId === undefined || id === undefined) {
    throw new YojanaError("CLI_USAGE", "usage: yojana remove-comment <plan> <comment-id>");
  }
  return withWorkspace(flags, async (ws) => {
    const result = await removeComment({
      store: ws.store,
      planId,
      id,
      actor: actor()
    });
    if (!result.ok) {
      emit(flags, write, result, `${result.code}: ${result.message}
`);
      return 1;
    }
    emit(flags, write, result, `removed ${id} from ${planId} ${result.annotation.requirement}
`);
    return 0;
  });
}
function worklink(root) {
  return new BdWorkLink(spawnBd(process.env.BD_BIN ?? "bd", root));
}
function runDecide(flags, write) {
  const [planId, requirement, item, decision] = flags.positional;
  if (planId === undefined || requirement === undefined || item === undefined || decision === undefined || flags.reason === undefined) {
    throw new YojanaError("CLI_USAGE", "usage: yojana decide <plan> <requirement> <item> close|reopen --reason <text> [--final]");
  }
  return withWorkspace(flags, async (ws) => {
    const result = await recordDecision({
      store: ws.store,
      planId,
      requirement,
      item,
      decision,
      reason: flags.reason ?? "",
      actor: actor(),
      finalize: flags.final
    });
    if (!result.ok) {
      emit(flags, write, result, `${result.code}: ${result.message}
`);
      return 1;
    }
    const d = result.decision;
    const next = d.status === "recorded" ? "proposed; a person finalizes it on the review page or with yojana decisions --finalize" : `${d.status}; yojana decisions --apply runs it through ${worklink(flags.root).name}`;
    emit(flags, write, result, `${d.id}  ${d.decision} ${d.item}: ${next}
`);
    return 0;
  });
}
async function settleProposal(flags, write, ws, result) {
  if (!result.ok) {
    emit(flags, write, result, `${result.code}: ${result.message}
`);
    return 1;
  }
  const p = result.proposal;
  await settleStatusLine({
    store: ws.store,
    parser: ws.parser,
    bases: ws.bases,
    files: loadPlanFiles(flags.root, ws.plansDir),
    writePlan: (source, text) => writeFileSync3(join9(flags.root, source), text),
    proposal: p
  });
  const what = p.status === "accepted" ? `${p.planId} moved to ${p.to}` : p.status === "declined" ? `declined; ${p.planId} stays as it is` : `proposed ${p.planId} -> ${p.to}; a person finalizes it on the review page or with yojana decisions --finalize ${p.id}`;
  emit(flags, write, result, `${p.id}  ${what}
`);
  return 0;
}
function runDecisions(flags, write) {
  return withWorkspace(flags, async (ws) => {
    const proposals = foldLog(await ws.store.events()).proposals;
    if (flags.decline !== undefined) {
      if (!proposals.has(flags.decline)) {
        throw new YojanaError("NOT_FOUND", `no status proposal ${flags.decline}`, {
          hint: "only status proposals are declined; see yojana decisions"
        });
      }
      return settleProposal(flags, write, ws, await declineStatus({
        store: ws.store,
        proposalId: flags.decline,
        reason: flags.reason ?? "",
        actor: actor(),
        agent: isAgent()
      }));
    }
    if (flags.finalize !== undefined && proposals.has(flags.finalize)) {
      return settleProposal(flags, write, ws, await finalizeStatus({
        store: ws.store,
        proposalId: flags.finalize,
        reason: flags.reason,
        actor: actor(),
        agent: isAgent()
      }));
    }
    if (flags.finalize !== undefined) {
      const result = await finalizeDecision({
        store: ws.store,
        decisionId: flags.finalize,
        actor: actor()
      });
      if (!result.ok) {
        emit(flags, write, result, `${result.code}: ${result.message}
`);
        return 1;
      }
      if (!flags.apply) {
        emit(flags, write, result, `${result.decision.id}  finalized
`);
        return 0;
      }
    }
    if (flags.apply) {
      const applied = await applyDecisions({
        store: ws.store,
        worklink: worklink(flags.root),
        actor: actor()
      });
      const lines = applied.map((a) => `${a.id}  ${a.outcome}: ${a.note}
`).join("");
      emit(flags, write, { applied }, lines === "" ? `nothing to apply
` : lines);
      return applied.some((a) => a.outcome === "failed") ? 1 : 0;
    }
    const decisions = [...foldLog(await ws.store.events()).decisions.values()].filter((d) => flags.all || d.status !== "applied");
    const statusProposals = [...proposals.values()].filter((p) => flags.all || p.status === "proposed");
    const width = "finalized".length;
    const lines = [
      ...statusProposals.map((p) => `${p.id}  ${p.status.padEnd(width)}  status ${p.to}  (${p.planId}, by ${p.decidedBy ?? p.proposedBy}): ${p.outcome ?? p.reason}
`),
      ...decisions.map((d) => `${d.id}  ${d.status.padEnd(width)}  ${d.decision} ${d.item}  (${d.planId} ${d.requirement}, by ${d.finalizedBy ?? d.recordedBy}): ${d.outcome ?? d.reason}
`)
    ].join("");
    emit(flags, write, { decisions, proposals: statusProposals }, lines === "" ? `no ${flags.all ? "" : "pending "}decisions
` : lines);
    return 0;
  });
}
function runProposeStatus(flags, write) {
  const [planId, to] = flags.positional;
  if (planId === undefined || to === undefined || flags.reason === undefined) {
    throw new YojanaError("CLI_USAGE", "usage: yojana propose-status <plan> <status> --reason <text> [--final]");
  }
  return withWorkspace(flags, async (ws) => settleProposal(flags, write, ws, await proposeStatus({
    store: ws.store,
    planId,
    to,
    reason: flags.reason ?? "",
    actor: actor(),
    agent: isAgent(),
    finalize: flags.final
  })));
}
function runDecline(flags, write) {
  const [planId, requirement] = flags.positional;
  if (planId === undefined || requirement === undefined || (flags.reason ?? "").trim() === "") {
    throw new YojanaError("CLI_USAGE", "usage: yojana decline <plan> <requirement> --reason <text>");
  }
  return withWorkspace(flags, async (ws) => {
    const result = await declineRequirement({
      store: ws.store,
      planId,
      requirement,
      reason: flags.reason ?? "",
      actor: actor(),
      agent: isAgent()
    });
    if (!result.ok) {
      emit(flags, write, result, `${result.code}: ${result.message}
`);
      return 1;
    }
    emit(flags, write, result, `${planId} ${requirement}  ${result.already ? "already declined" : "declined"} at ${result.revision}
`);
    return 0;
  });
}
function runApprove(flags, write) {
  const [planId, requirement] = flags.positional;
  if (planId === undefined || requirement === undefined) {
    throw new YojanaError("CLI_USAGE", "usage: yojana approve <plan> <requirement>");
  }
  return withWorkspace(flags, async (ws) => {
    const result = await approveRequirement({
      store: ws.store,
      planId,
      requirement,
      actor: actor(),
      agent: isAgent()
    });
    if (!result.ok) {
      emit(flags, write, result, `${result.code}: ${result.message}
`);
      return 1;
    }
    emit(flags, write, result, `${planId} ${requirement}  ${result.already ? "already approved" : "approved"} at ${result.revision}
`);
    return 0;
  });
}
async function runServe(flags, write) {
  const server = startReviewServer({
    root: flags.root,
    plansDir: flags.plans,
    changesDir: flags.changes,
    port: flags.port,
    actor: person(),
    runCheck: flags.runCheck,
    verifiers: () => verifiers(flags.root),
    worklink: () => worklink(flags.root)
  });
  const plans = await server.plans();
  write(`review server on ${server.url} (this machine only); stop it with Ctrl+C
`);
  write(plans.length === 0 ? `no plans in the log yet; run yojana ingest
` : plans.map((p) => `  ${p.id}  ${p.status}  ${p.url}
`).join(""));
  await new Promise(() => {
    return;
  });
  return 0;
}
function runReview(flags, write) {
  if (flags.content && (flags.serve || flags.out !== undefined)) {
    throw new YojanaError("CLI_USAGE", "--content prints the content; it does not go with --serve or --out");
  }
  if (flags.serve)
    return runServe(flags, write);
  return withWorkspace(flags, async (ws) => {
    const state = foldLog(await ws.store.events());
    const [named] = flags.positional;
    const planIds = named === undefined ? [...state.plans.keys()] : [named];
    if (planIds.length === 0) {
      write(`no plans in the log; run yojana ingest first
`);
      return 1;
    }
    const session = reviewSession({
      root: flags.root,
      plansDir: flags.plans,
      changesDir: flags.changes,
      runCheck: flags.runCheck,
      verifiers: () => verifiers(flags.root),
      worklink: () => worklink(flags.root),
      you: person(),
      mode: "read"
    });
    const load = async (planId) => {
      const content = await session.load(REVIEW_TEMPLATE, planId);
      if (content === undefined) {
        throw new YojanaError("PLAN_NOT_FOUND", `the log has no plan ${planId}`);
      }
      return content;
    };
    if (flags.content) {
      const contents = await Promise.all(planIds.map(load));
      write(`${JSON.stringify(named === undefined ? contents : contents[0], null, 2)}
`);
      return 0;
    }
    const template = reviewTemplate();
    const head = pageHead(template, themeStylesheet(loadConfig(), themeFile("default")), []);
    const written = [];
    for (const planId of planIds) {
      const content = await load(planId);
      const page = renderPage(template, content, { head });
      if (!page.ok) {
        throw new YojanaError("TEMPLATE_INVALID", page.problems.map((p) => `${p.at} ${p.message}`).join("; "));
      }
      const name = planId.split("/").at(-1) ?? planId;
      const out = flags.out !== undefined && planIds.length === 1 ? resolve2(flags.root, flags.out) : join9(flags.root, ".yojana", "review", `${name}.html`);
      mkdirSync5(join9(out, ".."), { recursive: true });
      writeFileSync3(out, page.html);
      written.push(toSource(flags.root, out));
    }
    emit(flags, write, { written }, `${written.map((w) => `wrote ${w}`).join(`
`)}
` + `a saved copy, read only: to comment, approve or decide, run yojana review --serve
`);
    return 0;
  });
}
function runConfig(flags, write) {
  const config = loadConfig();
  if (flags.json) {
    write(`${JSON.stringify(config, null, 2)}
`);
    return 0;
  }
  if (config.path === undefined) {
    write(`no config: YOJANA_CONFIG is not set (the Claude Code plugin sets it)
`);
    return 0;
  }
  if (!config.found) {
    write(`no config at ${config.path}; create it to change paths, fonts or theme tokens
`);
    return 0;
  }
  const { theme } = config;
  const count = (values) => Object.keys(values).length;
  write([
    `config ${config.path}`,
    `  home   ${config.home ?? "(not set)"}`,
    `  vars   ${Object.entries(config.vars).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`,
    `  theme  ${theme.css ?? "patra's default"}`,
    `  fonts  ${Object.entries(theme.fonts).map(([k, v]) => `${k}: ${v}`).join("; ") || "(theme default)"}`,
    `  tokens ${count(theme.tokens)} light, ${count(theme.dark)} dark`,
    ""
  ].join(`
`));
  return 0;
}
function runImport(flags, write) {
  const [file] = flags.positional;
  if (file === undefined || flags.id === undefined) {
    throw new YojanaError("CLI_USAGE", "usage: yojana import <file> --id <plan-id>");
  }
  const from = resolve2(flags.root, file);
  if (!existsSync8(from))
    throw new YojanaError("FILE_NOT_FOUND", `cannot read ${file}`);
  const name = flags.id.split("/").at(-1) ?? flags.id;
  const out = resolve2(flags.root, flags.out ?? join9(flags.plans ?? "plans", `${name}.md`));
  const outSource = toSource(flags.root, out);
  if (existsSync8(out) && !flags.force) {
    throw new YojanaError("FILE_EXISTS", `${outSource} already exists`, {
      hint: "choose another --out, or pass --force to replace it"
    });
  }
  const { report, issues } = importAndValidate(readFileSync7(from, "utf8"), {
    source: toSource(flags.root, from),
    planId: flags.id,
    prefix: flags.prefix
  });
  if (issues.length > 0) {
    const lines = issues.map((i) => `  ${i.line === undefined ? "" : `line ${i.line}: `}${i.code} ${i.message}`);
    emit(flags, write, { report, issues }, `import produced an invalid plan; nothing written
${lines.join(`
`)}
`);
    return 1;
  }
  mkdirSync5(join9(out, ".."), { recursive: true });
  writeFileSync3(out, report.markdown);
  const prefix = report.prefix === undefined ? "no bead ids found" : `bead prefix ${report.prefix.value}${report.prefix.detected ? " (detected; --prefix to change)" : ""}`;
  const lines = [
    `${outSource}  ${report.title}`,
    `  ${plural2(report.requirements.length, "requirement")} from level-${report.level} headings \xB7 ${plural2(report.beads.length, "bead")} \xB7 ${prefix}`,
    ...report.requirements.map((r) => `  ${r.id}${r.beads.length > 0 ? `  beads=${r.beads.join(",")}` : ""}`)
  ];
  if (report.droppedTables > 0) {
    lines.push(`  dropped ${plural2(report.droppedTables, "status table")}: progress comes from the beads`);
  }
  lines.push("", "Review it, add claims, then run yojana ingest.");
  emit(flags, write, { ...report, out: outSource }, `${lines.join(`
`)}
`);
  return 0;
}
function runRepair(flags, write) {
  return withWorkspace(flags, async (ws) => {
    const result = await ws.repairLog();
    const text = result.quarantined === undefined ? `the log is readable (${result.kept} events); nothing to repair
` : `kept ${result.kept} readable events; moved the unreadable rest to ${toSource(flags.root, result.quarantined)}
`;
    emit(flags, write, result, text);
    return 0;
  }, { allowCorrupt: true });
}
function runRefresh(flags, write) {
  return withWorkspace(flags, async (ws) => {
    const report = await refresh({
      store: ws.store,
      parser: ws.parser,
      bases: ws.bases,
      files: loadPlanFiles(flags.root, ws.plansDir),
      writePlan: (source, text) => writeFileSync3(join9(flags.root, source), text)
    });
    const lines = report.files.length === 0 ? ["every plan file is up to date with the log"] : report.files.flatMap((f) => {
      const what = [
        f.updated.length > 0 ? `updated ${f.updated.join(", ")}` : "",
        f.added.length > 0 ? `added ${f.added.join(", ")}` : "",
        f.removed.length > 0 ? `removed ${f.removed.join(", ")}` : "",
        f.status === undefined ? "" : `status ${f.status.from} -> ${f.status.to}`
      ].filter((s) => s !== "");
      return [`${f.source}  ${what.join(" \xB7 ")}`];
    });
    emit(flags, write, report, `${lines.join(`
`)}
`);
    return 0;
  });
}
function day(ms) {
  return new Date(ms).toISOString().slice(0, "yyyy-mm-dd".length);
}
function plural2(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
function describeStatus(report, checks) {
  const lines = [];
  if (report.plans.length === 0)
    lines.push("no plans in the log; run yojana ingest first");
  for (const plan of report.plans) {
    const since = plan.statusSince === undefined ? "" : ` since ${day(plan.statusSince)}`;
    lines.push(`${plan.planId}  ${plan.status}${since}  ${plural2(plan.requirements, "requirement")}, ${plural2(plan.claims, "claim")}`);
    const p = plan.progress;
    if (p?.error !== undefined)
      lines.push(`  progress   could not read beads: ${p.error}`);
    else if (p !== undefined && p.items.length > 0) {
      const parts = p.items.map((i) => {
        if (i.item.state === "missing")
          return `${i.item.id} missing`;
        if (i.children.length === 0)
          return `${i.item.id} ${i.item.state}`;
        const done = i.children.filter((c) => c.state === "closed").length;
        return `${i.item.id} ${done}/${i.children.length}`;
      });
      lines.push(`  progress   ${p.done}/${p.total} done (${parts.join(", ")})`);
    }
    const f = plan.file;
    if (f.kind === "none")
      lines.push("  file       no plan file found for this plan");
    else {
      const pending = [
        f.unrecorded.length > 0 ? `not ingested: ${f.unrecorded.join(", ")}` : "",
        f.statusUnrecorded ? "status not ingested" : "",
        f.workItemsUnrecorded ? "bead list not ingested" : "",
        f.behind.length > 0 ? `behind the log: ${f.behind.join(", ")}` : "",
        f.conflicts.length > 0 ? `conflicts with the log: ${f.conflicts.join(", ")}` : ""
      ].filter((s) => s !== "");
      lines.push(`  file       ${f.source}  ${pending.length === 0 ? "in step" : pending.join(" \xB7 ")}`);
    }
    if (plan.contested.length > 0) {
      lines.push(`  contested  ${plan.contested.join(", ")} (edited on two branches; resolve in the plan file, then ingest)`);
    }
    for (const c of plan.openChanges) {
      lines.push(`  change     ${c.id}  open ${plural2(c.ageDays, "day")}${c.stale ? "  STALE" : ""}  ${c.title}`);
    }
    const planChecks = checks?.plans.find((c) => c.planId === plan.planId);
    if (planChecks !== undefined) {
      const n = (o) => planChecks.results.filter((r) => r.outcome === o).length;
      const violated = planChecks.results.filter((r) => r.outcome === "violated").map((r) => r.requirement);
      lines.push(`  claims     ${n("holds")} hold \xB7 ${n("violated")} violated \xB7 ${n("unverifiable")} could not be checked${violated.length > 0 ? `  (${[...new Set(violated)].join(", ")})` : ""}`);
    }
    for (const a of plan.alignment) {
      if (a.mismatch === undefined)
        continue;
      const items = a.items.map((i) => `${i.id} ${i.state}`).join(", ");
      lines.push(a.mismatch === "claims-hold-work-open" ? `  close?     ${a.requirement}: ${a.holds === 1 ? "its claim holds" : `all ${a.holds} claims hold`}, but ${items}` : `  reopen?    ${a.requirement}: ${plural2(a.violated, "claim")} violated, but ${items}`);
    }
  }
  for (const u of report.untracked) {
    const why = u.issues.length > 0 ? u.issues.map((i) => `${i.line === undefined ? "" : `line ${i.line}: `}${i.code}`).join(", ") : `plan ${u.planId} is not in the log yet; run yojana ingest`;
    lines.push(`untracked  ${u.source}  ${why}`);
  }
  if (report.anomalies.length > 0) {
    lines.push("", `${plural2(report.anomalies.length, "anomaly")} in the log (yojana status --json lists them)`);
  }
  return `${lines.join(`
`)}
`;
}
function runStatus(flags, write) {
  const [planId] = flags.positional;
  return withWorkspace(flags, async (ws) => {
    const checks = flags.runCheck ? await check({ store: ws.store, verifiers: verifiers(flags.root), planId }) : undefined;
    const report = await status({
      store: ws.store,
      parser: ws.parser,
      bases: ws.bases,
      files: loadPlanFiles(flags.root, ws.plansDir),
      worklink: new BdWorkLink(spawnBd(process.env.BD_BIN ?? "bd", flags.root)),
      checks,
      now: Date.now(),
      staleDays: flags.staleDays,
      planId
    });
    emit(flags, write, { ...report, checks }, describeStatus(report, checks));
    return 0;
  });
}
function runAbandon(flags, write) {
  const [changeId] = flags.positional;
  if (changeId === undefined) {
    throw new YojanaError("CLI_USAGE", "usage: yojana abandon <change> --reason <text>");
  }
  return withWorkspace(flags, async (ws) => {
    const result = await abandonChange({
      store: ws.store,
      changeId,
      reason: flags.reason ?? "",
      actor: actor()
    });
    const lines = [`${changeId}  ${result.outcome}`, ...describeProblems(result.problems)];
    let moved;
    const source = result.change?.source;
    if (result.outcome === "abandoned" && source !== undefined) {
      moved = settleChangeFile(flags.root, source, "abandoned", new Date);
      if (moved !== undefined)
        lines.push(`  ${source}  moved to ${moved}`);
    }
    emit(flags, write, { ...result, movedTo: moved }, `${lines.join(`
`)}
`);
    return result.outcome === "abandoned" ? 0 : 1;
  });
}
async function run(argv, write) {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v") {
    write(`${VERSION}
`);
    return 0;
  }
  try {
    const flags = () => parseFlags(rest);
    if (command === "ingest")
      return await runIngest(flags(), write);
    if (command === "change" && rest[0] === "open")
      return await runChangeOpen(flags(), write);
    if (command === "changes")
      return await runChanges(flags(), write);
    if (command === "archive")
      return await runArchive(flags(), write);
    if (command === "abandon")
      return await runAbandon(flags(), write);
    if (command === "check")
      return await runCheck(flags(), write);
    if (command === "status")
      return await runStatus(flags(), write);
    if (command === "refresh")
      return await runRefresh(flags(), write);
    if (command === "repair")
      return await runRepair(flags(), write);
    if (command === "import")
      return runImport(flags(), write);
    if (command === "comment")
      return await runComment(flags(), write);
    if (command === "decide")
      return await runDecide(flags(), write);
    if (command === "decisions")
      return await runDecisions(flags(), write);
    if (command === "propose-status")
      return await runProposeStatus(flags(), write);
    if (command === "approve")
      return await runApprove(flags(), write);
    if (command === "decline")
      return await runDecline(flags(), write);
    if (command === "remove-comment")
      return await runRemoveComment(flags(), write);
    if (command === "review")
      return await runReview(flags(), write);
    if (command === "config")
      return runConfig(flags(), write);
  } catch (error) {
    if (error instanceof YojanaError) {
      const { code, message, hint } = error;
      write(rest.includes("--json") ? `${JSON.stringify({ error: { code, message, hint } }, null, 2)}
` : `${code}: ${message}${hint === undefined ? "" : `
  hint: ${hint}`}
`);
      return code === "CLI_USAGE" ? 2 : 1;
    }
    throw error;
  }
  write(USAGE);
  return command === undefined || command === "--help" || command === "-h" ? 0 : 2;
}
if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), (text) => process.stdout.write(text));
}
export {
  run
};
