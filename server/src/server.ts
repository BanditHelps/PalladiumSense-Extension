import {
    createConnection,
    ProposedFeatures,
    InitializeParams,
    TextDocuments,
    CompletionItem,
    CompletionItemKind,
    Hover,
    Diagnostic,
    DiagnosticSeverity,
    Range,
    TextDocumentPositionParams,
    TextDocumentSyncKind,
    Position,
    InsertTextFormat,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as path from 'path';
import * as cheerio from 'cheerio';
import { fileURLToPath } from 'url';
import { parseTree, findNodeAtOffset, Node as JsonNode, getLocation } from 'jsonc-parser';

type WatchTarget = { kind: 'folder' | 'file'; path: string };

interface InitOptions {
    docsRoot?: string;
    abilitiesFile?: string;
    conditionsFile?: string;
}

interface AbilityField {
    name: string;
    type?: string;
    description?: string;
    required?: boolean;
    fallback?: string;
}

interface AbilityRecord {
    id: string;
    name: string;
    snippet: string;
    example: string;
    description?: string;
    source?: string;
    fields: AbilityField[];
    fieldIndex: Map<string, AbilityField>;
}

interface ResolveResult {
    entries: AbilityRecord[];
    watchTarget?: WatchTarget | null;
}

interface AbilityFieldCompletionContext {
    ability: AbilityRecord;
    replaceRange: Range;
    usedFields: Set<string>;
}

type HoverContext =
    | { kind: "ability"; docKind: DocKind; entryId: string }
    | { kind: "field"; docKind: DocKind; entryId: string; fieldName: string };

const connection = createConnection(ProposedFeatures.all);
type DocKind = "ability" | "condition";

const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
const fsp = fs.promises;

let abilities: AbilityRecord[] = createFallbackAbilities();
let abilityMap: Map<string, AbilityRecord> = buildAbilityMap(abilities);
let conditions: AbilityRecord[] = [];
let conditionMap: Map<string, AbilityRecord> = buildAbilityMap(conditions);
let preferredSources: InitOptions = {};

interface WatchState {
    watcher: fs.FSWatcher | null;
    target: WatchTarget | null;
    timer: NodeJS.Timeout | null;
}

const watchStates: Record<DocKind, WatchState> = {
    ability: { watcher: null, target: null, timer: null },
    condition: { watcher: null, target: null, timer: null }
};

const DIAGNOSTIC_SOURCE = "palladium";
const ALWAYS_ALLOWED_ABILITY_FIELDS = new Set<string>(["type", "conditions"]);

connection.onInitialize(async (params: InitializeParams) => {
    preferredSources = {
        docsRoot: params.initializationOptions?.docsRoot,
        abilitiesFile: params.initializationOptions?.abilitiesFile,
        conditionsFile: params.initializationOptions?.conditionsFile,
    };

    await Promise.all([
        reloadAbilities("initial load"),
        reloadConditions("initial load")
    ]);

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: { resolveProvider: true },
            hoverProvider: true
        }
    };
});

connection.onShutdown(() => {
    disposeWatcher("ability");
    disposeWatcher("condition");
});

connection.onDidChangeWatchedFiles(event => {
    if (!event.changes.length) {
        return;
    }

    const pending = new Set<DocKind>();

    for (const change of event.changes) {
        try {
            const fsPath = fileURLToPath(change.uri);
            const kinds = detectDocKindsForPath(fsPath);
            kinds.forEach(kind => pending.add(kind));
        } catch {
            // ignore invalid URIs
        }
    }

    pending.forEach(kind => scheduleReload(kind, "VS Code watcher"));
});

// Auto-completion
connection.onCompletion(
    (params: TextDocumentPositionParams): CompletionItem[] => {
        const doc = documents.get(params.textDocument.uri);
        if (!doc) {
            return [];
        }

        const fieldContext = resolveAbilityFieldCompletionContext(doc, params.position);
        if (fieldContext) {
            return buildAbilityFieldCompletions(fieldContext);
        }

        const ctx = resolveCompletionContext(doc, params.position);
        if (ctx === "condition") {
            const needsComma = shouldAddTrailingComma(doc, params.position);
            return conditions.map(c => ({
                label: c.name,
                kind: CompletionItemKind.Snippet,
                detail: c.id,
                documentation: buildDocumentationSummary(c),
                insertTextFormat: InsertTextFormat.Snippet,
                insertText: needsComma ? `${c.snippet},` : c.snippet,
            }));
        }

        if (ctx === "ability") {
            const needsComma = shouldAddTrailingComma(doc, params.position);
            return abilities.map(a => ({
                label: a.name,
                kind: CompletionItemKind.Snippet,
                detail: a.id,
                documentation: buildDocumentationSummary(a),
                insertTextFormat: InsertTextFormat.Snippet,
                insertText: needsComma ? `${a.snippet},` : a.snippet,
            }));
        }

        return [];
    }
);

