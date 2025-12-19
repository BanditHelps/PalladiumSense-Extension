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
    energyRendersFile?: string;
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
type DocKind = "ability" | "condition" | "energy_renderer";

const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
const fsp = fs.promises;

let abilities: AbilityRecord[] = createFallbackAbilities();
let abilityMap: Map<string, AbilityRecord> = buildAbilityMap(abilities);
let conditions: AbilityRecord[] = [];
let conditionMap: Map<string, AbilityRecord> = buildAbilityMap(conditions);
let energyRenderers: AbilityRecord[] = createFallbackEnergyRenderers();
let energyRendererMap: Map<string, AbilityRecord> = buildAbilityMap(energyRenderers);
let preferredSources: InitOptions = {};

interface WatchState {
    watcher: fs.FSWatcher | null;
    target: WatchTarget | null;
    timer: NodeJS.Timeout | null;
}

const watchStates: Record<DocKind, WatchState> = {
    ability: { watcher: null, target: null, timer: null },
    condition: { watcher: null, target: null, timer: null },
    energy_renderer: { watcher: null, target: null, timer: null }
};

const DIAGNOSTIC_SOURCE = "palladium";
const ALWAYS_ALLOWED_ABILITY_FIELDS = new Set<string>(["type", "conditions"]);

connection.onInitialize(async (params: InitializeParams) => {
    preferredSources = {
        docsRoot: params.initializationOptions?.docsRoot,
        abilitiesFile: params.initializationOptions?.abilitiesFile,
        conditionsFile: params.initializationOptions?.conditionsFile,
        energyRendersFile: params.initializationOptions?.energyRendersFile
    };

    await Promise.all([
        reloadAbilities("initial load"),
        reloadConditions("initial load"),
        reloadEnergyRenderers("initial load")
    ]);

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: {
                resolveProvider: true,
                triggerCharacters: ['"', ':', ' ', ',', '[']
            },
            hoverProvider: true
        }
    };
});

