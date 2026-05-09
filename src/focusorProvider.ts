import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './gitService';
import { FocusorDecorationProvider } from './decorationProvider';
import { FocusorItem, FocusorItemType, getStatusDisplay } from './models';
import { Repository, Change, Status } from './git';

const SELECT_ALL_ID = '__focusor_select_all__';

export type ViewMode = 'list' | 'tree' | 'compact';

/**
 * Represents a folder node in tree view mode.
 */
class FolderNode {
	children: Map<string, FolderNode> = new Map();
	files: { change: Change; filePath: string; relativePath: string }[] = [];
}

/**
 * TreeDataProvider for the Focusor changes view.
 * Shows repos with changes as collapsible parent nodes, with staged/unstaged groups,
 * and changed files as children.
 * Supports list mode (flat) and tree mode (directory hierarchy).
 */
export class FocusorProvider implements vscode.TreeDataProvider<FocusorItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<FocusorItem | undefined | null>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	/** Set of repo root paths that the user has hidden via the filter. */
	private hiddenRepos: Set<string>;

	/** Current view mode: 'list' (flat), 'tree' (directory hierarchy), or 'compact' (flat dirs). */
	private viewMode: ViewMode;

	/** Cache for tree mode hierarchy: map from repoPath to map of folderPath to FocusorItem[] */
	private treeModeCache: Map<string, Map<string, FocusorItem[]>> = new Map();

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

		// Initialize view mode from configuration
		const config = vscode.workspace.getConfiguration('focusor');
		this.viewMode = config.get<ViewMode>('changes.viewMode', 'tree');

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
		this.treeModeCache.clear();
		this._onDidChangeTreeData.fire(undefined);
	}

	/**
	 * Cycle the view mode between list, tree, and compact.
	 */
	async toggleViewMode(): Promise<void> {
		const modes: ViewMode[] = ['list', 'tree', 'compact'];
		const currentIndex = modes.indexOf(this.viewMode);
		this.viewMode = modes[(currentIndex + 1) % modes.length];
		
		const config = vscode.workspace.getConfiguration('focusor');
		await config.update('changes.viewMode', this.viewMode, vscode.ConfigurationTarget.Global);
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
			const config = vscode.workspace.getConfiguration('focusor');
			const splitStaged = config.get<boolean>('changes.splitStaged', true);
			this.viewMode = config.get<ViewMode>('changes.viewMode', 'tree');

			if (splitStaged) {
				// Under a repo — show Staged Changes and Changes groups
				return this.getGroupNodes(element.repoPath);
			} else {
				// Under a repo — flat list or tree of all changes
				if (this.viewMode === 'tree' || this.viewMode === 'compact') {
					return this.getTreeModeChildren(element.repoPath, undefined, undefined);
				}
				return this.getFileNodes(element.repoPath, undefined);
			}
		}

		if (element.itemType === FocusorItemType.StagedGroup && element.repoPath) {
			if (this.viewMode === 'tree' || this.viewMode === 'compact') {
				return this.getTreeModeChildren(element.repoPath, undefined, true);
			}
			return this.getFileNodes(element.repoPath, true);
		}

		if (element.itemType === FocusorItemType.UnstagedGroup && element.repoPath) {
			if (this.viewMode === 'tree' || this.viewMode === 'compact') {
				return this.getTreeModeChildren(element.repoPath, undefined, false);
			}
			return this.getFileNodes(element.repoPath, false);
		}

		if (element.itemType === FocusorItemType.Folder && element.repoPath && element.folderPath) {
			return this.getTreeModeChildren(element.repoPath, element.folderPath, element.isStaged);
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

		if (element.itemType === FocusorItemType.StagedGroup || element.itemType === FocusorItemType.UnstagedGroup) {
			return this.getRepoNodes().find((n) => n.repoPath === element.repoPath);
		}

		if (element.itemType === FocusorItemType.File && element.repoPath) {
			const isStaged = element.isStaged;
			const config = vscode.workspace.getConfiguration('focusor');
			const splitStaged = config.get<boolean>('changes.splitStaged', true);

			if (this.viewMode === 'list') {
				if (splitStaged && isStaged !== undefined) {
					// Parent is the staged/unstaged group
					return this.createGroupItem(element.repoPath, isStaged);
				} else {
					// Parent is the repo
					return this.getRepoNodes().find((n) => n.repoPath === element.repoPath);
				}
			}
			// Tree mode — parent could be a folder, group, or repo
			if (element.filePath) {
				const relativePath = path.relative(element.repoPath, element.filePath);
				const dirPath = path.dirname(relativePath);
				if (dirPath === '.') {
					if (splitStaged && isStaged !== undefined) {
						return this.createGroupItem(element.repoPath, isStaged);
					} else {
						return this.getRepoNodes().find((n) => n.repoPath === element.repoPath);
					}
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
					isStaged,
				);
			}
		}

		if (element.itemType === FocusorItemType.Folder && element.repoPath && element.folderPath) {
			const parentDir = path.dirname(element.folderPath);
			const isStaged = element.isStaged;
			const config = vscode.workspace.getConfiguration('focusor');
			const splitStaged = config.get<boolean>('changes.splitStaged', true);

			if (parentDir === '.') {
				if (splitStaged && isStaged !== undefined) {
					return this.createGroupItem(element.repoPath, isStaged);
				} else {
					return this.getRepoNodes().find((n) => n.repoPath === element.repoPath);
				}
			}
			return new FocusorItem(
				FocusorItemType.Folder,
				path.basename(parentDir),
				vscode.TreeItemCollapsibleState.Expanded,
				element.repoPath,
				undefined,
				undefined,
				parentDir,
				isStaged,
			);
		}

		return undefined;
	}

	/**
	 * Create a staged/unstaged group item (helper for getParent).
	 */
	private createGroupItem(repoPath: string, isStaged: boolean): FocusorItem {
		const repos = this.gitService.getAllRepositories();
		const repo = repos.find((r) => r.rootUri.fsPath === repoPath);
		const count = repo
			? (isStaged ? this.gitService.getStagedChanges(repo).length : this.gitService.getUnstagedChanges(repo).length)
			: 0;

		const itemType = isStaged ? FocusorItemType.StagedGroup : FocusorItemType.UnstagedGroup;
		const label = isStaged ? 'Staged Changes' : 'Changes';
		const item = new FocusorItem(
			itemType,
			label,
			vscode.TreeItemCollapsibleState.Expanded,
			repoPath,
		);
		item.description = `${count}`;
		return item;
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

		const generalConfig = vscode.workspace.getConfiguration('focusor.general');
		const showSeparator = generalConfig.get<boolean>('showSeparator', true);
		const sepLength = generalConfig.get<number>('separatorLength', 10);
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
	 * Build "Staged Changes" and "Changes" group nodes under a repo.
	 * Only shows groups that have at least one change.
	 */
	private getGroupNodes(repoPath: string): FocusorItem[] {
		const repos = this.gitService.getAllRepositories();
		const repo = repos.find((r) => r.rootUri.fsPath === repoPath);
		if (!repo) { return []; }

		const stagedChanges = this.gitService.getStagedChanges(repo);
		const unstagedChanges = this.gitService.getUnstagedChanges(repo);
		const nodes: FocusorItem[] = [];

		if (stagedChanges.length > 0) {
			const item = new FocusorItem(
				FocusorItemType.StagedGroup,
				'Staged Changes',
				vscode.TreeItemCollapsibleState.Expanded,
				repoPath,
			);
			item.description = `${stagedChanges.length}`;
			nodes.push(item);
		}

		if (unstagedChanges.length > 0) {
			const item = new FocusorItem(
				FocusorItemType.UnstagedGroup,
				'Changes',
				vscode.TreeItemCollapsibleState.Expanded,
				repoPath,
			);
			item.description = `${unstagedChanges.length}`;
			nodes.push(item);
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
	 * Build file nodes for staged, unstaged, or all changes in a repo (list/flat mode).
	 */
	private getFileNodes(repoPath: string, staged: boolean | undefined): FocusorItem[] {
		const repos = this.gitService.getAllRepositories();
		const repo = repos.find((r) => r.rootUri.fsPath === repoPath);
		if (!repo) { return []; }

		const changes = staged === undefined
			? this.gitService.getAllChanges(repo)
			: (staged ? this.gitService.getStagedChanges(repo) : this.gitService.getUnstagedChanges(repo));
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
				undefined,
				staged,
			);

			// Show relative directory path as description (like SCM does)
			item.description = dirPath !== '.' ? dirPath : '';

			// Status display
			const display = getStatusDisplay(change.status);
			
			const tooltip = new vscode.MarkdownString();
			tooltip.appendMarkdown(`**${fileName}** • ${display.tooltip}\n\n`);
			tooltip.appendMarkdown(`Path: \`${relativePath}\``);
			item.tooltip = tooltip;

			// Register decoration for this file
			this.decorationProvider.setDecoration(change.uri, change.status);

			nodes.push(item);
		}

		return nodes;
	}

	/**
	 * Build children for tree view mode — folders and files under a given folder path.
	 * Uses caching to prevent O(N) recalculations for every folder expansion.
	 */
	private getTreeModeChildren(repoPath: string, folderPath: string | undefined, staged: boolean | undefined): FocusorItem[] {
		const cacheKey = `${repoPath}::${staged === undefined ? 'all' : staged ? 'staged' : 'unstaged'}`;
		
		if (!this.treeModeCache.has(cacheKey)) {
			// Build the entire tree structure for this repo and cache it
			this.buildTreeModeCacheForRepo(repoPath, staged, cacheKey);
		}

		const repoCache = this.treeModeCache.get(cacheKey)!;
		const queryPath = folderPath || '.';
		return repoCache.get(queryPath) || [];
	}

	/**
	 * Builds and caches the hierarchical structure of changes for a given repository.
	 */
	private buildTreeModeCacheForRepo(repoPath: string, staged: boolean | undefined, cacheKey: string): void {
		const repoCache = new Map<string, FocusorItem[]>();
		this.treeModeCache.set(cacheKey, repoCache);

		const repos = this.gitService.getAllRepositories();
		const repo = repos.find((r) => r.rootUri.fsPath === repoPath);
		if (!repo) { return; }

		const changes = staged === undefined
			? this.gitService.getAllChanges(repo)
			: (staged ? this.gitService.getStagedChanges(repo) : this.gitService.getUnstagedChanges(repo));

		// Maps folderPath -> { subfolders: Set<string>, files: Change[] }
		const structure = new Map<string, { subfolders: Map<string, number>; files: { change: Change; relativePath: string; filePath: string }[] }>();

		// Helper to ensure folder exists in structure
		const ensureFolder = (fPath: string) => {
			if (!structure.has(fPath)) {
				structure.set(fPath, { subfolders: new Map(), files: [] });
			}
			return structure.get(fPath)!;
		};

		// Pass 1: Build the hierarchical structure
		for (const change of changes) {
			const filePath = change.uri.fsPath;
			const relativePath = path.relative(repoPath, filePath);
			
			// Process each directory level
			const parts = relativePath.split(path.sep);
			const fileName = parts.pop()!;
			
			// Add file to its direct parent folder
			const parentFolder = parts.length > 0 ? parts.join(path.sep) : '.';
			const parentNode = ensureFolder(parentFolder);
			parentNode.files.push({ change, relativePath, filePath });

			// Traverse up and populate subfolder sets and counts
			let currentPath = parentFolder;
			let currentParts = parts;
			
			while (currentPath !== '.') {
				currentParts.pop();
				const grandParentPath = currentParts.length > 0 ? currentParts.join(path.sep) : '.';
				const folderName = path.basename(currentPath);
				
				const grandParentNode = ensureFolder(grandParentPath);
				const count = grandParentNode.subfolders.get(folderName) || 0;
				grandParentNode.subfolders.set(folderName, count + 1);
				
				currentPath = grandParentPath;
			}
		}

		// Pass 1.5: Compact folders if viewMode is 'compact'
		if (this.viewMode === 'compact') {
			// Find folders that can be compacted (1 subfolder, 0 files)
			// We iterate until no more compactions can be made
			let compacted = true;
			while (compacted) {
				compacted = false;
				for (const [fPath, node] of structure.entries()) {
					if (fPath !== '.' && node.files.length === 0 && node.subfolders.size === 1) {
						// This folder fPath has exactly 1 subfolder and 0 files.
						// We can merge it with its child.
						const childFolderName = Array.from(node.subfolders.keys())[0];
						const childPath = path.join(fPath, childFolderName);
						const childNode = structure.get(childPath);

						if (childNode) {
							// Find the parent of fPath to update its reference
							const parentDir = path.dirname(fPath);
							const parentNode = structure.get(parentDir);
							const currentFolderName = path.basename(fPath);

							if (parentNode) {
								// The new compacted name will be currentFolderName + '/' + childFolderName
								const newFolderName = currentFolderName + path.sep + childFolderName;
								
								// Remove old reference
								parentNode.subfolders.delete(currentFolderName);
								
								// Add new reference
								const childCount = node.subfolders.get(childFolderName) || 0;
								parentNode.subfolders.set(newFolderName, childCount);

								// Update child node's own path to be mapped correctly in the final output
								// We actually map it to the childPath, but the name in the tree will be newFolderName.
								// To make getChildren work properly, we need to restructure the maps.
								
								// Wait, since `fPath` is removed and parent points to `newFolderName` which corresponds to `childPath`,
								// We just need to remove `fPath` from structure.
								structure.delete(fPath);
								compacted = true;
								break; // break to restart iteration safely
							}
						}
					}
				}
			}
		}

		// Pass 2: Convert structure to FocusorItem nodes
		for (const [fPath, node] of structure.entries()) {
			const nodes: FocusorItem[] = [];

			// Add folder nodes (sorted alphabetically)
			const sortedFolders = Array.from(node.subfolders.entries()).sort((a, b) => a[0].localeCompare(b[0]));
			for (const [folderName, count] of sortedFolders) {
				const fullFolderPath = fPath === '.' ? folderName : path.join(fPath, folderName);
				const item = new FocusorItem(
					FocusorItemType.Folder,
					folderName,
					vscode.TreeItemCollapsibleState.Collapsed,
					repoPath,
					undefined,
					undefined,
					fullFolderPath,
					staged,
				);
				item.description = `${count} change${count !== 1 ? 's' : ''}`;
				nodes.push(item);
			}

			// Add file nodes (sorted alphabetically)
			node.files.sort((a, b) => path.basename(a.filePath).localeCompare(path.basename(b.filePath)));
			for (const { change, relativePath, filePath } of node.files) {
				const fName = path.basename(filePath);
				const item = new FocusorItem(
					FocusorItemType.File,
					fName,
					vscode.TreeItemCollapsibleState.None,
					repoPath,
					filePath,
					change.status,
					undefined,
					staged,
				);

				const display = getStatusDisplay(change.status);
				const tooltip = new vscode.MarkdownString();
				tooltip.appendMarkdown(`**${fName}** • ${display.tooltip}\n\n`);
				tooltip.appendMarkdown(`Path: \`${relativePath}\``);
				item.tooltip = tooltip;
				this.decorationProvider.setDecoration(change.uri, change.status);
				nodes.push(item);
			}

			repoCache.set(fPath, nodes);
		}
	}

	// === Stage / Unstage operations ===

	/**
	 * Stage a single file or folder.
	 */
	async stageFile(item: FocusorItem): Promise<void> {
		if (!item.repoPath) { return; }
		const repo = this.findRepo(item.repoPath);
		if (!repo) { return; }

		if (item.itemType === FocusorItemType.File && item.filePath) {
			await repo.add([item.filePath]);
		} else if (item.itemType === FocusorItemType.Folder && item.folderPath) {
			const paths = this.getChangesInFolder(item.repoPath, item.folderPath, false);
			if (paths.length > 0) {
				await repo.add(paths);
			}
		}
	}

	/**
	 * Discard changes in a single file or folder.
	 */
	async discardFile(item: FocusorItem): Promise<void> {
		if (!item.repoPath) { return; }
		const repo = this.findRepo(item.repoPath);
		if (!repo) { return; }

		let paths: string[] = [];
		let label = '';

		if (item.itemType === FocusorItemType.File && item.filePath) {
			paths = [item.filePath];
			label = path.basename(item.filePath);
		} else if (item.itemType === FocusorItemType.Folder && item.folderPath) {
			paths = this.getChangesInFolder(item.repoPath, item.folderPath, false);
			label = item.label as string || item.folderPath;
		}

		if (paths.length === 0) { return; }

		const confirm = await vscode.window.showWarningMessage(
			`Are you sure you want to discard changes in ${label}?`,
			{ modal: true },
			'Discard Changes'
		);

		if (confirm === 'Discard Changes') {
			await repo.clean(paths);
		}
	}

	/**
	 * Unstage a single file or folder.
	 */
	async unstageFile(item: FocusorItem): Promise<void> {
		if (!item.repoPath) { return; }
		const repo = this.findRepo(item.repoPath);
		if (!repo) { return; }

		if (item.itemType === FocusorItemType.File && item.filePath) {
			await repo.revert([item.filePath]);
		} else if (item.itemType === FocusorItemType.Folder && item.folderPath) {
			const paths = this.getChangesInFolder(item.repoPath, item.folderPath, true);
			if (paths.length > 0) {
				await repo.revert(paths);
			}
		}
	}

	/**
	 * Stage all unstaged files in a repo.
	 */
	async stageAll(item: FocusorItem): Promise<void> {
		if (!item.repoPath) { return; }
		const repo = this.findRepo(item.repoPath);
		if (!repo) { return; }

		const changes = this.gitService.getUnstagedChanges(repo);
		const paths = changes.map((c) => c.uri.fsPath);
		if (paths.length > 0) {
			await repo.add(paths);
		}
	}

	/**
	 * Discard all unstaged changes in a repo.
	 */
	async discardAll(item: FocusorItem): Promise<void> {
		if (!item.repoPath) { return; }
		const repo = this.findRepo(item.repoPath);
		if (!repo) { return; }

		const changes = this.gitService.getUnstagedChanges(repo);
		const paths = changes.map((c) => c.uri.fsPath);
		if (paths.length === 0) { return; }

		const repoName = path.basename(item.repoPath);
		const confirm = await vscode.window.showWarningMessage(
			`Are you sure you want to discard ALL unstaged changes in ${repoName}? This cannot be undone.`,
			{ modal: true },
			'Discard All Changes'
		);

		if (confirm === 'Discard All Changes') {
			await repo.clean(paths);
		}
	}

	/**
	 * Unstage all staged files in a repo.
	 */
	async unstageAll(item: FocusorItem): Promise<void> {
		if (!item.repoPath) { return; }
		const repo = this.findRepo(item.repoPath);
		if (!repo) { return; }

		const changes = this.gitService.getStagedChanges(repo);
		const paths = changes.map((c) => c.uri.fsPath);
		if (paths.length > 0) {
			await repo.revert(paths);
		}
	}

	/**
	 * Find a Repository by rootPath.
	 */
	private findRepo(repoPath: string): Repository | undefined {
		return this.gitService.getAllRepositories().find((r) => r.rootUri.fsPath === repoPath);
	}

	/**
	 * Get all changes (staged or unstaged) that belong to a specific folder in a repo.
	 */
	private getChangesInFolder(repoPath: string, folderPath: string, isStaged: boolean | undefined): string[] {
		const repo = this.findRepo(repoPath);
		if (!repo) { return []; }

		const changes = isStaged === undefined
			? this.gitService.getAllChanges(repo)
			: (isStaged ? this.gitService.getStagedChanges(repo) : this.gitService.getUnstagedChanges(repo));

		return changes
			.filter(c => {
				const relativePath = path.relative(repoPath, c.uri.fsPath);
				return relativePath === folderPath || relativePath.startsWith(folderPath + path.sep);
			})
			.map(c => c.uri.fsPath);
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

	/**
	 * Highlights the file in the Focusor changes tree view.
	 */
	async revealFile(fsPath: string, ...treeViews: vscode.TreeView<FocusorItem>[]): Promise<void> {
		const visibleTreeViews = treeViews.filter(tv => tv.visible);
		if (visibleTreeViews.length === 0) return;

		const repos = this.gitService.getAllRepositories();
		const repo = repos.find(r => fsPath.startsWith(r.rootUri.fsPath));
		if (!repo) return;

		// Determine if the file is staged or unstaged
		let isStaged: boolean | undefined = undefined;
		const stagedChanges = this.gitService.getStagedChanges(repo);
		if (stagedChanges.some(c => c.uri.fsPath === fsPath)) {
			isStaged = true;
		} else {
			const unstagedChanges = this.gitService.getUnstagedChanges(repo);
			if (unstagedChanges.some(c => c.uri.fsPath === fsPath)) {
				isStaged = false;
			}
		}

		if (isStaged === undefined) {
			// Not a changed file tracked by focusor
			return;
		}

		// Check if we are splitting by staged/unstaged
		const config = vscode.workspace.getConfiguration('focusor');
		const splitStaged = config.get<boolean>('changes.splitStaged', true);
		if (!splitStaged) {
			isStaged = undefined;
		}

		// Create a mock FocusorItem that contains enough info for getParent to resolve it
		const item = new FocusorItem(
			FocusorItemType.File,
			path.basename(fsPath),
			vscode.TreeItemCollapsibleState.None,
			repo.rootUri.fsPath,
			fsPath,
			undefined,
			undefined,
			isStaged
		);

		for (const treeView of visibleTreeViews) {
			try {
				await treeView.reveal(item, { select: true, focus: false, expand: true });
			} catch (e) {
				// Ignore if item can't be revealed
			}
		}
	}
}