connection.onCompletionResolve(
    (item: CompletionItem): CompletionItem => item
);

// Hover Tooltip
connection.onHover((params): Hover | null => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) { return null; }

    const context = resolveHoverContext(doc, params.position);
    if (context) {
        const map = context.docKind === "condition" ? conditionMap : abilityMap;
        const entry = map.get(context.entryId);
        if (entry) {
            if (context.kind === "field") {
                const field = entry.fieldIndex.get(context.fieldName);
                if (field) {
                    return formatFieldHover(entry, field, context.docKind);
                }
            } else {
                return formatEntryHover(entry, context.docKind);
            }
        }
    }

    const word = extractWord(doc, params.position);
    if (!word) { return null; }

    const ability =
        abilityMap.get(word) ?? abilities.find(a => a.name === word || a.id.includes(word));

    return ability ? formatEntryHover(ability, "ability") : null;
});

documents.onDidOpen(event => validateDocument(event.document));
documents.onDidChangeContent(change => validateDocument(change.document));
documents.onDidClose(event => {
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

documents.listen(connection);
connection.listen();

function formatEntryHover(entry: AbilityRecord, kind: DocKind): Hover {
    const label = kind === "condition" ? "Condition" : "Ability";
    const lines = [
        `### ${entry.name}`,
        `**${label} ID:** ${entry.id}`,
        entry.source ? `**Source:** ${entry.source}` : undefined,
        entry.description ? entry.description : undefined,
        "**Example:**",
        "```json",
        entry.example,
        "```"
    ].filter(Boolean);

    return {
        contents: {
            kind: "markdown",
            value: lines.join("\n\n")
        }
    };
}

function formatFieldHover(entry: AbilityRecord, field: AbilityField, kind: DocKind): Hover {
    const label = kind === "condition" ? "Condition" : "Ability";
    const metaLines = [
        `**${label}:** ${entry.id}`,
        field.type ? `**Type:** ${field.type}` : undefined,
        field.required !== undefined ? `**Required:** ${field.required ? "Yes" : "No"}` : undefined,
        field.fallback ? `**Default:** ${inlineCode(field.fallback)}` : undefined,
        entry.source ? `**Source:** ${entry.source}` : undefined
    ].filter(Boolean);

    const sections = [
        `### ${field.name}`,
        metaLines.join("\n\n"),
        field.description
    ].filter(Boolean);

    return {
        contents: {
            kind: "markdown",
            value: sections.join("\n\n")
        }
    };
}

function resolveHoverContext(document: TextDocument, position: Position): HoverContext | undefined {
    const text = document.getText();
    const tree = parseTree(text);
    if (!tree) {
        return undefined;
    }

    const offset = document.offsetAt(position);
    const node = findNodeAtOffset(tree, offset, true);
    if (!node) {
        return undefined;
    }

    const propertyNode = getPropertyNode(node);
    if (!propertyNode || !propertyNode.children || propertyNode.children.length < 2) {
        return undefined;
    }

    const [keyNode, valueNode] = propertyNode.children;
    if (!keyNode || keyNode.type !== "string") {
        return undefined;
    }

    const objectNode = getEnclosingObject(propertyNode);
    if (!objectNode) {
        return undefined;
    }

    const docKind = determineDocKind(document, objectNode);
    if (!docKind) {
        return undefined;
    }

    const entryId = findTypeIdentifier(objectNode);
    if (!entryId) {
        return undefined;
    }

    if (keyNode.value === "type" && valueNode?.type === "string" && isNodeWithin(node, valueNode)) {
        return { kind: "ability", docKind, entryId: String(valueNode.value) };
    }

    if (keyNode.value !== "type" && isWithinProperty(node, propertyNode)) {
        return { kind: "field", docKind, entryId, fieldName: String(keyNode.value) };
    }

    return undefined;
}

function resolveCompletionContext(document: TextDocument, position: Position): DocKind | undefined {
    const text = document.getText();
    const offset = document.offsetAt(position);
    const location = getLocation(text, offset);
    const path = location.path;

    if (isConditionPath(path)) {
        return "condition";
    }

    if (isAbilityPath(path)) {
        return "ability";
    }

    return undefined;
}

function shouldAddTrailingComma(document: TextDocument, position: Position): boolean {
    const text = document.getText();
    const offset = document.offsetAt(position);

    for (let idx = offset; idx < text.length; idx++) {
        const char = text.charAt(idx);

        if (char === " " || char === "\t" || char === "\r" || char === "\n") {
            continue;
        }

        if (char === "}" || char === "]") {
            return false;
        }

        return true;
    }

    return false;
}

function determineDocKind(document: TextDocument, objectNode: JsonNode): DocKind | undefined {
    const text = document.getText();
    const location = getLocation(text, objectNode.offset);
    return docKindFromPath(location.path);
}

function docKindFromPath(path: Array<string | number>): DocKind | undefined {
    if (isConditionPath(path)) {
        return "condition";
    }

    if (isAbilityPath(path)) {
        return "ability";
    }

    return undefined;
}

function getPropertyNode(node: JsonNode | undefined): JsonNode | undefined {
    let current: JsonNode | undefined = node;
    while (current) {
        if (current.type === "property") {
            return current;
        }
        current = current.parent;
    }
    return undefined;
}

function getEnclosingObject(node: JsonNode | undefined): JsonNode | undefined {
    let current: JsonNode | undefined = node;
    while (current) {
        if (current.type === "object") {
            return current;
        }
        current = current.parent;
    }
    return undefined;
}

function isAbilityEntryObject(node: JsonNode): boolean {
    const parentProperty = node.parent;
    if (!parentProperty || parentProperty.type !== "property") {
        return false;
    }

    const abilitiesObject = parentProperty.parent;
    if (!abilitiesObject || abilitiesObject.type !== "object") {
        return false;
    }

    const abilitiesProperty = abilitiesObject.parent;
    if (!abilitiesProperty || abilitiesProperty.type !== "property") {
        return false;
    }

    const [keyNode] = abilitiesProperty.children ?? [];
    return keyNode?.type === "string" && keyNode.value === "abilities";
}

function findTypeIdentifier(objectNode: JsonNode | undefined): string | undefined {
    const typeNode = findPropertyValueNode(objectNode, "type");
    if (typeNode?.type === "string") {
        return String(typeNode.value);
    }
    return undefined;
}

function findPropertyValueNode(objectNode: JsonNode | undefined, propertyName: string): JsonNode | undefined {
    if (!objectNode?.children) {
        return undefined;
    }

    for (const child of objectNode.children) {
        if (child.type !== "property" || !child.children || child.children.length < 2) {
            continue;
        }

        const [keyNode, valueNode] = child.children;
        if (keyNode?.type === "string" && keyNode.value === propertyName) {
            return valueNode;
        }
    }

    return undefined;
}

function isWithinProperty(node: JsonNode | undefined, property: JsonNode): boolean {
    if (!node) {
        return false;
    }

    if (node === property) {
        return true;
    }

    const [keyNode, valueNode] = property.children ?? [];
    return isNodeWithin(node, keyNode) || isNodeWithin(node, valueNode);
}

function isNodeWithin(target: JsonNode | undefined, container: JsonNode | undefined): boolean {
    if (!target || !container) {
        return false;
    }

    let current: JsonNode | undefined = target;
    while (current) {
        if (current === container) {
            return true;
        }
        current = current.parent;
    }

    return false;
}

function inlineCode(value: string): string {
    return `\`${value.replace(/`/g, "\\`")}\``;
}