connection.onShutdown(() => {
    disposeWatcher("ability");
    disposeWatcher("condition");
    disposeWatcher("energy_renderer");
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

        const energyFieldContext = resolveEnergyRendererFieldCompletionContext(doc, params.position);
        if (energyFieldContext) {
            return buildAbilityFieldCompletions(energyFieldContext);
        }

        const fieldContext = resolveAbilityFieldCompletionContext(doc, params.position);
        if (fieldContext) {
            return buildAbilityFieldCompletions(fieldContext);
        }

        if (shouldOfferEnergyRendererSnippets(doc, params.position)) {
            const needsComma = shouldAddTrailingComma(doc, params.position);
            return energyRenderers.map(r => ({
                label: r.name,
                kind: CompletionItemKind.Snippet,
                detail: r.id,
                filterText: `${r.name} ${r.id}`,
                sortText: r.name.toLowerCase(),
                documentation: buildDocumentationSummary(r),
                insertTextFormat: InsertTextFormat.Snippet,
                insertText: applyIndentationToSnippet(
                    needsComma ? `${r.snippet},` : r.snippet,
                    doc,
                    params.position
                ),
            }));
        }

        const ctx = resolveSnippetCompletionContext(doc, params.position);
        if (ctx === "condition") {
            const needsComma = shouldAddTrailingComma(doc, params.position);
            return conditions.map(c => ({
                label: c.name,
                kind: CompletionItemKind.Snippet,
                detail: c.id,
                filterText: `${c.name} ${c.id}`,
                sortText: c.name.toLowerCase(),
                documentation: buildDocumentationSummary(c),
                insertTextFormat: InsertTextFormat.Snippet,
                insertText: applyIndentationToSnippet(
                    needsComma ? `${c.snippet},` : c.snippet,
                    doc,
                    params.position
                ),
            }));
        }

        if (ctx === "ability") {
            const needsComma = shouldAddTrailingComma(doc, params.position);
            return abilities.map(a => ({
                label: a.name,
                kind: CompletionItemKind.Snippet,
                detail: a.id,
                filterText: `${a.name} ${a.id}`,
                sortText: a.name.toLowerCase(),
                documentation: buildDocumentationSummary(a),
                insertTextFormat: InsertTextFormat.Snippet,
                insertText: applyIndentationToSnippet(
                    needsComma ? `${a.snippet},` : a.snippet,
                    doc,
                    params.position
                ),
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
        // Special handling for body_part field in energy renderers
        if (context.kind === "field" && context.docKind === "energy_renderer" && context.fieldName === "body_part") {
            return {
                contents: {
                    kind: "markdown",
                    value: [
                        `### body_part`,
                        `**Type:** String`,
                        `**Required:** Yes`,
                        `**Values:** head, head_overlay, chest, chest_overlay, right_arm, right_arm_overlay, left_arm, left_arm_overlay, right_leg, right_leg_overlay, left_leg, left_leg_overlay, cape`
                    ].join("\n\n")
                }
            };
        }

        const map = context.docKind === "condition" 
            ? conditionMap 
            : context.docKind === "energy_renderer"
                ? energyRendererMap
                : abilityMap;
        const entry = map.get(context.entryId);
        if (entry) {
            if (context.kind === "field") {
                const field = entry.fieldIndex.get(context.fieldName);
                if (field) {
                    return formatFieldHover(entry, field, context.docKind);
                }
                // If we have a valid field context but no field definition, still return null
                // to prevent falling through to word matching
                return null;
            } else {
                return formatEntryHover(entry, context.docKind);
            }
        }
    }

    const word = extractWord(doc, params.position);
    if (!word) { return null; }

    // Check if this is an energy beams document and try energy renderers first
    if (isEnergyBeamsDocument(doc)) {
        const renderer =
            energyRendererMap.get(word) ?? energyRenderers.find(r => r.name === word || r.id.includes(word));
        if (renderer) {
            return formatEntryHover(renderer, "energy_renderer");
        }
    }

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
    const label =
        kind === "condition"
            ? "Condition"
            : kind === "energy_renderer"
                ? "Energy Renderer"
                : "Ability";
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
    const label =
        kind === "condition"
            ? "Condition"
            : kind === "energy_renderer"
                ? "Energy Renderer"
                : "Ability";
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
        // Use the determined docKind for the context, not hardcoded "ability"
        return { kind: "ability", docKind, entryId: String(valueNode.value) };
    }

    if (keyNode.value !== "type" && isWithinProperty(node, propertyNode)) {
        return { kind: "field", docKind, entryId, fieldName: String(keyNode.value) };
    }

    return undefined;
}

function resolveSnippetCompletionContext(document: TextDocument, position: Position): DocKind | undefined {
    const text = document.getText();
    const offset = document.offsetAt(position);
    const tree = parseTree(text);
    const location = getLocation(text, offset);

    if (!tree) {
        return undefined;
    }

    const node = findNodeAtOffset(tree, offset, true) ?? location.previousNode;
    const propertyNode = getPropertyNode(node);

    // Do not trigger while typing the key itself
    if (propertyNode?.children?.length) {
        const [keyNode] = propertyNode.children;
        if (keyNode?.type === "string" && isOffsetInsideNode(offset, keyNode)) {
            return undefined;
        }
    }

    const objectNode = getEnclosingObject(node);
    if (objectNode && isAbilityEntryObjectContext(objectNode)) {
        return "ability";
    }

    if (objectNode && isConditionEntryObjectContext(objectNode)) {
        return "condition";
    }

    const conditionArrayKind = isConditionArrayContext(node);
    if (conditionArrayKind) {
        return conditionArrayKind;
    }

    // Fallback to path-based detection when the value object hasn't been typed yet
    const docKindFromPath = resolveKindFromPath(location.path);
    return docKindFromPath ?? undefined;
}

function shouldOfferEnergyRendererSnippets(document: TextDocument, position: Position): boolean {
    if (!isEnergyBeamsDocument(document)) {
        return false;
    }

    const text = document.getText();
    const offset = document.offsetAt(position);
    const tree = parseTree(text);
    const location = getLocation(text, offset);
    if (!tree) {
        return false;
    }

    const node = findNodeAtOffset(tree, offset, true) ?? location.previousNode;

    // Don't offer renderer-object snippets while cursor is inside an existing renderer object.
    const objectNode = getEnclosingObject(node);
    if (objectNode && isEnergyBeamEntryObjectContext(objectNode)) {
        return false;
    }

    const arrayNode = findEnclosingArrayNode(document, position);
    return !!arrayNode && isEnergyBeamRootArrayContext(arrayNode);
}

function isOffsetInsideNode(offset: number, node: JsonNode): boolean {
    const start = node.offset;
    const end = node.offset + (node.length ?? 0);
    return offset >= start && offset <= end;
}

function findEnclosingArrayNode(document: TextDocument, position: Position): JsonNode | undefined {
    const text = document.getText();
    const tree = parseTree(text);
    if (!tree) { return undefined; }

    const offset = document.offsetAt(position);
    let node = findNodeAtOffset(tree, offset, true);
    while (node && node.type !== "array") {
        node = node.parent;
    }
    return node;
}

function applyIndentationToSnippet(snippet: string, document: TextDocument, position: Position): string {
    const arrayNode = findEnclosingArrayNode(document, position);
    const shouldIndent =
        !!arrayNode &&
        (isConditionArrayContext(arrayNode) === "condition" || (isEnergyBeamsDocument(document) && isEnergyBeamRootArrayContext(arrayNode)));
    if (!arrayNode || !shouldIndent) {
        return snippet;
    }

    const text = document.getText();
    const offset = document.offsetAt(position);

    const arrayStartLine = document.positionAt(arrayNode.offset).line;
    const arrayIndent = getLineIndent(text, arrayStartLine, document);
    const indentUnit = determineIndentUnit(text);
    const itemIndent = `${arrayIndent}${indentUnit}`;

    const prevCharIdx = findPreviousNonWhitespaceIndex(text, offset - 1);
    const prevChar = prevCharIdx !== undefined ? text.charAt(prevCharIdx) : undefined;
    const prevCharLine = prevCharIdx !== undefined ? document.positionAt(prevCharIdx).line : undefined;
    const currentIndent = getLineIndent(text, position.line, document);

    const reindentFromBase = (baseIndent: string): string => {
        return reindentSnippetWithUnit(snippet, baseIndent, indentUnit);
    };

    // Case 1: cursor is right after "[" on the same line – break to new line and indent item.
    if (prevChar === "[" && prevCharLine === arrayStartLine) {
        const indentedSnippet = reindentFromBase(itemIndent);
        const arrayClosingLine = document.positionAt(arrayNode.offset + (arrayNode.length ?? 0) - 1).line;
        const needsClosingIndent = arrayClosingLine === arrayStartLine;
        if (needsClosingIndent) {
            return `\n${indentedSnippet}\n${arrayIndent}`;
        }
        return `\n${indentedSnippet}`;
    }

    // Case 3a: cursor is after a "}" on the same line – start a new line aligned with previous item.
    if (prevChar === "}" && prevCharLine === position.line) {
        const previousIndent = getLineIndent(text, prevCharLine ?? position.line, document);
        const indentedSnippet = reindentFromBase(previousIndent);
        return `\n${indentedSnippet}`;
    }

    // Case 3b: cursor is after a "," that follows a "}" on the same line (e.g., "},<cursor>")
    if (prevChar === "," && prevCharLine === position.line) {
        const beforeCommaIdx = prevCharIdx !== undefined ? findPreviousNonWhitespaceIndex(text, prevCharIdx - 1) : undefined;
        const beforeCommaChar = beforeCommaIdx !== undefined ? text.charAt(beforeCommaIdx) : undefined;
        if (beforeCommaChar === "}") {
            const previousIndent = getLineIndent(text, prevCharLine ?? position.line, document);
            const indentedSnippet = reindentFromBase(previousIndent);
            return `\n${indentedSnippet}`;
        }
    }

    // Case 4: cursor is on a new line after a previous element (e.g., pressed Enter after "},")
    // The previous non-whitespace character is on a different line.
    if (prevCharLine !== undefined && prevCharLine !== position.line) {
        // If current line already has indentation, use that as the base
        if (currentIndent) {
            return reindentFromBase(currentIndent);
        }
        // Otherwise, use the calculated item-level indent
        return reindentFromBase(itemIndent);
    }

    // Case 2 (default): cursor is on an indented line; use that indentation if present.
    if (currentIndent) {
        return reindentFromBase(currentIndent);
    }
    return reindentFromBase(itemIndent);
}

function isEnergyBeamsDocument(document: TextDocument): boolean {
    try {
        const fsPath = fileURLToPath(document.uri);
        return isEnergyBeamsFilePath(fsPath);
    } catch {
        return false;
    }
}

function isEnergyBeamsFilePath(fsPath: string): boolean {
    const normalized = fsPath.replace(/\\/g, "/").toLowerCase();
    return /\/assets\/[^\/]+\/palladium\/energy_beams(\/|$)/.test(normalized);
}

function isEnergyBeamEntryObjectContext(objectNode: JsonNode): boolean {
    if (objectNode.type !== "object") {
        return false;
    }
    const arrayNode = objectNode.parent;
    return !!arrayNode && arrayNode.type === "array" && isEnergyBeamRootArrayContext(arrayNode);
}

function isEnergyBeamRootArrayContext(arrayNode: JsonNode): boolean {
    return arrayNode.type === "array" && !arrayNode.parent;
}

function getLineIndent(text: string, line: number, document: TextDocument): string {
    if (line < 0) {
        return "";
    }

    const lineStart = document.offsetAt({ line, character: 0 });
    const nextLineStart =
        line + 1 < document.lineCount ? document.offsetAt({ line: line + 1, character: 0 }) : text.length;

    const lineText = text.slice(lineStart, nextLineStart);
    const match = lineText.match(/^[ \t]*/);
    return match ? match[0] : "";
}

function determineIndentUnit(text: string): string {
    const lines = text.split(/\r?\n/);
    let minSpaces: number | undefined;

    for (const line of lines) {
        const match = line.match(/^(\s+)\S/);
        if (!match) {
            continue;
        }

        const indent = match[1];
        if (indent.includes("\t")) {
            return "\t";
        }

        const spaceCount = indent.length;
        if (!minSpaces || spaceCount < minSpaces) {
            minSpaces = spaceCount;
        }
    }

    return minSpaces ? " ".repeat(minSpaces) : "    ";
}

function findPreviousNonWhitespaceIndex(text: string, start: number): number | undefined {
    for (let idx = start; idx >= 0; idx--) {
        const char = text.charAt(idx);
        if (char !== " " && char !== "\t" && char !== "\r" && char !== "\n") {
            return idx;
        }
    }

    return undefined;
}

function normalizeSnippetIndent(snippet: string): string {
    const lines = snippet.split("\n");
    if (lines.length === 0) {
        return snippet;
    }

    let minIndent: number | undefined;
    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }
        const leading = line.match(/^[ \t]*/)?.[0] ?? "";
        const count = leading.replace(/[^\t ]/g, "").length;
        if (minIndent === undefined || count < minIndent) {
            minIndent = count;
        }
    }

    if (!minIndent) {
        return snippet;
    }

    return lines
        .map(line => (line.length >= minIndent ? line.slice(minIndent) : line.trim() ? line.trimStart() : line))
        .join("\n");
}

/**
 * Detects the indentation unit used within a snippet by finding the first indented line.
 */
function detectSnippetIndentUnit(snippet: string): string | undefined {
    const lines = snippet.split("\n");
    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }
        const leading = line.match(/^([ \t]+)/);
        if (leading) {
            return leading[1];
        }
    }
    return undefined;
}

