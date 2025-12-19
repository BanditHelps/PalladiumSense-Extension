import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as cheerio from 'cheerio';
import JSZip = require('jszip');

import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient;

export async function activate(context: vscode.ExtensionContext) {
	console.log('Palladium Sense is active!');

	// Register the "Power" command
    context.subscriptions.push(registerNewPowerCommand());
    context.subscriptions.push(registerDocumentationViewerCommand());
    context.subscriptions.push(registerInitializeAddonCommand());
    context.subscriptions.push(registerPackageAddonCommand());

    const serverModule = context.asAbsolutePath("dist/server.js");

    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: { execArgv: ["--nolazy", "--inspect=0"] }
        }
    };

    // Settings sent to the server (like where the documentation lives)
    const primaryWorkspace = vscode.workspace.workspaceFolders?.[0];
    const docsResolution = await resolveDocumentationRoot(primaryWorkspace);
    const docsRoot = docsResolution.uri?.fsPath;

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: "file", language: "json" }],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher("**/*.html")
        },
        initializationOptions: {
            docsRoot,
            abilitiesFile: docsRoot ? path.join(docsRoot, "abilities.html") : undefined,
            conditionsFile: docsRoot ? path.join(docsRoot, "conditions.html") : undefined,
            // Server resolves both energy_render_beams.html and energy_beam_renderers.html automatically.
            energyRendersFile: undefined,
        }
    };

    client = new LanguageClient(
        "palladiumLanguageServer",
        "Palladium Langauge Server",
        serverOptions,
        clientOptions
    );

    client.start();
}

// This method is called when your extension is deactivated
export function deactivate(): Thenable<void> | undefined {
    return client?.stop();
}