function extractWord(document: TextDocument, position: Position): string {
    const text = document.getText();
    const offset = document.offsetAt(position);

    const isWordChar = (char: string) => /[\w:._-]/.test(char);

    let start = offset;
    while (start > 0 && isWordChar(text.charAt(start - 1))) {
        start--;
    }

    let end = offset;
    while (end < text.length && isWordChar(text.charAt(end))) {
        end++;
    }

    return text.slice(start, end);
}

function isAbilityPath(path: Array<string | number>): boolean {
    return path.some(segment => segment === "abilities");
}

function isConditionPath(path: Array<string | number>): boolean {
    return path.some(segment => segment === "conditions");
}

function buildDocumentationSummary(ability: AbilityRecord): string | undefined {
    const lines = [
        ability.description?.trim(),
        ability.source ? `Source: ${ability.source}` : undefined,
    ].filter(Boolean);

    return lines.length ? lines.join('\n\n') : undefined;
}

function resolveAbilityFieldCompletionContext(
    document: TextDocument,
    position: Position
): AbilityFieldCompletionContext | undefined {
    const text = document.getText();
    const offset = document.offsetAt(position);
    const location = getLocation(text, offset);

    const tree = parseTree(text);
    if (!tree) {
        return undefined;
    }

    const node = findNodeAtOffset(tree, offset, true);
    if (!node) {
        return undefined;
    }

    const objectNode = getEnclosingObject(node);
    if (!objectNode || !isAbilityEntryObject(objectNode)) {
        return undefined;
    }

    const isKeyPosition = location.isAtPropertyKey || node === objectNode;
    if (!isKeyPosition) {
        return undefined;
    }

    const typeId = findTypeIdentifier(objectNode);
    if (!typeId) {
        return undefined;
    }

    const ability = abilityMap.get(typeId);
    if (!ability || ability.fields.length === 0) {
        return undefined;
    }

    const propertyNode =
        node === objectNode
            ? undefined
            : getPropertyNode(node);

    if (propertyNode && propertyNode.parent !== objectNode) {
        return undefined;
    }

    const keyNode = propertyNode?.children?.[0];
    const replaceRange = computePropertyKeyReplaceRange(document, position, text, location, keyNode);

    return {
        ability,
        replaceRange,
        usedFields: collectUsedFieldNames(objectNode, propertyNode),
    };
}

