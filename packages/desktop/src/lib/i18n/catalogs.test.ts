import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { settingsNavGroups } from "@/components/settings/settings-catalog";

import { DEFAULT_LANGUAGE, languageOptions } from "./languages";

const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const catalogs = join(desktop, "src/lib/i18n/catalogs");
const locales = Object.keys(languageOptions);
const language = new Map([
  ["language.label", "Language"],
  ["language.system", "System ({{language}})"],
]);

type Forms = Partial<Record<"defaultValue" | `defaultValue_${Intl.LDMLPluralRule}`, string>>;
interface Message {
  forms: Forms;
  plural: boolean;
}

const forwardedTranslationKeys = new Map([
  ["client-transcript-errors.ts", new Set(["key"])],
  [
    "permission-option-copy.ts",
    new Set([
      "`permission.option.${variant[0]}.label`",
      "`permission.option.${variant[0]}.description`",
    ]),
  ],
  ["search-keywords.ts", new Set(["key"])],
  ["settings-catalog-types.tsx", new Set(["key"])],
  [
    "settings-catalog.tsx",
    new Set(["`settings.nav.${page.id}.label`", "`settings.nav.${page.id}.description`"]),
  ],
]);

function literal(node: ts.Node | undefined): string | undefined {
  if (node && ts.isStringLiteralLike(node)) return node.text;
  if (node && ts.isJsxExpression(node)) return literal(node.expression);
}

function objectMembers(node: ts.Node | undefined) {
  const result = new Map<string, ts.Expression>();
  if (node && ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        result.set(literal(property.name) ?? property.name.getText(), property.initializer);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        result.set(property.name.text, property.name);
      }
    }
  }
  return result;
}

type RecordMessage = (key: string, forms: Forms, plural?: boolean) => void;

function collectTranslationCall(
  call: ts.CallExpression,
  file: string,
  record: RecordMessage,
  fail: (message: string) => never,
) {
  const name = call.expression.getText();
  if (name === "createElement" && call.arguments[0]?.getText() === "UiTrans") {
    collectRichText(objectMembers(call.arguments[1]), record, fail);
    return;
  }
  const wrapper = ["settingsLabel", "settingsKeywords", "localizedSearchKeywords"].includes(name);
  if (!wrapper && !["t", "translateUi", "uiI18n.t"].includes(name)) return;

  const [keyExpression, defaultValue, thirdArgument] = call.arguments.slice(wrapper ? 1 : 0);
  const key = literal(keyExpression);
  if (key === undefined) {
    const expression = keyExpression?.getText();
    if (!expression || !forwardedTranslationKeys.get(file)?.has(expression)) {
      fail(`add source coverage for dynamic translation key ${expression}`);
    }
    return;
  }

  const options =
    defaultValue && ts.isObjectLiteralExpression(defaultValue) ? defaultValue : thirdArgument;
  const members = objectMembers(options);
  const forms: Forms = {};
  const fallback = literal(defaultValue);
  if (fallback !== undefined) forms.defaultValue = fallback;
  for (const [field, value] of members) {
    if (field === "defaultValue" || /^defaultValue_(?:zero|one|two|few|many|other)$/u.test(field)) {
      const text = literal(value) ?? fail(`add source coverage for dynamic ${field} of ${key}`);
      forms[field as keyof Forms] = text;
    }
  }

  if (!Object.keys(forms).length) fail(`add source coverage for the default of ${key}`);
  record(key, forms, members.has("count"));
}

function collectRichText(
  props: ReadonlyMap<string, ts.Node | undefined>,
  record: RecordMessage,
  fail: (message: string) => never,
) {
  const key = literal(props.get("i18nKey"));
  const defaults = props.get("defaults");
  const text = literal(defaults);
  const count = props.get("count");
  if (key !== undefined && text !== undefined) {
    record(key, { defaultValue: text }, count !== undefined);
    return;
  }

  const conditional = defaults && ts.isJsxExpression(defaults) ? defaults.expression : undefined;
  if (key && count && conditional && ts.isConditionalExpression(conditional)) {
    const condition = conditional.condition;
    if (
      ts.isBinaryExpression(condition) &&
      condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      ts.isNumericLiteral(condition.right) &&
      condition.right.text === "1" &&
      ts.isJsxExpression(count) &&
      condition.left.getText() === count.expression?.getText()
    ) {
      const one = literal(conditional.whenTrue);
      const other = literal(conditional.whenFalse);
      if (one !== undefined && other !== undefined) {
        record(key, { defaultValue_one: one, defaultValue_other: other }, true);
        return;
      }
    }
  }

  fail(`add source coverage for rich-text translation ${key ?? "(unknown key)"}`);
}

