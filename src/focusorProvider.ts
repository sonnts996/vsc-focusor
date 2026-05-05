import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './gitService';
import { FocusorDecorationProvider } from './decorationProvider';
import { FocusorItem, FocusorItemType, getStatusDisplay } from './models';
import { Repository, Change, Status } from './git';

const SELECT_ALL_ID = '__focusor_select_all__';

export type ViewMode = 'list' | 'tree';

/**
 * Represents a folder node in tree view mode.
 */
class FolderNode {
	children: Map<string, FolderNode> = new Map();
	files: { change: Change; filePath: string; relativePath: string }[] = [];
}

/**
 * TreeDataProvider for the Focusor changes view.
 * Shows repos with changes as collapsible parent nodes, with changed files as children.
 * Supports list mode (flat) and tree mode (directory hierarchy).
 */
export class FocusorProvider implements vscode.TreeDataProvider<FocusorItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<FocusorItem | undefined | null>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	/** Set of repo root paths that the user has hidden via the filter. */
	private hiddenRepos: Set<string>;

	/** Current view mode: 'list' (flat) or 'tree' (directory hierarchy). */
	private viewMode: ViewMode;

	/** Reference to the TreeView for programmatic control (expand all). */
	private treeView: vscode.TreeView<FocusorItem> | undefined;

	constructor(
		private readonly gitService: GitService,
		private readonly decorationProvider: FocusorDecorationProvider,
		private readonly context: vscode.ExtensionContext,
	) {
		// Restore hidden repos from workspace state
		const saved = context.workspaceState.get<string[]>('focusor.hiddenRepos', []);
		this.hiddenRepos = new Set(saved);

		// Restore view mode from workspace state
		this.viewMode = context.workspaceState.get<ViewMode>('focusor.viewMode', 'list');

		// Auto-refresh when git state changes
		gitService.onDidChange(() => this.refresh());
	}

	/**
	 * Set the TreeView reference for programmatic control.
	 */
	setTreeView(treeView: vscode.TreeView<FocusorItem>): void {
		this.treeView = treeView;
	}

	/**
	 * Get current view mode.
	 */
	getViewMode(): ViewMode {
		return this.viewMode;
	}

	/**
	 * Refresh the tree view.
	 */
	refresh(): void {
		this.decorationProvider.clearAll();
		this._onDidChangeTreeData.fire(undefined);
	}

	/**
	 * Toggle between list and tree view modes.
	 */
	async toggleViewMode(): Promise<void> {
		this.viewMode = this.viewMode === 'list' ? 'tree' : 'list';
		await this.context.workspaceState.update('focusor.viewMode', this.viewMode);
		this.refresh();
	}

	/**
	 * Expand all repo nodes in the tree view.
	 */
	async expandAll(): Promise<void> {
		if (!this.treeView) { return; }

		const repoNodes = this.getRepoNodes();
		for (const node of repoNodes) {
			try {
				await this.treeView.reveal(node, { expand: 2, select: false, focus: false });
			} catch {
				// Ignore errors if node is not visible
			}
		}
	}

	getTreeItem(element: FocusorItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: FocusorItem): FocusorItem[] {
		if (!element) {
			// Root level — show changed repos (filtered by visibility)
			return this.getRepoNodes();
		}

		if (element.itemType === FocusorItemType.Repo && element.repoPath) {
			if (this.viewMode === 'tree') {
				return this.getTreeModeChildren(element.repoPath, undefined);
			}
			// List mode — flat file list
			return this.getFileNodes(element.repoPath);
		}

		if (element.itemType === FocusorItemType.Folder && element.repoPath && element.folderPath) {
			return this.getTreeModeChildren(element.repoPath, element.folderPath);
		}

		return [];
	}

	/**
	 * Needed for TreeView.reveal() — returns the parent of a given element.
	 */
	getParent(element: FocusorItem): FocusorItem | undefined {
		if (element.itemType === FocusorItemType.Repo) {
			return undefined;
		}

		if (element.itemType === FocusorItemType.File && element.repoPath) {
			if (this.viewMode === 'list') {
				// Parent is the repo node
				return this.getRepoNodes().find((n) => n.repoPath === element.repoPath);
			}
			// Tree mode — parent could be a folder or repo
			if (element.filePath) {
				const relativePath = path.relative(element.repoPath, element.filePath);
				const dirPath = path.dirname(relativePath);
				if (dirPath === '.') {
					return this.getRepoNodes().find((n) => n.repoPath === element.repoPath);
				}
				// Return a folder node
				return new FocusorItem(
					FocusorItemType.Folder,
					path.basename(dirPath),
					vscode.TreeItemCollapsibleState.Expanded,
					element.repoPath,
					undefined,
					undefined,
					dirPath,
				);
			}
		}

		if (element.itemType === FocusorItemType.Folder && element.repoPath && element.folderPath) {
			const parentDir = path.dirname(element.folderPath);
			if (parentDir === '.') {
				return this.getRepoNodes().find((n) => n.repoPath === element.repoPath);
			}
			return new FocusorItem(
				FocusorItemType.Folder,
				path.basename(parentDir),
				vscode.TreeItemCollapsibleState.Expanded,
				element.repoPath,
				undefined,
				undefined,
				parentDir,
			);
		}

		return undefined;
	}

	/**
	 * Build repo nodes for all repos with changes that are not hidden.
	 * Sorted by workspace folder order. Inserts separators between repos.
	 */
	private getRepoNodes(): FocusorItem[] {
		const changedRepos = this.gitService.getChangedRepositories();

		// Sort repos by workspace folder order
		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
		const sortedRepos = [...changedRepos].sort((a, b) => {
			const indexA = this.getWorkspaceFolderIndex(a.rootUri.fsPath, workspaceFolders);
			const indexB = this.getWorkspaceFolderIndex(b.rootUri.fsPath, workspaceFolders);
			return indexA - indexB;
		});

		const config = vscode.workspace.getConfiguration('focusor');
		const showSeparator = config.get<boolean>('showSeparator', true);
		const sepLength = config.get<number>('separatorLength', 10);
		const sepString = '─'.repeat(Math.max(1, sepLength));

		const nodes: FocusorItem[] = [];
		let visibleCount = 0;

		for (const repo of sortedRepos) {
			const rootPath = repo.rootUri.fsPath;

			// Skip hidden repos
			if (this.hiddenRepos.has(rootPath)) {
				continue;
			}

			// Add separator between repos (not before the first one)
			if (visibleCount > 0 && showSeparator) {
				const sep = new FocusorItem(
					FocusorItemType.Separator,
					sepString,
					vscode.TreeItemCollapsibleState.None,
				);
				sep.id = `separator-${visibleCount}`;
				sep.tooltip = '';
				nodes.push(sep);
			}

			const info = this.gitService.getRepoInfo(repo);
			const label = info.name;
			const description = `${info.branch} · ${info.changesCount} change${info.changesCount !== 1 ? 's' : ''}`;

			const item = new FocusorItem(
				FocusorItemType.Repo,
				label,
				vscode.TreeItemCollapsibleState.Expanded,
				rootPath,
			);
			item.description = description;
			item.tooltip = `${info.name} (${info.branch})\n${rootPath}\n${info.changesCount} change(s)`;

			nodes.push(item);
			visibleCount++;
		}

		return nodes;
	}

	/**
	 * Get the index of the workspace folder that contains the given repo path.
	 * Returns Infinity if no matching folder is found (sorts to end).
	 */
	private getWorkspaceFolderIndex(repoPath: string, folders: readonly vscode.WorkspaceFolder[]): number {
		for (let i = 0; i < folders.length; i++) {
			const folderPath = folders[i].uri.fsPath;
			if (repoPath === folderPath || repoPath.startsWith(folderPath + path.sep)) {
				return i;
			}
		}
		return Infinity;
	}

	/**
	 * Build file nodes for all changes in a repo (list/flat mode).
	 */
	private getFileNodes(repoPath: string): FocusorItem[] {
		const repos = this.gitService.getAllRepositories();
		const repo = repos.find((r) => r.rootUri.fsPath === repoPath);
		if (!repo) { return []; }

		const changes = this.gitService.getAllChanges(repo);
		const nodes: FocusorItem[] = [];

		for (const change of changes) {
			const filePath = change.uri.fsPath;
			const relativePath = path.relative(repoPath, filePath);
			const fileName = path.basename(filePath);
			const dirPath = path.dirname(relativePath);

			const item = new FocusorItem(
				FocusorItemType.File,
				fileName,
				vscode.TreeItemCollapsibleState.None,
				repoPath,
				filePath,
				change.status,
			);

			// Show relative directory path as description (like SCM does)
			item.description = dirPath !== '.' ? dirPath : '';

			// Status display
			const display = getStatusDisplay(change.status);
			item.tooltip = `${relativePath} · ${display.tooltip}`;

			// Register decoration for this file
			this.decorationProvider.setDecoration(change.uri, change.status);

			nodes.push(item);
		}

		return nodes;
	}

	/**
	 * Build children for tree view mode — folders and files under a given folder path.
	 */
	private getTreeModeChildren(repoPath: string, folderPath: string | undefined): FocusorItem[] {
		const repos = this.gitService.getAllRepositories();
		const repo = repos.find((r) => r.rootUri.fsPath === repoPath);
		if (!repo) { return []; }

		const changes = this.gitService.getAllChanges(repo);
		const nodes: FocusorItem[] = [];

		// Collect direct subfolders and direct files
		const subfolders = new Map<string, number>(); // subfolder name → change count
		const directFiles: { change: Change; relativePath: string; filePath: string }[] = [];

		for (const change of changes) {
			const filePath = change.uri.fsPath;
			const relativePath = path.relative(repoPath, filePath);

			// Determine path relative to current folder
			const relativeToFolder = folderPath ? path.relative(folderPath, relativePath) : relativePath;

			// Skip files not under this folder
			if (relativeToFolder.startsWith('..')) {
				continue;
			}

			const parts = relativeToFolder.split(path.sep);

			if (parts.length === 1) {
				// Direct file in this folder
				directFiles.push({ change, relativePath, filePath });
			} else {
				// File is inside a subfolder
				const subfolderName = parts[0];
				subfolders.set(subfolderName, (subfolders.get(subfolderName) || 0) + 1);
			}
		}

		// Add folder nodes first (sorted alphabetically)
		const sortedFolders = Array.from(subfolders.entries()).sort((a, b) => a[0].localeCompare(b[0]));
		for (const [folderName, count] of sortedFolders) {
			const fullFolderPath = folderPath ? path.join(folderPath, folderName) : folderName;
			const item = new FocusorItem(
				FocusorItemType.Folder,
				folderName,
				vscode.TreeItemCollapsibleState.Expanded,
				repoPath,
				undefined,
				undefined,
				fullFolderPath,
			);
			item.description = `${count} change${count !== 1 ? 's' : ''}`;
			nodes.push(item);
		}

		// Add file nodes (sorted alphabetically)
		directFiles.sort((a, b) => path.basename(a.filePath).localeCompare(path.basename(b.filePath)));
		for (const { change, relativePath, filePath } of directFiles) {
			const fileName = path.basename(filePath);
			const item = new FocusorItem(
				FocusorItemType.File,
				fileName,
				vscode.TreeItemCollapsibleState.None,
				repoPath,
				filePath,
				change.status,
			);

			const display = getStatusDisplay(change.status);
			item.tooltip = `${relativePath} · ${display.tooltip}`;
			this.decorationProvider.setDecoration(change.uri, change.status);
			nodes.push(item);
		}

		return nodes;
	}

	/**
	 * Show QuickPick to filter which changed repos are visible.
	 * Includes a "Select All" toggle at the top.
	 */
	async filterRepos(): Promise<void> {
		const changedRepos = this.gitService.getChangedRepositories();
		if (changedRepos.length === 0) {
			vscode.window.showInformationMessage('Focusor: No changed repositories found.');
			return;
		}

		// Build QuickPick
		const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem>();
		quickPick.title = 'Filter Visible Repositories';
		quickPick.placeholder = 'Select repositories to show in Focusor';
		quickPick.canSelectMany = true;

		// Build items
		const selectAllItem: vscode.QuickPickItem = {
			label: '$(check-all) Select All / Deselect All',
			description: '',
			alwaysShow: true,
		};

		const separator: vscode.QuickPickItem = {
			label: '',
			kind: vscode.QuickPickItemKind.Separator,
		};

		const repoItems: vscode.QuickPickItem[] = changedRepos.map((repo) => {
			const info = this.gitService.getRepoInfo(repo);
			return {
				label: info.name,
				description: `${info.branch} · ${info.changesCount} change${info.changesCount !== 1 ? 's' : ''}`,
				detail: info.rootPath,
				alwaysShow: true,
			};
		});

		quickPick.items = [selectAllItem, separator, ...repoItems];

		// Pre-select: Select All + all non-hidden repos
		const allSelected = repoItems.every((item) => !this.hiddenRepos.has(item.detail!));
		const preSelected: vscode.QuickPickItem[] = [];

		if (allSelected) {
			preSelected.push(selectAllItem);
		}
		for (const item of repoItems) {
			if (!this.hiddenRepos.has(item.detail!)) {
				preSelected.push(item);
			}
		}
		quickPick.selectedItems = preSelected;

		// Track whether we're programmatically changing selection (to avoid infinite loop)
		let isUpdating = false;

		quickPick.onDidChangeSelection((selected) => {
			if (isUpdating) { return; }

			const hasSelectAll = selected.some((s) => s === selectAllItem);
			const hadSelectAll = preSelected.some((s) => s === selectAllItem);

			// Detect if "Select All" was toggled
			if (hasSelectAll && !hadSelectAll) {
				// User just ticked Select All → select everything
				isUpdating = true;
				quickPick.selectedItems = [selectAllItem, ...repoItems];
				isUpdating = false;
			} else if (!hasSelectAll && hadSelectAll) {
				// User just unticked Select All → deselect everything
				isUpdating = true;
				quickPick.selectedItems = [];
				isUpdating = false;
			} else {
				// User toggled a repo item — update Select All status
				const selectedRepos = selected.filter((s) => s !== selectAllItem && s.kind !== vscode.QuickPickItemKind.Separator);
				const allReposSelected = selectedRepos.length === repoItems.length;

				if (allReposSelected && !hasSelectAll) {
					isUpdating = true;
					quickPick.selectedItems = [selectAllItem, ...repoItems];
					isUpdating = false;
				} else if (!allReposSelected && hasSelectAll) {
					isUpdating = true;
					quickPick.selectedItems = selected.filter((s) => s !== selectAllItem);
					isUpdating = false;
				}
			}

			// Update preSelected reference for next comparison
			preSelected.length = 0;
			preSelected.push(...quickPick.selectedItems);
		});

		// Handle accept
		const result = await new Promise<readonly vscode.QuickPickItem[] | undefined>((resolve) => {
			quickPick.onDidAccept(() => {
				resolve(quickPick.selectedItems);
				quickPick.dispose();
			});
			quickPick.onDidHide(() => {
				resolve(undefined);
				quickPick.dispose();
			});
			quickPick.show();
		});

		if (result === undefined) {
			return; // Cancelled
		}

		// Determine which repos are selected (visible)
		const selectedPaths = new Set(
			result
				.filter((item) => item !== selectAllItem && item.kind !== vscode.QuickPickItemKind.Separator && item.detail)
				.map((item) => item.detail!),
		);

		// Hidden = all changed repos NOT in selectedPaths
		this.hiddenRepos = new Set(
			changedRepos
				.map((r) => r.rootUri.fsPath)
				.filter((p) => !selectedPaths.has(p)),
		);

		// Persist state
		await this.context.workspaceState.update('focusor.hiddenRepos', Array.from(this.hiddenRepos));

		// Refresh tree
		this.refresh();
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}
}