function buildAbilityFieldCompletions(context: AbilityFieldCompletionContext): CompletionItem[] {
    const items: CompletionItem[] = [];

    for (const field of context.ability.fields) {
        if (context.usedFields.has(field.name)) {
            continue;
        }

        items.push({
            label: field.name,
            kind: CompletionItemKind.Property,
            detail: field.type,
            documentation: buildFieldDocumentation(field),
            insertTextFormat: InsertTextFormat.Snippet,
            textEdit: {
                range: context.replaceRange,
                newText: buildFieldInsertText(field),
            },
        });
    }

    return items;
}

function buildFieldDocumentation(field: AbilityField): string | undefined {
    const parts = [field.description?.trim()].filter(Boolean) as string[];

    const meta = [
        field.type ? `**Type:** ${field.type}` : undefined,
        field.required !== undefined ? `**Required:** ${field.required ? "Yes" : "No"}` : undefined,
        field.fallback ? `**Default:** ${field.fallback}` : undefined,
    ].filter(Boolean);

    if (meta.length) {
        parts.push(meta.join("\n\n"));
    }

    return parts.length ? parts.join("\n\n") : undefined;
}

function buildFieldInsertText(field: AbilityField): string {
    return `"${field.name}": ${buildFieldValueSnippet(field)}`;
}

function buildFieldValueSnippet(field: AbilityField): string {
    const fallbackSnippet = normalizeFallbackSnippet(field.fallback);
    if (fallbackSnippet) {
        return fallbackSnippet;
    }

    const normalizedType = field.type?.toLowerCase() ?? "";

    if (normalizedType.includes("bool")) {
        return createPlaceholder("false");
    }

    if (
        normalizedType.includes("int") ||
        normalizedType.includes("float") ||
        normalizedType.includes("double") ||
        normalizedType.includes("number") ||
        normalizedType.includes("amount") ||
        normalizedType.includes("cost") ||
        normalizedType.includes("range") ||
        normalizedType.includes("cooldown") ||
        normalizedType.includes("duration")
    ) {
        return createPlaceholder("0");
    }

    if (
        normalizedType.includes("list") ||
        normalizedType.includes("array") ||
        normalizedType.includes("vec") ||
        normalizedType.includes("command") ||
        normalizedType.includes("conditions")
    ) {
        return "[\n    ${1}\n]";
    }

    if (
        normalizedType.includes("object") ||
        normalizedType.includes("component") ||
        normalizedType.includes("description") ||
        normalizedType.includes("compound")
    ) {
        return "{\n    ${1}\n}";
    }

    return stringSnippetPlaceholder("value");
}

function normalizeFallbackSnippet(raw?: string): string | undefined {
    if (!raw) {
        return undefined;
    }

    const trimmed = raw.trim();
    if (!trimmed || trimmed === "/") {
        return undefined;
    }

    const parsed = tryParseJsonValue(trimmed);
    if (parsed) {
        switch (parsed.kind) {
            case "string":
                return stringSnippetPlaceholder(parsed.value);
            case "number":
            case "boolean":
            case "null":
                return createPlaceholder(parsed.raw);
            case "array":
            case "object":
                return trimmed;
        }
    }

    return stringSnippetPlaceholder(trimmed);
}