function collectDescriptors(
  node: ts.Node,
  record: RecordMessage,
  fail: (message: string) => never,
) {
  if (!ts.isVariableDeclaration(node) || !node.initializer) return;

  const name = node.name.getText();
  const value = node.initializer;
  if (name === "builtInVariants") {
    const variants = ts.isAsExpression(value) ? value.expression : value;
    if (!ts.isArrayLiteralExpression(variants)) fail("expected a static permission variant table");
    for (const variant of variants.elements) {
      if (!ts.isArrayLiteralExpression(variant)) fail("expected a permission variant tuple");
      const [id, label, description] = variant.elements.map(literal);
      if (!id || !label || !description) fail("expected literal permission copy");
      record(`permission.option.${id}.label`, { defaultValue: label });
      record(`permission.option.${id}.description`, { defaultValue: description });
    }
  }

  if (name === "CLIENT_TRANSCRIPT_ERRORS" || name === "COUNTER_COPY") {
    const dictionary =
      ts.isAsExpression(value) || ts.isSatisfiesExpression(value) ? value.expression : value;
    const counter = name === "COUNTER_COPY";
    for (const entry of objectMembers(dictionary).values()) {
      const fields = objectMembers(entry);
      const key = literal(fields.get(counter ? "i18nKey" : "key"));
      const text = literal(fields.get(counter ? "defaults" : "message"));
      if (!key || !text) fail(`expected literal copy in ${name}`);
      record(key, { defaultValue: text }, counter);
    }
  }
}