function registerNewPowerCommand(): vscode.Disposable {
    return vscode.commands.registerCommand("palladiumsense.newPower", async () => {
        
        // Open up a dialog and get a bunch of information from the user, and validate it
        const workspaceFolder = await pickWorkspaceFolder();

        if (!workspaceFolder) {
            vscode.window.showErrorMessage("Open your Minecraft instance as a workspace folder before creating a power file!");
            return;
        }

        const powerName = await vscode.window.showInputBox({
            title: "Power Name",
            prompt: "Enter the display name for the new power",
            placeHolder: "Example Power",
            validateInput: (value) =>
                value && value.trim().length > 0 ? undefined : "Name cannot be empty"
        });

        if (!powerName) { return; }

        const modId = await vscode.window.showInputBox({
            title: "Mod ID",
            prompt: "Enter your addon's ID (used under data/<modid>)",
            placeHolder: "examplemod",
            validateInput: (value) =>
                value && value.trim().length > 0 ? undefined : "Mod ID cannot be empty"
        });

        if (!modId) { return; }

        const guiDisplayType = await vscode.window.showQuickPick(["tree", "list"], {
            title: "GUI Display Type",
            placeHolder: "Select the GUI display type",
            canPickMany: false
        });

        if (!guiDisplayType) { return; }

        // Now that all the information is gathered, attempt to build the new power.json file

        const fileName = `${slugify(powerName)}.json`;
        const normalizedModId = modId.trim().toLowerCase();
        const powerDirectory = await findPowerDirectory(workspaceFolder.uri, normalizedModId);

        if (!powerDirectory) {
            vscode.window.showErrorMessage(
                `Could not find data/${normalizedModId}/palladium/powers under addonpacks. ` +
                "Create the folder structure and try again."
            );

            return;
        }

        await vscode.workspace.fs.createDirectory(powerDirectory);

        const targetUri = vscode.Uri.joinPath(powerDirectory, fileName);
        const template = buildPowerTemplate(powerName.trim(), guiDisplayType);

        try {
            if (await fileExists(targetUri)) {
                const overwrite = await vscode.window.showWarningMessage(
                    `${fileName} already exists. Overwrite it?`,
                    { modal: true },
                    "Overwrite"
                );

                if (overwrite !== "Overwrite") {
                    return;
                }
            }

            await vscode.workspace.fs.writeFile(targetUri, Buffer.from(template, "utf8"));
            vscode.window.showInformationMessage(`Created ${fileName}.`);
            await vscode.window.showTextDocument(targetUri, { preview: false });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to create power file: ${message}`);
        }
    });
}

function registerInitializeAddonCommand(): vscode.Disposable {
    return vscode.commands.registerCommand("palladiumsense.initializeAddon", async () => {
        const workspaceFolder = await pickWorkspaceFolder();
        if (!workspaceFolder) {
            vscode.window.showErrorMessage("Open your Minecraft instance as a workspace folder before initializing an addon.");
            return;
        }

        const displayName = await vscode.window.showInputBox({
            title: "Addon Display Name",
            prompt: "Enter the display name for the new addon",
            placeHolder: "Example Addon",
            validateInput: value => value && value.trim().length > 0 ? undefined : "Display name cannot be empty"
        });

        if (!displayName) {
            return;
        }

        const modId = await vscode.window.showInputBox({
            title: "Addon Mod ID",
            prompt: "Enter the mod ID (lowercase, letters, numbers, underscores)",
            placeHolder: "examplemod",
            validateInput: value => /^[a-z0-9_]+$/.test(value.trim())
                ? undefined
                : "Mod ID must be lowercase letters, numbers, or underscores"
        });

        if (!modId) {
            return;
        }

        const description = await vscode.window.showInputBox({
            title: "Description",
            prompt: "Describe what your addon will do",
            placeHolder: "An Example Addon for Palladium!",
            validateInput: value => value && value.trim().length > 0 ? undefined : "Description cannot be empty"
        });

        if (!description) {
            return;
        }

        const author = await vscode.window.showInputBox({
            title: "Author",
            prompt: "Enter the Author of the addon",
            placeHolder: "Notch",
            validateInput: value => value && value.trim().length > 0 ? undefined : "Author cannot be empty"
        });

        if (!author) {
            return;
        }

        const workspaceUri = workspaceFolder.uri;
        const addonpacksUri = vscode.Uri.joinPath(workspaceUri, "addonpacks");

        try {
            await vscode.workspace.fs.createDirectory(addonpacksUri);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to access addonpacks folder: ${message}`);
            return;
        }

        const folderName = buildAddonFolderName(displayName, modId);

        const addonRoot = vscode.Uri.joinPath(addonpacksUri, folderName);

        if (await fileExists(addonRoot)) {
            vscode.window.showErrorMessage(`An addon named "${folderName}" already exists in addonpacks.`);
            return;
        }

        const createPath = (...segments: string[]): vscode.Uri => {
            return segments.reduce((uri, segment) => vscode.Uri.joinPath(uri, segment), addonRoot);
        };

        const safeDisplayNameToml = displayName.replace(/"/g, '\\"');

        const requiredDirectories: string[][] = [
            ["addon", modId, "kubejs_scripts"],
            ["data", modId, "kubejs_scripts"],
            ["data", modId, "palladium", "powers"],
            ["assets", modId, "kubejs_scripts"],
            ["assets", modId, "lang"],
            ["assets", modId, "palladium", "dynamic_textures"],
            ["assets", modId, "palladium", "model_layers"],
            ["assets", modId, "palladium", "render_layers"],
            ["assets", modId, "palladium", "trails"],
            ["assets", modId, "particles"],
            ["assets", modId, "textures", "models"],
            ["assets", modId, "textures", "icons"],
            ["META-INF"]
        ];

        const filePayloads: { segments: string[]; contents: string }[] = [
            {
                segments: ["data", modId, "tracked_scores.json"],
                contents: JSON.stringify({
                    objectives: []
                }, null, 4) + "\n"
            },
            {
                segments: ["assets", modId, "lang", "en_us.json"],
                contents: JSON.stringify({
                    [`pack.${modId}.name`]: displayName
                }, null, 4) + "\n"
            },
            {
                segments: ["META-INF", "mods.toml"],
                contents:
`modLoader="lowcodefml"
showAsResourcePack = false
loaderVersion="[47,)"
license="All Rights Reserved"

[[mods]]
modId="${modId}"
version="1.0.0"
logoFile = "logo.png"
logoBlur = false
displayName="${safeDisplayNameToml}"
description='''
${description}
'''

[[dependencies.${modId}]]
modId = "palladium"
mandatory = true
versionRange = "[4.4.1,)"
ordering = "NONE"
side = "BOTH"
`
            },
            {
                segments: ["fabric.mod.json"],
                contents: JSON.stringify({
                    schemaVersion: 1,
                    authors: [author],
                    environment: "*",
                    id: modId,
                    version: "1.0.0",
                    name: displayName,
                    description: description,
                    icon: "logo.png",
                    license: "All rights reserved"
                }, null, 4) + "\n"
            },
            {
                segments: ["pack.mcmeta"],
                contents: JSON.stringify({
                    pack: {
                        id: modId,
                        pack_format: 15,
                        description: description,
                        version: "1.0.0"
                    },
                    dependencies: {
                        common: {},
                        fabric: {},
                        forge: {},
                    }
                }, null, 4) + "\n"
            },
            {
                segments: [".palladiumignore"],
                contents: ".github\n.palladiumignore"
            }
        ];

        try {
            await vscode.workspace.fs.createDirectory(addonRoot);
            for (const segments of requiredDirectories) {
                await vscode.workspace.fs.createDirectory(createPath(...segments));
            }
            for (const { segments, contents } of filePayloads) {
                await vscode.workspace.fs.writeFile(createPath(...segments), Buffer.from(contents, "utf8"));
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to scaffold addon: ${message}`);
            return;
        }

        try {
            await initializeGitRepository(addonRoot);
            vscode.window.showInformationMessage(`Initialized addon "${displayName}" in ${vscode.workspace.asRelativePath(addonRoot)} and set up Git.`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showWarningMessage(`Addon created, but Git initialization failed: ${message}`);
            vscode.window.showInformationMessage(`Initialized addon "${displayName}" in ${vscode.workspace.asRelativePath(addonRoot)}.`);
        }
    });
}

function registerPackageAddonCommand(): vscode.Disposable {
    return vscode.commands.registerCommand("palladiumsense.packageAddon", async () => {
        const workspaceFolder = await pickWorkspaceFolder();
        if (!workspaceFolder) {
            vscode.window.showErrorMessage("Open your Minecraft instance as a workspace folder before packaging an addon.");
            return;
        }

        const modIdInput = await vscode.window.showInputBox({
            title: "Addon Mod ID",
            prompt: "Enter the mod ID to package",
            placeHolder: "examplemod",
            validateInput: value => /^[a-z0-9_]+$/.test(value.trim())
                ? undefined
                : "Mod ID must be lowercase letters, numbers, or underscores"
        });

        if (!modIdInput) {
            return;
        }

        const modId = modIdInput.trim().toLowerCase();
        const selection = await pickAddonPackByModId(workspaceFolder.uri, modId);
        if (!selection) {
            vscode.window.showErrorMessage(`Could not find an addon pack with data/${modId}.`);
            return;
        }

        const packagedRoot = vscode.Uri.joinPath(workspaceFolder.uri, "packaged_addons");
        try {
            await vscode.workspace.fs.createDirectory(packagedRoot);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to prepare packaged_addons folder: ${message}`);
            return;
        }

        const timestamp = formatTimestampForFile(new Date());
        const jarUri = vscode.Uri.joinPath(packagedRoot, `${modId}-${timestamp}.jar`);

        try {
            const ignoreRules = await loadPackagingIgnoreRules(selection.root);
            const archive = await createAddonArchive(selection.root, ignoreRules);
            await vscode.workspace.fs.writeFile(jarUri, archive);
            vscode.window.showInformationMessage(`Packaged addon "${selection.label}" to ${vscode.workspace.asRelativePath(jarUri)}.`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to package addon: ${message}`);
        }
    });
}

function registerDocumentationViewerCommand(): vscode.Disposable {
    return vscode.commands.registerCommand("palladiumsense.viewDocumentation", async () => {
        const workspaceFolder = await pickWorkspaceFolder();
        const docsResolution = await resolveDocumentationRoot(workspaceFolder);
        const docsRoot = docsResolution.uri;

        if (!docsRoot) {
            const attempts: string[] = [];
            if (docsResolution.workspacePath) {
                attempts.push(docsResolution.workspacePath.fsPath);
            }
            if (docsResolution.configuredPath) {
                attempts.push(docsResolution.configuredPath);
            }

            const suffix = attempts.length
                ? ` Checked: ${attempts.join(" | ")}`
                : " Configure a documentation path in settings or open a workspace that contains mods/documentation/palladium.";

            vscode.window.showErrorMessage(`Could not find a Palladium documentation folder.${suffix}`);
            return;
        }

        const sections = await loadDocumentationSections(docsRoot);
        if (!sections.length) {
            vscode.window.showWarningMessage(`No documentation files were found in ${docsRoot.fsPath}.`);
            return;
        }

        const entryIndex = new Map<string, { section: string; example?: string }>();
        sections.forEach(section => {
            section.entries.forEach(entry => {
                entryIndex.set(entry.id, { section: section.title, example: entry.example });
            });
        });

        const panel = vscode.window.createWebviewPanel(
            "palladiumDocumentation",
            "Palladium Documentation",
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        panel.webview.html = buildDocumentationWebviewContent(panel.webview, sections);

        panel.webview.onDidReceiveMessage(async message => {
            if (!message || typeof message !== "object") {
                return;
            }

            if (message.type !== "insertEntry" && message.type !== "copyEntry") {
                return;
            }

            const entryId: string | undefined = message.entryId;
            const payload = entryId ? entryIndex.get(entryId) : undefined;
            const sectionTitle: string | undefined = message.section ?? payload?.section;
            const normalized = normalizeEntryJson(
                typeof message.example === "string" ? message.example : payload?.example,
                sectionTitle
            );

            if (!normalized) {
                vscode.window.showWarningMessage("Unable to use this documentation entry – no example data was found.");
                return;
            }

            if (message.type === "copyEntry") {
                await vscode.env.clipboard.writeText(normalized);
                vscode.window.showInformationMessage("Copied documentation snippet to clipboard.");
                return;
            }

            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const snippet = new vscode.SnippetString(normalized);
                await editor.insertSnippet(snippet, editor.selections);
            } else {
                await vscode.env.clipboard.writeText(normalized);
                vscode.window.showWarningMessage("No active editor detected. Snippet copied to clipboard instead.");
            }
        });
    });
}

type DocSection = {
    title: string;
    entries: DocEntry[];
};

type DocEntry = {
    id: string;
    title: string;
    description?: string;
    html: string;
    searchText: string;
    example?: string;
};

type AddonPackPickItem = vscode.QuickPickItem & { root: vscode.Uri };

type GitAPI = {
    init(root: vscode.Uri): Promise<unknown>;
};

type GitExtensionExports = {
    getAPI(version: number): GitAPI;
};

type DocumentationResolution = {
    uri?: vscode.Uri;
    source: "workspace" | "setting" | "none";
    workspacePath?: vscode.Uri;
    configuredPath?: string;
};

async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return undefined;
    }

    if (folders.length === 1) {
        return folders[0];
    }

    return vscode.window.showWorkspaceFolderPick({
        placeHolder: "Select the workspace folder for the new power file"
    });
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

// Converts the display name to a properly formated file name
function slugify(name: string): string {
    const trimmed = name.trim().toLowerCase();
    const sanitized = trimmed.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return sanitized.length > 0 ? sanitized : "power";
}

async function resolveDocumentationRoot(workspaceFolder?: vscode.WorkspaceFolder | null): Promise<DocumentationResolution> {
    const workspacePath = workspaceFolder
        ? vscode.Uri.joinPath(workspaceFolder.uri, "mods", "documentation", "palladium")
        : undefined;

    if (workspacePath && await directoryExists(workspacePath)) {
        return { uri: workspacePath, source: "workspace", workspacePath };
    }

    const configuredPath = getConfiguredDocumentationPath(workspaceFolder);
    if (configuredPath) {
        const candidate = vscode.Uri.file(configuredPath);
        if (await directoryExists(candidate)) {
            return { uri: candidate, source: "setting", workspacePath, configuredPath };
        }
        return { uri: undefined, source: "none", workspacePath, configuredPath };
    }

    return { uri: undefined, source: "none", workspacePath };
}

function getConfiguredDocumentationPath(workspaceFolder?: vscode.WorkspaceFolder | null): string | undefined {
    const rawPath = vscode.workspace.getConfiguration("palladiumsense").get<string>("documentationPath");
    if (!rawPath) {
        return undefined;
    }

    const trimmed = rawPath.trim();
    if (!trimmed) {
        return undefined;
    }

    const expanded = trimmed.startsWith("~")
        ? path.join(os.homedir(), trimmed.slice(1))
        : trimmed;

    if (path.isAbsolute(expanded)) {
        return path.normalize(expanded);
    }

    const base = workspaceFolder?.uri.fsPath;
    return path.normalize(base ? path.join(base, expanded) : path.resolve(expanded));
}

function buildAddonFolderName(displayName: string, fallback: string): string {
    const parts = displayName
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1));

    if (parts.length) {
        return parts.join("");
    }

    const sanitizedFallback = fallback.replace(/[^a-zA-Z0-9]+/g, "");
    return sanitizedFallback || "AddonPack";
}

function formatTimestampForFile(date: Date): string {
    const pad = (value: number) => value.toString().padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function loadPackagingIgnoreRules(root: vscode.Uri): Promise<IgnoreRule[]> {
    const defaults: IgnoreRule[] = [
        ".git",
        ".git/**",
        ".DS_Store",
        "Thumbs.db",
        "packaged_addons",
        "packaged_addons/**"
    ];

    const ignoreFile = vscode.Uri.joinPath(root, ".palladiumignore");

    try {
        const raw = await vscode.workspace.fs.readFile(ignoreFile);
        const text = raw.toString();
        const fromFile = text
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line.length > 0 && !line.startsWith("#"));
        return defaults.concat(fromFile);
    } catch {
        return defaults;
    }
}

function normalizeIgnoreRules(rules: IgnoreRule[]): IgnoreRule[] {
    return rules.map(rule => rule.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, ""));
}

function shouldExclude(relPath: string, rules: IgnoreRule[]): boolean {
    const normalized = relPath.replace(/\\/g, "/");
    for (const rule of rules) {
        if (!rule) {
            continue;
        }
        if (normalized === rule) {
            return true;
        }
        if (rule.endsWith("/**")) {
            const prefix = rule.slice(0, -3);
            if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
                return true;
            }
        } else if (rule.endsWith("/*")) {
            const prefix = rule.slice(0, -2);
            if (normalized.startsWith(`${prefix}/`)) {
                return true;
            }
        }
    }
    return false;
}

type IgnoreRule = string;

async function createAddonArchive(root: vscode.Uri, ignoreRules: IgnoreRule[]): Promise<Uint8Array> {
    const zip = new JSZip();
    const normalizedRules = normalizeIgnoreRules(ignoreRules);
    await addFolderToZip(zip, root, "", normalizedRules);
    return zip.generateAsync({
        type: "uint8array",
        compression: "DEFLATE",
        compressionOptions: { level: 9 }
    });
}

async function addFolderToZip(zip: JSZip, folderUri: vscode.Uri, relativePath: string, ignoreRules: IgnoreRule[]): Promise<void> {
    const entries = await vscode.workspace.fs.readDirectory(folderUri);
    for (const [name, type] of entries) {
        const childUri = vscode.Uri.joinPath(folderUri, name);
        const relPath = relativePath ? `${relativePath}/${name}` : name;
        const normalizedPath = relPath.replace(/\\/g, "/");

        if (shouldExclude(normalizedPath, ignoreRules)) {
            continue;
        }

        if ((type & vscode.FileType.Directory) !== 0) {
            zip.folder(normalizedPath);
            await addFolderToZip(zip, childUri, normalizedPath, ignoreRules);
            continue;
        }

        if ((type & vscode.FileType.File) !== 0) {
            const contents = await vscode.workspace.fs.readFile(childUri);
            zip.file(normalizedPath, contents);
            continue;
        }

        if ((type & vscode.FileType.SymbolicLink) !== 0) {
            try {
                const stat = await vscode.workspace.fs.stat(childUri);
                if ((stat.type & vscode.FileType.Directory) !== 0) {
                    zip.folder(normalizedPath);
                    await addFolderToZip(zip, childUri, normalizedPath, ignoreRules);
                } else if ((stat.type & vscode.FileType.File) !== 0) {
                    const contents = await vscode.workspace.fs.readFile(childUri);
                    zip.file(normalizedPath, contents);
                }
            } catch {
                // Ignore broken symlinks
            }
        }
    }
}

type PowerDirPickItem = vscode.QuickPickItem & { target: vscode.Uri };

async function findPowerDirectory(workspaceUri: vscode.Uri, modId: string): Promise<vscode.Uri | undefined> {
    const addonpacksUri = vscode.Uri.joinPath(workspaceUri, "addonpacks");
    let entries: [string, vscode.FileType][];

    try {
        entries = await vscode.workspace.fs.readDirectory(addonpacksUri);
    } catch {
        return undefined;
    }

    const matches: PowerDirPickItem[] = [];

    // Loops through all of the addon packs in the folder, and allows the user to select the one if there are multiple
    for (const [name, type] of entries) {
        if (type !== vscode.FileType.Directory) {
            continue;
        }

        const dataDir = vscode.Uri.joinPath(addonpacksUri, name, "data", modId);
        if (!(await directoryExists(dataDir))) {
            continue;
        }

        const powerDir = vscode.Uri.joinPath(dataDir, "palladium", "powers");
        matches.push({
            label: name,
            description: vscode.workspace.asRelativePath(powerDir),
            target: powerDir
        });
    }

    if (matches.length === 0) {
        return undefined;
    }

    if (matches.length === 1) {
        return matches[0].target;
    }

    const selection = await vscode.window.showQuickPick(matches, {
        placeHolder: "Select the addon pack to store the new power"
    });

    return selection?.target;
}

async function pickAddonPackByModId(workspaceUri: vscode.Uri, modId: string): Promise<AddonPackPickItem | undefined> {
    const addonpacksUri = vscode.Uri.joinPath(workspaceUri, "addonpacks");
    let entries: [string, vscode.FileType][];

    try {
        entries = await vscode.workspace.fs.readDirectory(addonpacksUri);
    } catch {
        vscode.window.showErrorMessage("Could not access addonpacks folder.");
        return undefined;
    }

    const matches: AddonPackPickItem[] = [];
    for (const [name, type] of entries) {
        if ((type & vscode.FileType.Directory) === 0) {
            continue;
        }

        const packRoot = vscode.Uri.joinPath(addonpacksUri, name);
        const dataDir = vscode.Uri.joinPath(packRoot, "data", modId);
        if (!(await directoryExists(dataDir))) {
            continue;
        }

        matches.push({
            label: name,
            description: vscode.workspace.asRelativePath(packRoot),
            root: packRoot
        });
    }

    if (matches.length === 0) {
        return undefined;
    }

    if (matches.length === 1) {
        return matches[0];
    }

    const selection = await vscode.window.showQuickPick(matches, {
        placeHolder: `Select the addon pack that contains data/${modId}`
    });

    return selection as AddonPackPickItem | undefined;
}

async function directoryExists(uri: vscode.Uri): Promise<boolean> {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        return (stat.type & vscode.FileType.Directory) !== 0;
    } catch {
        return false;
    }
}

// Default power template
function buildPowerTemplate(name: string, guiDisplayType: string): string {
    return `{
    "name": "${name}",
    "persistent_data": true,
    "background": "minecraft:textures/block/white_wool.png",
    "icon": "minecraft:wither_skeleton_skull",
    "gui_display_type": "${guiDisplayType}",
    "abilities": {

    }
}`;
}

async function loadDocumentationSections(docsRoot: vscode.Uri): Promise<DocSection[]> {
    let directoryEntries: [string, vscode.FileType][];
    try {
        directoryEntries = await vscode.workspace.fs.readDirectory(docsRoot);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showWarningMessage(`Unable to read documentation directory: ${message}`);
        return [];
    }

    const htmlFiles = directoryEntries
        .filter(([, type]) => type === vscode.FileType.File)
        .map(([name]) => name)
        .filter(name => name.toLowerCase().endsWith(".html"));

    if (!htmlFiles.length) {
        return [];
    }

    const normalized = new Map<string, string>();
    htmlFiles.forEach(name => normalized.set(name.toLowerCase(), name));

    const orderedCandidates: { file: string; title: string }[] = [];

    const pushSpecial = (key: string, title: string) => {
        const actual = normalized.get(key);
        if (!actual) {
            return;
        }
        orderedCandidates.push({ file: actual, title });
        normalized.delete(key);
    };

    pushSpecial("abilities.html", "Abilities");
    pushSpecial("conditions.html", "Conditions");
    pushSpecial("energy_render_beams.html", "Energy Render Beams");
    pushSpecial("energy_beam_renderers.html", "Energy_Beam_Renders");


    Array.from(normalized.values())
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
        .forEach(file => {
            orderedCandidates.push({ file, title: formatDocTitle(file) });
        });

    const sections: DocSection[] = [];

    for (const candidate of orderedCandidates) {
        const target = vscode.Uri.joinPath(docsRoot, candidate.file);
        const section = await parseDocumentationFile(target, candidate.title);
        if (section && section.entries.length) {
            sections.push(section);
        }
    }

    return sections;
}

function formatDocTitle(fileName: string): string {
    const base = fileName.replace(/\.html$/i, "");
    const withSpaces = base.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    const parts = withSpaces.split(/[\s_-]+/).filter(Boolean);
    if (!parts.length) {
        return base;
    }

    return parts
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}

async function initializeGitRepository(target: vscode.Uri): Promise<void> {
    const gitExtension = vscode.extensions.getExtension("vscode.git");
    if (!gitExtension) {
        throw new Error("VS Code Git extension not available.");
    }

    const extensionExports: GitExtensionExports | undefined = gitExtension.isActive
        ? gitExtension.exports
        : await gitExtension.activate();

    if (!extensionExports || typeof extensionExports.getAPI !== "function") {
        throw new Error("Git extension API unavailable.");
    }

    const api = extensionExports.getAPI(1);
    if (!api || typeof api.init !== "function") {
        throw new Error("Git init API is unavailable.");
    }

    await api.init(target);
}

async function parseDocumentationFile(fileUri: vscode.Uri, title: string): Promise<DocSection | null> {
    try {
        const raw = await vscode.workspace.fs.readFile(fileUri);
        const contents = raw.toString();
        const entries = extractDocumentationEntries(contents, title);
        return entries.length ? { title, entries } : null;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showWarningMessage(`Unable to read ${path.basename(fileUri.fsPath)}: ${message}`);
        return null;
    }
}

function extractDocumentationEntries(html: string, sectionTitle: string): DocEntry[] {
    const $ = cheerio.load(html);
    const result: DocEntry[] = [];

    $("div[id]").each((_idx, element) => {
        const block = $(element);
        const id = block.attr("id")?.trim();
        if (!id || !id.includes(":")) {
            return;
        }

        block.find("script").remove();
        block.find("pre").each((_preIdx, node) => {
            const pre = $(node);
            const pretty = tryFormatJsonSnippet(pre.text());
            if (pretty) {
                pre.text(pretty);
            }
        });
        block.find("table").each((_tableIdx, tableNode) => {
            const tbl = $(tableNode);
            tbl.addClass("doc-table");
            tbl.find("thead th").each((_thIdx, thNode) => {
                const cell = $(thNode);
                const text = cell.text().trim().toLowerCase();
                if (text === "setting" || text === "settings") {
                    cell.text("Property");
                } else if (text === "fallback value" || text === "fallback") {
                    cell.text("Default Value");
                }
            });
        });

        const titleNode = block.find("h2").first();
        const title = titleNode.text().trim() || id;

        const descriptionNode = block.find("p").first();
        const description = descriptionNode.text().trim();
        const exampleNode = block.find("pre").first();
        const example = exampleNode.text().trim() || undefined;

        titleNode.remove();
        if (description && descriptionNode.length) {
            descriptionNode.remove();
        }

        const htmlContent = block.html() ?? "";
        const textContent = block.text().replace(/\s+/g, " ").trim().toLowerCase();
        const searchText = [id, title, description, textContent].filter(Boolean).join(" ").toLowerCase();

        result.push({
            id,
            title,
            description,
            html: htmlContent,
            searchText,
            example,
        });
    });

    return result;
}

function buildDocumentationWebviewContent(webview: vscode.Webview, sections: DocSection[]): string {
    const payload = sections.map(section => ({
        title: section.title,
        entries: section.entries.map(entry => ({
            id: entry.id,
            title: entry.title,
            description: entry.description,
            html: entry.html,
            searchText: entry.searchText,
            example: entry.example
        }))
    }));

    const data = JSON.stringify(payload);
    const nonce = Date.now().toString(36);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Palladium Documentation</title>
    <style>
        :root {
            color-scheme: dark;
            font-family: "Segoe UI", sans-serif;
            --bg: #0d1117;
            --panel: #151b23;
            --panel-alt: #1b232f;
            --border: #2b3240;
            --accent: #4aa8ff;
            --accent-muted: rgba(74, 168, 255, 0.15);
            --text-muted: #a3adba;
        }

        body {
            margin: 0;
            padding: 0;
            background: var(--bg);
            color: #f5f7fa;
        }

        header {
            position: sticky;
            top: 0;
            z-index: 10;
            background: rgba(13, 17, 23, 0.95);
            backdrop-filter: blur(6px);
            padding: 16px;
            border-bottom: 1px solid var(--border);
        }

        h1 {
            margin: 0 0 8px 0;
            font-size: 1.4rem;
        }

        #search {
            width: 100%;
            padding: 10px 12px;
            border-radius: 6px;
            border: 1px solid var(--border);
            background: var(--panel);
            color: inherit;
            font-size: 0.95rem;
        }

        #tab-bar {
            display: flex;
            gap: 8px;
            padding: 12px 24px;
            border-bottom: 1px solid var(--border);
            background: var(--bg);
            justify-content: flex-start;
            align-items: center;
            flex-wrap: wrap;
        }

        .tab-button {
            padding: 8px 18px;
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.12);
            background: var(--panel-alt);
            color: inherit;
            cursor: pointer;
            transition: background 0.2s ease, border-color 0.2s ease;
            font-size: 0.95rem;
        }

        .tab-button.active {
            background: var(--accent-muted);
            border-color: var(--accent);
            color: #fff;
        }

        .tab-button:not(.active):hover {
            border-color: rgba(255, 255, 255, 0.3);
            background: rgba(255, 255, 255, 0.08);
        }

        #docs {
            padding: 24px;
            display: flex;
            flex-direction: column;
            gap: 24px;
        }

        .doc-section {
            background: var(--panel);
            border: 1px solid rgba(255, 255, 255, 0.04);
            border-radius: 12px;
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        .doc-section h2 {
            margin: 0;
            font-size: 1.2rem;
        }

        .doc-entries {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        .doc-entry {
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.05);
            background: var(--panel-alt);
            padding: 16px;
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.25);
        }

        .doc-entry header {
            position: static;
            background: transparent;
            border-bottom: none;
            padding: 0;
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
        }

        .doc-entry h3 {
            margin: 0;
        }

        .id-badge {
            color: var(--text-muted);
            font-size: 0.85rem;
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 6px;
            padding: 2px 10px;
            background: rgba(255, 255, 255, 0.04);
        }

        .doc-entry-body {
            overflow-x: auto;
        }

        pre {
            background: #0b0f16;
            padding: 14px;
            border-radius: 6px;
            border: 1px solid rgba(255, 255, 255, 0.08);
            overflow-x: auto;
            font-family: "JetBrains Mono", "Consolas", monospace;
            font-size: 0.9rem;
            line-height: 1.4;
            color: #e5f0ff;
        }

        .example-block {
            border: 1px solid var(--border);
            border-radius: 8px;
            background: var(--panel-alt);
            overflow: hidden;
        }

        .example-block summary {
            list-style: none;
            cursor: pointer;
            padding: 10px 12px;
            display: flex;
            align-items: center;
            gap: 8px;
            font-weight: 600;
            color: var(--text-muted);
            user-select: none;
        }

        .example-block summary::-webkit-details-marker {
            display: none;
        }

        .example-block summary::before {
            content: "▶";
            font-size: 0.7rem;
            transition: transform 0.15s ease;
            color: var(--text-muted);
        }

        .example-block[open] summary::before {
            transform: rotate(90deg);
        }

        .example-block[open] summary {
            color: #fff;
            border-bottom: 1px solid var(--border);
            background: rgba(255, 255, 255, 0.04);
        }

        .example-block pre {
            margin: 0;
            border: none;
            border-radius: 0;
            border-top: 1px solid rgba(255, 255, 255, 0.08);
        }

        .doc-entry table {
            width: 100%;
            border-collapse: collapse;
            margin: 12px 0 18px 0;
            font-size: 0.9rem;
        }

        .doc-entry-body h3,
        .doc-entry-body h4 {
            margin: 18px 0 8px 0;
        }

        .doc-entry th,
        .doc-entry td {
            border: 1px solid var(--border);
            padding: 8px 10px;
            vertical-align: top;
        }

        .doc-entry thead {
            background: rgba(255, 255, 255, 0.04);
        }

        .empty-placeholder {
            margin: 0;
            padding: 32px;
            border: 1px dashed var(--border);
            border-radius: 8px;
            text-align: center;
            color: var(--text-muted);
            background: rgba(255, 255, 255, 0.02);
        }

        .doc-entry.search-hidden {
            display: none !important;
        }

        .hidden {
            display: none !important;
        }

    </style>
</head>
<body>
    <header>
        <h1>Palladium Documentation</h1>
        <input id="search" type="search" placeholder="Search by name, ID, or description..." />
    </header>
    <nav id="tab-bar"></nav>
    <main id="docs"></main>
    <script nonce="${nonce}">
        const data = ${data};
        const tabs = document.getElementById("tab-bar");
        const container = document.getElementById("docs");
        const input = document.getElementById("search");
        let activeTab = data[0]?.title ?? "";

        const collapseExamples = (root) => {
            const preBlocks = Array.from(root.querySelectorAll("pre"));
            preBlocks.forEach((pre, idx) => {
                if (pre.closest(".example-block")) {
                    return;
                }

                const details = document.createElement("details");
                details.className = "example-block";

                const summary = document.createElement("summary");
                const heading = pre.previousElementSibling;
                if (heading && /^H[1-6]$/i.test(heading.tagName) && heading.textContent?.trim()) {
                    summary.textContent = heading.textContent.trim();
                    heading.remove();
                } else {
                    summary.textContent = \`Example \${idx + 1}\`;
                }

                const parent = pre.parentElement;
                if (!parent) {
                    return;
                }

                parent.insertBefore(details, pre);
                details.appendChild(summary);
                details.appendChild(pre);
            });
        };

        const createEntry = (entry, sectionTitle) => {
            const article = document.createElement("article");
            article.className = "doc-entry";
            article.dataset.search = entry.searchText;
            article.id = entry.id.replace(/[^\\w-]+/g, "_");
            article.dataset.section = sectionTitle;
            article.dataset.id = entry.id.toLowerCase();
            if (entry.example) {
                article.dataset.example = entry.example;
            }

            const header = document.createElement("header");
            const title = document.createElement("h3");
            title.textContent = entry.title;
            const badge = document.createElement("span");
            badge.className = "id-badge";
            badge.textContent = entry.id;

            header.appendChild(title);
            header.appendChild(badge);

            article.appendChild(header);

            if (entry.description) {
                const desc = document.createElement("p");
                desc.textContent = entry.description;
                article.appendChild(desc);
            }

            const body = document.createElement("div");
            body.className = "doc-entry-body";
            body.innerHTML = entry.html;
            collapseExamples(body);
            article.appendChild(body);

            return article;
        };

        const buildSections = () => {
            container.innerHTML = "";
            data.forEach(section => {
                const sectionEl = document.createElement("section");
                sectionEl.className = "doc-section";
                sectionEl.dataset.section = section.title;

                const title = document.createElement("h2");
                title.textContent = section.title;
                sectionEl.appendChild(title);

                const entriesWrapper = document.createElement("div");
                entriesWrapper.className = "doc-entries";
                section.entries.forEach(entry => {
                    entriesWrapper.appendChild(createEntry(entry, section.title));
                });

                const placeholder = document.createElement("p");
                placeholder.className = "empty-placeholder hidden";
                placeholder.textContent = "No entries match your search.";

                sectionEl.appendChild(entriesWrapper);
                sectionEl.appendChild(placeholder);
                container.appendChild(sectionEl);
            });
        };

        const buildTabs = () => {
            tabs.innerHTML = "";
            data.forEach(section => {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.textContent = section.title;
                btn.className = "tab-button";
                btn.dataset.section = section.title;
                btn.addEventListener("click", () => setActiveTab(section.title));
                tabs.appendChild(btn);
            });
        };

        const setActiveTab = (title) => {
            activeTab = title;
            document.querySelectorAll(".tab-button").forEach(btn => {
                btn.classList.toggle("active", btn.dataset.section === title);
            });
            document.querySelectorAll(".doc-section").forEach(section => {
                section.classList.toggle("hidden", section.dataset.section !== title);
            });
        };

        const applySearch = () => {
            const raw = input.value.trim();
            const query = raw.toLowerCase();
            const isIdSearch = query.startsWith("id:");
            const idTerm = isIdSearch ? query.slice(3).trim() : "";

            document.querySelectorAll(".doc-entry").forEach(entry => {
                const idHaystack = entry.dataset.id ?? "";
                const haystack = entry.dataset.search ?? "";
                let hide = false;

                if (!raw) {
                    hide = false;
                } else if (isIdSearch) {
                    hide = idTerm.length > 0 && !idHaystack.includes(idTerm);
                } else {
                    hide = query.length > 1 && !haystack.includes(query);
                }

                entry.classList.toggle("search-hidden", hide);
            });

            document.querySelectorAll(".doc-section").forEach(section => {
                const placeholder = section.querySelector(".empty-placeholder");
                const hasVisibleEntry = section.querySelector(".doc-entry:not(.search-hidden)") !== null;
                if (placeholder) {
                    placeholder.classList.toggle("hidden", hasVisibleEntry);
                }
            });
        };

        buildTabs();
        buildSections();
        setActiveTab(activeTab);
        applySearch();

        input.addEventListener("input", () => {
            applySearch();
        });
    </script>
</body>
</html>`;
}

function tryFormatJsonSnippet(raw: string): string | null {
    if (!raw) {
        return null;
    }

    const trimmed = raw.trim();
    if (!trimmed) {
        return null;
    }

    try {
        const parsed = JSON.parse(trimmed);
        return JSON.stringify(parsed, null, 4);
    } catch {
        return null;
    }
}

function normalizeEntryJson(example: string | undefined, sectionTitle?: string): string | undefined {
    if (!example) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(example);
        if (sectionTitle && sectionTitle.toLowerCase().includes("abilit")) {
            ensureConditionsBlock(parsed);
        }
        return JSON.stringify(parsed, null, 4);
    } catch {
        return example;
    }
}

function ensureConditionsBlock(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return;
    }

    const obj = value as Record<string, unknown>;
    const existing = obj["conditions"];

    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
        obj["conditions"] = { enabling: [], unlocking: [] };
        return;
    }

    const target = existing as Record<string, unknown>;
    if (!Array.isArray(target["enabling"])) {
        target["enabling"] = [];
    }
    if (!Array.isArray(target["unlocking"])) {
        target["unlocking"] = [];
    }
}