function tryParseJsonValue(
    value: string
): { kind: "string" | "number" | "boolean" | "object" | "array" | "null"; value: string; raw: string } | undefined {
    try {
        const parsed = JSON.parse(value);
        if (parsed === null) {
            return { kind: "null", value: "null", raw: "null" };
        }
        if (Array.isArray(parsed)) {
            return { kind: "array", value, raw: value };
        }
        switch (typeof parsed) {
            case "string":
                return { kind: "string", value: parsed, raw: value };
            case "number":
                return { kind: "number", value, raw: value };
            case "boolean":
                return { kind: "boolean", value: parsed ? "true" : "false", raw: parsed ? "true" : "false" };
            case "object":
                return { kind: "object", value, raw: value };
            default:
                return undefined;
        }
    } catch {
        return undefined;
    }
}

function createPlaceholder(defaultValue: string): string {
    const safe = escapeSnippet(defaultValue || "value");
    return `\${1:${safe}}`;
}

function stringSnippetPlaceholder(defaultValue: string): string {
    return `"${createPlaceholder(defaultValue || "value")}"`;
}

function collectUsedFieldNames(objectNode: JsonNode, ignoreProperty?: JsonNode): Set<string> {
    const fields = new Set<string>();

    for (const propertyNode of objectNode.children ?? []) {
        if (propertyNode.type !== "property" || !propertyNode.children?.length) {
            continue;
        }

        if (ignoreProperty && propertyNode === ignoreProperty) {
            continue;
        }

        const [keyNode] = propertyNode.children;
        if (keyNode?.type === "string") {
            fields.add(String(keyNode.value));
        }
    }

    return fields;
}

function validateDocument(document: TextDocument): void {
    const diagnostics: Diagnostic[] = [];

    try {
        const text = document.getText();
        const tree = parseTree(text);

        if (tree) {
            const visitNode = (node: JsonNode | undefined) => {
                if (!node) {
                    return;
                }

                if (node.type === "object") {
                    const location = getLocation(text, node.offset);
                    const docKind = docKindFromPath(location.path);
                    if (docKind === "ability") {
                        validateAbilityObject(document, node, diagnostics);
                    }
                }

                node.children?.forEach(visitNode);
            };

            visitNode(tree);
        }
    } catch (error) {
        connection.console.error(`[Validation] Failed for ${document.uri}: ${formatError(error)}`);
    } finally {
        connection.sendDiagnostics({ uri: document.uri, diagnostics });
    }
}

function validateAllDocuments(): void {
    for (const doc of documents.all()) {
        validateDocument(doc);
    }
}

function validateAbilityObject(document: TextDocument, objectNode: JsonNode, diagnostics: Diagnostic[]): void {
    const typeNode = findPropertyValueNode(objectNode, "type");
    if (!typeNode || typeNode.type !== "string") {
        return;
    }

    const typeId = String(typeNode.value);
    const ability = abilityMap.get(typeId);
    if (!ability) {
        diagnostics.push({
            severity: DiagnosticSeverity.Error,
            message: `Unknown ability type "${typeId}".`,
            range: rangeFromNode(document, typeNode),
            source: DIAGNOSTIC_SOURCE,
        });
        return;
    }

    if (!ability.fieldIndex.size) {
        return;
    }

    for (const propertyNode of objectNode.children ?? []) {
        if (propertyNode.type !== "property" || !propertyNode.children?.length) {
            continue;
        }

        const [keyNode] = propertyNode.children;
        if (!keyNode || keyNode.type !== "string") {
            continue;
        }

        const fieldName = String(keyNode.value);
        if (ALWAYS_ALLOWED_ABILITY_FIELDS.has(fieldName) || ability.fieldIndex.has(fieldName)) {
            continue;
        }

        diagnostics.push({
            severity: DiagnosticSeverity.Error,
            message: `Field "${fieldName}" is not defined for ability type "${typeId}".`,
            range: rangeFromNode(document, keyNode),
            source: DIAGNOSTIC_SOURCE,
        });
    }
}

function rangeFromNode(document: TextDocument, node: JsonNode): Range {
    const start = document.positionAt(node.offset);
    const end = document.positionAt(node.offset + (node.length ?? 0));
    return { start, end };
}

