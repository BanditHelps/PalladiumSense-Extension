import * as vscode from 'vscode';
import * as path from 'path';


import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient;

export function activate(context: vscode.ExtensionContext) {
	console.log('Palladium Sense is active!');

	// Register the "Power" command
    context.subscriptions.push(registerNewPowerCommand());

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
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const docsRoot = workspaceRoot
        ? path.join(workspaceRoot, "mods", "documentation", "palladium")
        : undefined;

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: "file", language: "json" }],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher("**/*.html")
        },
        initializationOptions: {
            docsRoot,
            abilitiesFile: docsRoot ? path.join(docsRoot, "abilities.html") : undefined,
            conditionsFile: docsRoot ? path.join(docsRoot, "conditions.html") : undefined
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
}
`;
}