/**
 * Reindents a snippet to use the target indentation unit instead of its original indentation.
 * Also applies a base indentation to the entire snippet.
 */
function reindentSnippetWithUnit(
    snippet: string,
    baseIndent: string,
    targetIndentUnit: string
): string {
    const snippetIndentUnit = detectSnippetIndentUnit(snippet);
    const lines = snippet.split("\n");

    return lines.map(line => {
        if (!line.trim()) {
            return line;
        }

        const leading = line.match(/^[ \t]*/)?.[0] ?? "";
        const content = line.slice(leading.length);

        if (!snippetIndentUnit || !leading) {
            // No indentation or can't detect unit, just add base indent
            return `${baseIndent}${content}`;
        }

        // Count how many indent units are in the leading whitespace
        let depth = 0;
        let remaining = leading;
        while (remaining.startsWith(snippetIndentUnit)) {
            depth++;
            remaining = remaining.slice(snippetIndentUnit.length);
        }

        // Build new indentation: base + (depth * target unit)
        const newIndent = baseIndent + targetIndentUnit.repeat(depth);
        return `${newIndent}${content}`;
    }).join("\n");
}

function isAbilityEntryObjectContext(objectNode: JsonNode): boolean {
    if (objectNode.type !== "object") {
        return false;
    }

    const abilityProperty = objectNode.parent;
    if (!abilityProperty || abilityProperty.type !== "property" || abilityProperty.children?.length !== 2) {
        return false;
    }

    const abilitiesContainer = abilityProperty.parent;
    if (!abilitiesContainer || abilitiesContainer.type !== "object") {
        return false;
    }

    const abilitiesProperty = abilitiesContainer.parent;
    if (!abilitiesProperty || abilitiesProperty.type !== "property" || abilitiesProperty.children?.length !== 2) {
        return false;
    }

    const [abilitiesKey] = abilitiesProperty.children;
    return abilitiesKey?.type === "string" && abilitiesKey.value === "abilities";
}