function computePropertyKeyReplaceRange(
    document: TextDocument,
    position: Position,
    text: string,
    location: ReturnType<typeof getLocation>,
    keyNode?: JsonNode
): Range {
    if (keyNode && keyNode.type === "string") {
        return rangeFromNode(document, keyNode);
    }

    const previousNode = location.previousNode;
    if (previousNode && previousNode.type === "string") {
        return rangeFromNode(document, previousNode);
    }

    const offset = document.offsetAt(position);
    let start = offset;
    let end = offset;

    if (start > 0 && text.charAt(start - 1) === '"') {
        start -= 1;
    }

    if (end < text.length && text.charAt(end) === '"') {
        end += 1;
    }

    return {
        start: document.positionAt(start),
        end: document.positionAt(end),
    };
}

async function reloadAbilities(reason?: string): Promise<void> {
    try {
        const { entries, watchTarget } = await resolveAbilities(preferredSources);
        abilities = entries.length ? entries : createFallbackAbilities();
        abilityMap = buildAbilityMap(abilities);

        configureWatcher("ability", watchTarget ?? null);
        connection.console.info(
            `[Abilities] Loaded ${abilities.length} entries${reason ? ` (${reason})` : ""}`
        );
    } catch (error) {
        connection.console.error(`[Abilities] Failed to load: ${formatError(error)}`);
        abilities = createFallbackAbilities();
        abilityMap = buildAbilityMap(abilities);
        configureWatcher("ability", getDocsFolderWatchTarget());
    } finally {
        validateAllDocuments();
    }
}

async function reloadConditions(reason?: string): Promise<void> {
    try {
        const { entries, watchTarget } = await resolveConditions(preferredSources);
        conditions = entries;
        conditionMap = buildAbilityMap(conditions);

        configureWatcher("condition", watchTarget ?? null);
        connection.console.info(
            `[Conditions] Loaded ${conditions.length} entries${reason ? ` (${reason})` : ""}`
        );
    } catch (error) {
        connection.console.error(`[Conditions] Failed to load: ${formatError(error)}`);
        conditions = [];
        conditionMap = buildAbilityMap(conditions);
        configureWatcher("condition", getDocsFolderWatchTarget());
    } finally {
        validateAllDocuments();
    }
}

async function resolveAbilities(config: InitOptions): Promise<ResolveResult> {
    const abilityFile = getAbilityFilePath(config);
    if (abilityFile && await fileExists(abilityFile)) {
        const entries = await loadFromFile(abilityFile, path.basename(abilityFile));
        return { entries, watchTarget: { kind: "file" as const, path: abilityFile } };
    }

    const bundledPath = path.resolve(__dirname, "..", "..", "examples", "abilities.html");
    const fallbackList = await loadFromFile(bundledPath, "examples/abilities.html");
    const watchTarget = config.docsRoot ? { kind: "folder" as const, path: config.docsRoot } : null;
    return { entries: fallbackList.length ? fallbackList : createFallbackAbilities(), watchTarget };
}

async function resolveConditions(config: InitOptions): Promise<ResolveResult> {
    const conditionFile = getConditionFilePath(config);
    if (conditionFile && await fileExists(conditionFile)) {
        const entries = await loadFromFile(conditionFile, path.basename(conditionFile));
        return { entries, watchTarget: { kind: "file" as const, path: conditionFile } };
    }

    const watchTarget = config.docsRoot ? { kind: "folder" as const, path: config.docsRoot } : null;
    return { entries: [], watchTarget };
}

async function loadFromFile(filePath: string, sourceLabel: string): Promise<AbilityRecord[]> {
    try {
        const stats = await fsp.stat(filePath);
        if (!stats.isFile()) {
            return [];
        }

        const html = await fsp.readFile(filePath, "utf8");
        return parseAbilityHtml(html, sourceLabel);
    } catch (error) {
        connection.console.warn(`[Abilities] Unable to read file ${filePath}: ${formatError(error)}`);
        return [];
    }
}

function parseAbilityHtml(html: string, sourceLabel: string): AbilityRecord[] {
    const $ = cheerio.load(html);
    const result: AbilityRecord[] = [];

    $("div[id]").each((_idx, element) => {
        const block = $(element);
        const id = block.attr("id")?.trim();
        if (!id || !id.includes(":")) {
            return;
        }

        const snippetElement = block.find("pre.json-snippet").first();
        if (!snippetElement.length) {
            return;
        }

        const exampleRaw = snippetElement.text().trim();
        if (!exampleRaw) {
            return;
        }

        const name = block.find("h2").first().text().trim() || id;
        const description = block.find("p").first().text().trim();
        const fields = parseAbilityFields($, block);
        const fieldIndex = new Map(fields.map(field => [field.name, field]));
        const { snippet, pretty } = buildSnippetFromExample(exampleRaw);

        result.push({
            id,
            name,
            snippet,
            example: pretty,
            description,
            source: sourceLabel,
            fields,
            fieldIndex
        });
    });

    return dedupeAbilities(result);
}