function sourceMessages() {
  const messages = new Map<string, Message>();
  const files = ts.sys.readDirectory(
    desktop,
    [".ts", ".tsx"],
    ["**/*.test.*", "**/*.spec.*", "**/*.d.ts", "**/generated/**", "**/test/**"],
    ["src/**/*", "electron/**/*"],
  );
  for (const path of files) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const file = basename(path);
    function visit(node: ts.Node) {
      const fail = (message: string): never => {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        throw new Error(`${path}:${line + 1}: ${message}`);
      };
      const record: RecordMessage = (key, forms, plural = false) => {
        const previous = messages.get(key);
        for (const [form, value] of Object.entries(forms)) {
          const existing = previous?.forms[form as keyof Forms];
          if (existing !== undefined && existing !== value) fail(`conflicting defaults for ${key}`);
        }
        const hasPluralForms = Object.keys(forms).some((form) => form !== "defaultValue");
        messages.set(key, {
          forms: { ...previous?.forms, ...forms },
          plural: previous?.plural === true || plural || hasPluralForms,
        });
      };

      if (ts.isCallExpression(node)) collectTranslationCall(node, file, record, fail);
      collectDescriptors(node, record, fail);
      if (
        (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
        node.tagName.getText() === "UiTrans"
      ) {
        // Counter pills spread the descriptor table parsed by collectDescriptors.
        const spreadsCounterCopy =
          file === "UnifiedAgentsCounterPill.tsx" &&
          node.attributes.properties.some(
            (property) =>
              ts.isJsxSpreadAttribute(property) &&
              property.expression.getText() === "COUNTER_COPY[state]",
          );
        if (!spreadsCounterCopy) {
          const props = new Map(
            node.attributes.properties
              .filter(ts.isJsxAttribute)
              .map((property) => [property.name.getText(), property.initializer]),
          );
          collectRichText(props, record, fail);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  // Run the real navigation builder so additions and ID changes enter the contract.
  settingsNavGroups((key, defaultValue) => {
    const existing = messages.get(key);
    if (existing && existing.forms.defaultValue !== defaultValue) {
      throw new Error(`conflicting settings defaults for ${key}`);
    }
    if (!existing) messages.set(key, { forms: { defaultValue }, plural: false });
    return defaultValue;
  });
  return messages;
}

function catalogContract(locale: string, messages: ReadonlyMap<string, Message>) {
  const expected = new Map(language);
  const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  for (const [key, { forms, plural }] of messages) {
    const defaultValue = forms.defaultValue ?? forms.defaultValue_other;
    if (defaultValue === undefined) throw new Error(`missing base or other default for ${key}`);
    if (!plural) {
      expected.set(`ui.${key}`, defaultValue);
      continue;
    }
    for (const category of categories) {
      // Extra locale categories use the generic English branch for token validation.
      expected.set(`ui.${key}_${category}`, forms[`defaultValue_${category}`] ?? defaultValue);
    }
    if (forms.defaultValue_zero !== undefined) {
      // i18next exact-zero overrides apply even in languages with no CLDR zero category.
      expected.set(`ui.${key}_zero`, forms.defaultValue_zero);
    }
  }
  return expected;
}

function readCatalog(locale: string) {
  const root: unknown = JSON.parse(readFileSync(join(catalogs, `${locale}.json`), "utf8"));
  const messages = new Map<string, string>();
  function visit(value: unknown, path: string) {
    if (typeof value === "string" && value.trim().length > 0 && path) {
      messages.set(path, value);
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) {
      throw new Error(`${locale}: expected a message or namespace at ${path}`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key.includes(".")) throw new Error(`${locale}: expected nested keys at ${path}.${key}`);
      visit(child, path ? `${path}.${key}` : key);
    }
  }
  visit(root, "");
  return messages;
}

function messageTokens(value: string) {
  const placeholders = Array.from(value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/gu), ([, parameter]) =>
    parameter.replace(/\s*,\s*/gu, ",").trim(),
  );
  const tags = Array.from(value.matchAll(/<(\/?)([\w]+)\s*(\/?)>/gu));
  const stack: string[] = [];
  for (const [, close, name, standalone] of tags) {
    if (close && stack.pop() !== name) throw new Error(`unbalanced rich-text tags in ${value}`);
    if (!close && !standalone) stack.push(name);
  }
  if (stack.length) throw new Error(`unbalanced rich-text tags in ${value}`);
  const code = Array.from(value.matchAll(/`([^`]+)`/gu), ([, span]) => span);
  // Some tool identifiers and CLI flags appear in plain text, including in search keywords.
  const identifiers = value.match(/\bcadencr-[a-z][a-z-]*\b|(?<![\w-])--[a-zA-Z][\w-]*/gu) ?? [];
  return [
    ...placeholders.map((name) => `{{${name}}}`).sort(),
    ...tags.map(([, close, name, standalone]) => `<${close}${name}${standalone}>`).sort(),
    ...code.sort(),
    ...identifiers.sort(),
  ].join("\n");
}

describe("interface translation catalogs", () => {
  let messages: ReadonlyMap<string, Message>;
  it("ships exactly one catalog per supported locale", () => {
    expect(
      readdirSync(catalogs)
        .filter((file) => file.endsWith(".json"))
        .sort(),
    ).toEqual(locales.map((locale) => `${locale}.json`).sort());
  });

  it.each(locales)("covers production copy in %s", (locale) => {
    messages ??= sourceMessages();
    const expected = catalogContract(locale, messages);
    const actual = readCatalog(locale);
    const problems: string[] = [];
    for (const [key, english] of expected) {
      const translation = actual.get(key);
      if (translation === undefined) problems.push(`missing: ${key}`);
      else if (locale === DEFAULT_LANGUAGE && translation !== english)
        problems.push(`source mismatch: ${key}`);
      else if (messageTokens(translation) !== messageTokens(english)) {
        problems.push(`interpolation, rich text, code or tool identifier changed: ${key}`);
      }
    }
    for (const key of actual.keys()) {
      if (!expected.has(key)) problems.push(`unused: ${key}`);
    }
    expect(problems.slice(0, 40), `${problems.length} catalog errors`).toEqual([]);
  });
});