function isConditionEntryObjectContext(objectNode: JsonNode): boolean {
    if (objectNode.type !== "object") {
        return false;
    }

    const arrayNode = objectNode.parent;
    if (!arrayNode || arrayNode.type !== "array") {
        return false;
    }

    const listProperty = arrayNode.parent;
    if (!listProperty || listProperty.type !== "property" || listProperty.children?.length !== 2) {
        return false;
    }

    const [listKey] = listProperty.children;
    if (!listKey || listKey.type !== "string" || (listKey.value !== "enabling" && listKey.value !== "unlocking")) {
        return false;
    }

    const conditionsObject = listProperty.parent;
    if (!conditionsObject || conditionsObject.type !== "object") {
        return false;
    }

    const conditionsProperty = conditionsObject.parent;
    if (!conditionsProperty || conditionsProperty.type !== "property" || conditionsProperty.children?.length !== 2) {
        return false;
    }

    const [conditionsKey] = conditionsProperty.children;
    if (!conditionsKey || conditionsKey.type !== "string" || conditionsKey.value !== "conditions") {
        return false;
    }

    const abilityValueObject = conditionsProperty.parent;
    if (!abilityValueObject) {
        return false;
    }

    return isAbilityEntryObjectContext(abilityValueObject);
}

function isConditionArrayContext(node: JsonNode | undefined): DocKind | undefined {
    let current: JsonNode | undefined = node;
    while (current && current.type !== "array") {
        current = current.parent;
    }

    if (!current || current.type !== "array") {
        return undefined;
    }

    const listProperty = current.parent;
    if (!listProperty || listProperty.type !== "property" || listProperty.children?.length !== 2) {
        return undefined;
    }

    const [listKey] = listProperty.children;
    if (!listKey || listKey.type !== "string" || (listKey.value !== "enabling" && listKey.value !== "unlocking")) {
        return undefined;
    }

    const conditionsObject = listProperty.parent;
    if (!conditionsObject || conditionsObject.type !== "object") {
        return undefined;
    }

    const conditionsProperty = conditionsObject.parent;
    if (!conditionsProperty || conditionsProperty.type !== "property" || conditionsProperty.children?.length !== 2) {
        return undefined;
    }

    const [conditionsKey] = conditionsProperty.children;
    if (!conditionsKey || conditionsKey.type !== "string" || conditionsKey.value !== "conditions") {
        return undefined;
    }

    const abilityValueObject = conditionsProperty.parent;
    if (!abilityValueObject || !isAbilityEntryObjectContext(abilityValueObject)) {
        return undefined;
    }

    return "condition";
}