function parseAbilityFields(
    $: cheerio.CheerioAPI,
    block: cheerio.Cheerio<any>
): AbilityField[] {
    const tables = block.find("table").toArray();

    for (const tableElement of tables) {
        const table = $(tableElement);
        const headers = table
            .find("thead th")
            .toArray()
            .map(header => $(header).text().trim().toLowerCase());

        if (!headers.length || headers[0] !== "setting") {
            continue;
        }

        const rows = table.find("tbody tr");
        const fields: AbilityField[] = [];

        rows.each((_rowIdx, row) => {
            const cells = $(row).find("td").toArray();
            if (cells.length < 5) {
                return;
            }

            const name = extractCellText($(cells[0]));
            if (!name) {
                return;
            }

            const type = extractCellText($(cells[1]));
            const description = extractCellText($(cells[2]));
            const required = parseRequiredFlag(extractCellText($(cells[3])));
            const fallback = extractCellText($(cells[4]));

            fields.push({
                name,
                type: type || undefined,
                description: description || undefined,
                required,
                fallback: fallback && fallback !== "/" ? fallback : undefined,
            });
        });

        return fields;
    }

    return [];
}

function extractCellText(cell: cheerio.Cheerio<any>): string {
    return cell.text().replace(/\s+/g, " ").trim();
}

function parseRequiredFlag(raw: string): boolean | undefined {
    if (!raw) {
        return undefined;
    }

    const normalized = raw.trim().toLowerCase();
    if (normalized === "true") {
        return true;
    }
    if (normalized === "false") {
        return false;
    }
    return undefined;
}

// This is where the snippets get added
function buildSnippetFromExample(example: string): { snippet: string; pretty: string } {
    try {
        const parsed = JSON.parse(example);
        let tabIndex = 1;

        const renderValue = (value: unknown, depth: number): string => {
            const indent = "    ".repeat(depth);
            const nextIndent = "    ".repeat(depth + 1);

            if (Array.isArray(value)) {
                if (!value.length) {
                    return "[]";
                }

                const items = value.map(item => `${nextIndent}${renderValue(item, depth + 1)}`);
                return `[\n${items.join(",\n")}\n${indent}]`;
            }

            if (value && typeof value === "object") {
                const entries = Object.entries(value as Record<string, unknown>);
                if (!entries.length) {
                    return "{}";
                }

                const lines = entries.map(([key, val]) => `${nextIndent}"${key}": ${renderValue(val, depth + 1)}`);
                return `{\n${lines.join(",\n")}\n${indent}}`;
            }

            return buildPrimitiveSnippet(value);
        };

        const buildPrimitiveSnippet = (value: unknown): string => {
            const defaultText = value === null ? "null" : String(value ?? "");
            const escaped = escapeSnippet(defaultText);
            const placeholder = `\${${tabIndex++}:${escaped || "value"}}`;

            if (typeof value === "string") {
                return `"${placeholder}"`;
            }

            return placeholder;
        };

        const snippet = renderValue(parsed, 0);
        const pretty = JSON.stringify(parsed, null, 4);
        return { snippet, pretty };
    } catch {
        return { snippet: example, pretty: example };
    }
}

function escapeSnippet(value: string): string {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/\{/g, "\\{")
        .replace(/\}/g, "\\}")
        .replace(/\$/g, "\\$");
}

function dedupeAbilities(items: AbilityRecord[]): AbilityRecord[] {
    const map = new Map<string, AbilityRecord>();
    for (const ability of items) {
        map.set(ability.id, ability);
    }
    return Array.from(map.values());
}

function buildAbilityMap(items: AbilityRecord[]): Map<string, AbilityRecord> {
    const map = new Map<string, AbilityRecord>();
    for (const ability of items) {
        map.set(ability.id, ability);
    }
    return map;
}

function getDocsFolderWatchTarget(): WatchTarget | null {
    return preferredSources.docsRoot
        ? { kind: "folder" as const, path: preferredSources.docsRoot }
        : null;
}

function getAbilityFilePath(config: InitOptions = preferredSources): string | undefined {
    if (config.abilitiesFile) {
        return config.abilitiesFile;
    }
    if (config.docsRoot) {
        return path.join(config.docsRoot, "abilities.html");
    }
    return undefined;
}

function getConditionFilePath(config: InitOptions = preferredSources): string | undefined {
    if (config.conditionsFile) {
        return config.conditionsFile;
    }
    if (config.docsRoot) {
        return path.join(config.docsRoot, "conditions.html");
    }
    return undefined;
}

async function fileExists(filePath?: string): Promise<boolean> {
    if (!filePath) {
        return false;
    }

    try {
        const stats = await fsp.stat(filePath);
        return stats.isFile();
    } catch {
        return false;
    }
}

function createFallbackAbilities(): AbilityRecord[] {
    const fields: AbilityField[] = [
        {
            name: "power",
            type: "number",
            description: "Sample field"
        },
        {
            name: "cooldown",
            type: "number",
            description: "Sample field"
        }
    ];

    return [
        {
            id: "bandits_quirk_lib:blackwhip_detach",
            name: "blackwhip_detach",
            description: "Sample data – real abilities load from mods/documentation/palladium.",
            example: `{
    "type": "bandits_quirk_lib:blackwhip_detach",
    "power": 1,
    "cooldown": 10
}`,
            snippet: `{
    "type": "bandits_quirk_lib:blackwhip_detach",
    "power": \${1:1},
    "cooldown": \${2:10}
}`,
            fields,
            fieldIndex: new Map(fields.map(field => [field.name, field]))
        }
    ];
}

function configureWatcher(kind: DocKind, target: WatchTarget | null): void {
    const state = watchStates[kind];
    const label = labelForKind(kind);

    if (
        state.watcher &&
        (!target || !state.target || target.path !== state.target.path || target.kind !== state.target.kind)
    ) {
        disposeWatcher(kind);
    }

    state.target = target;

    if (!target || state.watcher) {
        return;
    }

    try {
        state.watcher = fs.watch(target.path, { persistent: false }, (_event, fileName) => {
            if (target.kind === "folder" && fileName && !fileName.toLowerCase().endsWith(".html")) {
                return;
            }
            scheduleReload(kind, `fs change in ${target.path}`);
        });
        state.watcher.on("error", error => {
            connection.console.error(`[${label}] Watcher error: ${formatError(error)}`);
        });
    } catch (error) {
        connection.console.error(`[${label}] Failed to watch ${target.path}: ${formatError(error)}`);
    }
}

function scheduleReload(kind: DocKind, reason?: string) {
    const state = watchStates[kind];
    const label = labelForKind(kind);
    if (state.timer) {
        clearTimeout(state.timer);
    }

    state.timer = setTimeout(() => {
        const reloadFn = kind === "condition" ? reloadConditions : reloadAbilities;
        reloadFn(reason).catch(err => {
            connection.console.error(`[${label}] Reload failed: ${formatError(err)}`);
        });
    }, 300);
}

function disposeWatcher(kind: DocKind) {
    const state = watchStates[kind];
    if (state.watcher) {
        state.watcher.close();
        state.watcher = null;
    }
    if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
    }
    state.target = null;
}

function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

function detectDocKindsForPath(fsPath: string): DocKind[] {
    const normalized = normalizeFsPath(fsPath);
    const matches: DocKind[] = [];

    if (
        matchesTarget(normalized, watchStates.ability.target) ||
        matchesExpectedPath(normalized, getAbilityFilePath(preferredSources))
    ) {
        matches.push("ability");
    }

    if (
        matchesTarget(normalized, watchStates.condition.target) ||
        matchesExpectedPath(normalized, getConditionFilePath(preferredSources))
    ) {
        matches.push("condition");
    }

    return matches;
}

function matchesTarget(pathValue: string, target: WatchTarget | null): boolean {
    if (!target) {
        return false;
    }
    const normalizedTarget = normalizeFsPath(target.path);
    if (target.kind === "file") {
        return pathValue === normalizedTarget;
    }
    return pathValue === normalizedTarget || pathValue.startsWith(`${normalizedTarget}${path.sep}`);
}

function matchesExpectedPath(pathValue: string, expected?: string): boolean {
    if (!expected) {
        return false;
    }
    return pathValue === normalizeFsPath(expected);
}

function normalizeFsPath(value: string): string {
    return path.resolve(value).toLowerCase();
}

function labelForKind(kind: DocKind): string {
    return kind === "condition" ? "Conditions" : "Abilities";
}