function resolveKindFromPath(path: Array<string | number>): DocKind | undefined {
    if (!path || !path.length) {
        return undefined;
    }

    let sawAbilities = false;

    for (let i = 0; i < path.length; i++) {
        const segment = path[i];
        if (segment === "abilities") {
            sawAbilities = true;
        }

        if (
            sawAbilities &&
            segment === "conditions" &&
            (path[i + 1] === "enabling" || path[i + 1] === "unlocking")
        ) {
            return "condition";
        }
    }

    return sawAbilities ? "ability" : undefined;
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
    // Check if this is an energy beams file first
    if (isEnergyBeamsDocument(document)) {
        return "energy_renderer";
    }
    
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

function resolveEnergyRendererFieldCompletionContext(
    document: TextDocument,
    position: Position
): AbilityFieldCompletionContext | undefined {
    if (!isEnergyBeamsDocument(document)) {
        return undefined;
    }

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
    if (!objectNode || !isEnergyBeamEntryObjectContext(objectNode)) {
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

    const renderer = energyRendererMap.get(typeId);
    if (!renderer || renderer.fields.length === 0) {
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
        ability: renderer,
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

async function reloadEnergyRenderers(reason?: string): Promise<void> {
    try {
        const { entries, watchTarget } = await resolveEnergyRenderers(preferredSources);
        energyRenderers = entries.length ? entries : createFallbackEnergyRenderers();
        energyRendererMap = buildAbilityMap(energyRenderers);

        configureWatcher("energy_renderer", watchTarget ?? null);
        connection.console.info(
            `[Energy Renderers] Loaded ${energyRenderers.length} entries${reason ? ` (${reason})` : ""}`
        );
    } catch (error) {
        connection.console.error(`[Energy Renderers] Failed to load: ${formatError(error)}`);
        energyRenderers = createFallbackEnergyRenderers();
        energyRendererMap = buildAbilityMap(energyRenderers);
        configureWatcher("energy_renderer", getDocsFolderWatchTarget());
    } finally {
        validateAllDocuments();
    }
}

async function resolveAbilities(config: InitOptions): Promise<ResolveResult> {
    const abilityFile = getAbilityFilePath(config);
    if (abilityFile && await fileExists(abilityFile)) {
        const entries = await loadFromFile(abilityFile, path.basename(abilityFile), "ability");
        return { entries, watchTarget: { kind: "file" as const, path: abilityFile } };
    }

    const bundledPath = path.resolve(__dirname, "..", "..", "examples", "abilities.html");
    const fallbackList = await loadFromFile(bundledPath, "examples/abilities.html", "ability");
    const watchTarget = config.docsRoot ? { kind: "folder" as const, path: config.docsRoot } : null;
    return { entries: fallbackList.length ? fallbackList : createFallbackAbilities(), watchTarget };
}

async function resolveConditions(config: InitOptions): Promise<ResolveResult> {
    const conditionFile = getConditionFilePath(config);
    if (conditionFile && await fileExists(conditionFile)) {
        const entries = await loadFromFile(conditionFile, path.basename(conditionFile), "condition");
        return { entries, watchTarget: { kind: "file" as const, path: conditionFile } };
    }

    const watchTarget = config.docsRoot ? { kind: "folder" as const, path: config.docsRoot } : null;
    return { entries: [], watchTarget };
}

async function resolveEnergyRenderers(config: InitOptions): Promise<ResolveResult> {
    const direct = config.energyRendersFile;
    if (direct && await fileExists(direct)) {
        const entries = await loadFromFile(direct, path.basename(direct), "energy_renderer");
        return { entries, watchTarget: { kind: "file" as const, path: direct } };
    }

    if (config.docsRoot) {
        const candidates = [
            path.join(config.docsRoot, "energy_render_beams.html"),
            path.join(config.docsRoot, "energy_beam_renderers.html"),
        ];

        for (const candidate of candidates) {
            if (await fileExists(candidate)) {
                const entries = await loadFromFile(candidate, path.basename(candidate), "energy_renderer");
                return { entries, watchTarget: { kind: "file" as const, path: candidate } };
            }
        }
    }

    const watchTarget = config.docsRoot ? { kind: "folder" as const, path: config.docsRoot } : null;
    return { entries: createFallbackEnergyRenderers(), watchTarget };
}

async function loadFromFile(filePath: string, sourceLabel: string, docKind: DocKind): Promise<AbilityRecord[]> {
    try {
        const stats = await fsp.stat(filePath);
        if (!stats.isFile()) {
            return [];
        }

        const html = await fsp.readFile(filePath, "utf8");
        return parseAbilityHtml(html, sourceLabel, docKind);
    } catch (error) {
        connection.console.warn(`[Abilities] Unable to read file ${filePath}: ${formatError(error)}`);
        return [];
    }
}

function parseAbilityHtml(html: string, sourceLabel: string, docKind: DocKind): AbilityRecord[] {
    const $ = cheerio.load(html);
    const result: AbilityRecord[] = [];

    $("div[id]").each((_idx, element) => {
        const block = $(element);
        const id = block.attr("id")?.trim();
        if (!id || !id.includes(":")) {
            return;
        }

        const exampleRaw = extractExampleSnippet($, block);
        if (!exampleRaw) {
            return;
        }

        const name = block.find("h2").first().text().trim() || id;
        const description = block.find("p").first().text().trim();
        const fields = parseAbilityFields($, block);
        const inferredFields = fields.length ? fields : inferFieldsFromExample(exampleRaw);
        const fieldIndex = new Map(inferredFields.map(field => [field.name, field]));
        const { snippet, pretty } = buildSnippetFromExample(exampleRaw, docKind);

        result.push({
            id,
            name,
            snippet,
            example: pretty,
            description,
            source: sourceLabel,
            fields: inferredFields,
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
            .map(header => normalizeHeaderName($(header).text()));

        if (!headers.length) {
            continue;
        }

        const nameIdx = headers.findIndex(h => h === "setting" || h === "property" || h === "field");
        if (nameIdx === -1) {
            continue;
        }

        const typeIdx = headers.findIndex(h => h === "type");
        const descriptionIdx = headers.findIndex(h => h === "description" || h === "details");
        const requiredIdx = headers.findIndex(h => h === "required");
        const fallbackIdx = headers.findIndex(h => h.startsWith("default") || h.startsWith("fallback"));

        const rows = table.find("tbody tr");
        const fields: AbilityField[] = [];

        rows.each((_rowIdx, row) => {
            const cells = $(row).find("td").toArray();
            const name = pickCellText(cells, nameIdx, $);
            if (!name) {
                return;
            }

            const type = pickCellText(cells, typeIdx, $);
            const description = pickCellText(cells, descriptionIdx, $);
            const required = parseRequiredFlag(pickCellText(cells, requiredIdx, $) ?? "");
            const fallback = pickCellText(cells, fallbackIdx, $);

            fields.push({
                name,
                type: type || undefined,
                description: description || undefined,
                required,
                fallback: fallback && fallback !== "/" ? fallback : undefined,
            });
        });

        if (fields.length) {
            return fields;
        }
    }

    return [];
}

function normalizeHeaderName(raw: string): string {
    return raw.replace(/\s+/g, " ").trim().toLowerCase();
}

function pickCellText(cells: unknown[], idx: number, $: cheerio.CheerioAPI): string | undefined {
    if (idx < 0 || idx >= cells.length) {
        return undefined;
    }
    return extractCellText($(cells[idx] as any)) || undefined;
}

function extractExampleSnippet(
    $: cheerio.CheerioAPI,
    block: cheerio.Cheerio<any>
): string | undefined {
    const candidates: string[] = [];
    const seen = new Set<string>();

    const pushCandidate = (raw: string | undefined) => {
        const text = raw?.trim();
        if (!text || seen.has(text)) {
            return;
        }
        seen.add(text);
        candidates.push(text);
    };

    pushCandidate(block.find("pre.json-snippet").first().text());

    block.find("pre code").each((_idx, el) => pushCandidate($(el).text()));
    block.find("pre").each((_idx, el) => pushCandidate($(el).text()));

    for (const candidate of candidates) {
        if (isJsonLike(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

function isJsonLike(text: string): boolean {
    return tryParseJsonAny(text) !== undefined;
}

function tryParseJsonAny(text: string): unknown | undefined {
    if (!text.trim()) {
        return undefined;
    }
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function inferFieldsFromExample(exampleRaw: string): AbilityField[] {
    const parsed = tryParseJsonAny(exampleRaw);
    if (!parsed) {
        return [];
    }

    let target = parsed;
    if (Array.isArray(parsed) && parsed.length) {
        const first = parsed[0];
        if (isPlainObject(first)) {
            target = first;
        }
    }

    if (!isPlainObject(target)) {
        return [];
    }

    return Object.entries(target as Record<string, unknown>).map(([name, value]) => ({
        name,
        type: describeValueType(value),
        description: undefined,
        required: true,
        fallback: formatFallbackValue(value),
    }));
}

function describeValueType(value: unknown): string | undefined {
    if (value === null) {
        return "null";
    }
    if (Array.isArray(value)) {
        return "array";
    }
    const kind = typeof value;
    if (kind === "object") {
        return "object";
    }
    return kind;
}

function formatFallbackValue(value: unknown): string | undefined {
    if (value === null) {
        return "null";
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    try {
        return JSON.stringify(value);
    } catch {
        return undefined;
    }
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
function buildSnippetFromExample(example: string, kind: DocKind): { snippet: string; pretty: string } {
    try {
        const parsed = JSON.parse(example);
        const snippetRoot = cloneJsonValue(parsed);

        if (kind === "ability") {
            ensureAbilityConditions(snippetRoot);
        } else if (kind === "energy_renderer") {
            ensureEnergyRendererBodyPart(snippetRoot);
        }

        let tabIndex = 1;
        const indentUnit = "    ";

        const renderValue = (value: unknown, depth: number): string => {
            const indent = indentUnit.repeat(depth);
            const nextIndent = indentUnit.repeat(depth + 1);

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

        const snippet = renderValue(snippetRoot, 0);
        const pretty = JSON.stringify(parsed, null, 4);
        return { snippet, pretty };
    } catch {
        return { snippet: example, pretty: example };
    }
}

function ensureAbilityConditions(root: unknown): void {
    if (!isPlainObject(root)) {
        return;
    }

    const record = root as Record<string, unknown>;
    const existing = record["conditions"];

    if (!isPlainObject(existing)) {
        record["conditions"] = createEmptyConditionsBlock();
        return;
    }

    const conditions = existing as Record<string, unknown>;

    if (!Array.isArray(conditions["enabling"])) {
        conditions["enabling"] = [];
    }

    if (!Array.isArray(conditions["unlocking"])) {
        conditions["unlocking"] = [];
    }
}

function ensureEnergyRendererBodyPart(root: unknown): void {
    const assignBodyPart = (target: Record<string, unknown>) => {
        if (Object.prototype.hasOwnProperty.call(target, "body_part")) {
            return;
        }

        const entries = Object.entries(target);
        const reordered: Record<string, unknown> = {};
        let inserted = false;

        for (const [key, value] of entries) {
            reordered[key] = value;
            if (!inserted && key === "type") {
                reordered["body_part"] = "head";
                inserted = true;
            }
        }

        if (!inserted) {
            reordered["body_part"] = "head";
        }

        // mutate original object in place to preserve references
        Object.keys(target).forEach(key => delete target[key]);
        Object.entries(reordered).forEach(([key, value]) => {
            target[key] = value;
        });
    };

    if (Array.isArray(root)) {
        for (const item of root) {
            if (isPlainObject(item)) {
                assignBodyPart(item as Record<string, unknown>);
            }
        }
        return;
    }

    if (isPlainObject(root)) {
        assignBodyPart(root as Record<string, unknown>);
    }
}

function createEmptyConditionsBlock(): { enabling: unknown[]; unlocking: unknown[] } {
    return {
        enabling: [],
        unlocking: []
    };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneJsonValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
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

function createFallbackEnergyRenderers(): AbilityRecord[] {
    const commonFields: AbilityField[] = [
        { name: "type", type: "string", description: "Renderer type id" },
        { name: "body_part", type: "string" },
        { name: "glow_color", type: "string" },
        { name: "core_color", type: "string" },
        { name: "glow_opacity", type: "number" },
        { name: "core_opacity", type: "number" },
        { name: "size", type: "vec2/array" },
        { name: "bloom", type: "number" },
        { name: "rotation", type: "number" },
        { name: "rotation_speed", type: "number" },
        { name: "offset", type: "vec3/array" },
        { name: "normal_transparency", type: "boolean" },
    ];

    const lightningExtra: AbilityField[] = [
        { name: "segments", type: "number" },
        { name: "frequency", type: "number" },
        { name: "spread", type: "number" },
    ];

    const laser: AbilityRecord = {
        id: "palladium:laser",
        name: "Laser",
        description: "Fallback energy beam renderer snippet (real entries load from documentation).",
        source: "fallback",
        example: `{
    "type": "palladium:laser",
    "body_part": "head",
    "glow_color": "#114880",
    "core_color": "#257c12",
    "glow_opacity": 1,
    "core_opacity": 0.5,
    "size": [4, 4],
    "bloom": 0,
    "rotation": 10,
    "rotation_speed": 20,
    "offset": [-1, -11, 0],
    "normal_transparency": true
}`,
        snippet: `{
    "type": "\${1:palladium:laser}",
    "body_part": "\${2:head}",
    "glow_color": "\${3:#114880}",
    "core_color": "\${4:#257c12}",
    "glow_opacity": \${5:1},
    "core_opacity": \${6:0.5},
    "size": [\${7:4}, \${8:4}],
    "bloom": \${9:0},
    "rotation": \${10:10},
    "rotation_speed": \${11:20},
    "offset": [\${12:-1}, \${13:-11}, \${14:0}],
    "normal_transparency": \${15:true}
}`,
        fields: commonFields,
        fieldIndex: new Map(commonFields.map(field => [field.name, field])),
    };

    const lightningFields = [...commonFields, ...lightningExtra];
    const lightning: AbilityRecord = {
        id: "palladium:lightning",
        name: "Lightning",
        description: "Fallback energy beam renderer snippet (real entries load from documentation).",
        source: "fallback",
        example: `{
    "type": "palladium:lightning",
    "body_part": "head",
    "glow_color": "#114880",
    "core_color": "#257c12",
    "glow_opacity": 0.75,
    "core_opacity": 0.25,
    "size": [3, 2],
    "segments": 20,
    "frequency": 12,
    "spread": 1,
    "bloom": 1,
    "rotation": 10,
    "rotation_speed": 20,
    "offset": [-1, -11, 0],
    "normal_transparency": true
}`,
        snippet: `{
    "type": "\${1:palladium:lightning}",
    "body_part": "\${2:head}",
    "glow_color": "\${3:#114880}",
    "core_color": "\${4:#257c12}",
    "glow_opacity": \${5:0.75},
    "core_opacity": \${6:0.25},
    "size": [\${7:3}, \${8:2}],
    "segments": \${9:20},
    "frequency": \${10:12},
    "spread": \${11:1},
    "bloom": \${12:1},
    "rotation": \${13:10},
    "rotation_speed": \${14:20},
    "offset": [\${15:-1}, \${16:-11}, \${17:0}],
    "normal_transparency": \${18:true}
}`,
        fields: lightningFields,
        fieldIndex: new Map(lightningFields.map(field => [field.name, field])),
    };

    return [laser, lightning];
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
            id: "palladium:dummy",
            name: "Fallback Power",
            description: "Sample data – real abilities load from mods/documentation/palladium.",
            example: `{
    "type": "palladium:blackwhip_detach",
    "power": 1,
    "cooldown": 10,
    "conditions": {
        "enabling": [],
        "unlocking": []
    }
}`,
            snippet: `{
    "type": "palladium:dummy",
    "power": \${1:1},
    "cooldown": \${2:10},
    "conditions": {
        "enabling": [],
        "unlocking": []
    }
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
        const reloadFn =
            kind === "condition"
                ? reloadConditions
                : kind === "energy_renderer"
                    ? reloadEnergyRenderers
                    : reloadAbilities;
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

    if (
        matchesTarget(normalized, watchStates.energy_renderer.target) ||
        (preferredSources.docsRoot &&
            (matchesExpectedPath(normalized, path.join(preferredSources.docsRoot, "energy_render_beams.html")) ||
                matchesExpectedPath(normalized, path.join(preferredSources.docsRoot, "energy_beam_renderers.html")))) ||
        matchesExpectedPath(normalized, preferredSources.energyRendersFile)
    ) {
        matches.push("energy_renderer");
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
    switch (kind) {
        case "condition":
            return "Conditions";
        case "energy_renderer":
            return "Energy Renderers";
        default:
            return "Abilities";
    }
}
