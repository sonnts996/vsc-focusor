import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './gitService';
import { FocusorDecorationProvider } from './decorationProvider';
import { getFocusorResourceUri, isDeletedStatus, renderStrikethroughLabel } from './models';
import { GitExtension } from './git';

export class RecentGroupItem extends vscode.TreeItem {
	constructor(label: string, public readonly isPinnedGroup: boolean) {
		super(label, vscode.TreeItemCollapsibleState.Expanded);
		this.contextValue = 'recentGroup';
		this.id = `recentGroup-${isPinnedGroup ? 'pinned' : 'unpinned'}`;
	}
}

export class RecentRepoGroupItem extends vscode.TreeItem {
	constructor(public readonly repoPath: string, public readonly repoName: string, public readonly isPinnedGroup: boolean) {
		super(repoName, vscode.TreeItemCollapsibleState.Expanded);
		this.contextValue = 'recentRepoGroup';
		this.id = `recentRepo-${repoPath}-${isPinnedGroup ? 'pinned' : 'unpinned'}`;
		this.iconPath = new vscode.ThemeIcon('repo', new vscode.ThemeColor('focusor.repoIconForeground'));
	}
}

export interface RecentFile {
	fsPath: string;
	pinned: boolean;
	timestamp: number;
}

export class RecentProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private recentFiles: RecentFile[] = [];
	private maxFiles: number = 50;
	private groupByRepo: boolean = false;
	private saveStateTimer: NodeJS.Timeout | undefined;

	constructor(
		private context: vscode.ExtensionContext,
		private gitService: GitService,
		private decorationProvider: FocusorDecorationProvider
	) {
		this.loadState();
		this.updateConfig();

		// Listen to config changes
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('focusor.recents')) {
					this.updateConfig();
				}
			})
		);

		// Listen to active editor changes
		context.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor(editor => {
				if (editor && editor.document.uri.scheme === 'file') {
					this.addFile(editor.document.uri.fsPath);
				}
			})
		);

		// Listen to git state changes to update file statuses
		context.subscriptions.push(
			this.gitService.onDidChange(() => this.refresh())
		);

		context.subscriptions.push(
			vscode.commands.registerCommand('focusor.recents.openDeleted', async (fsPath: string, originalUri: vscode.Uri) => {
				const openUri = await this.resolveDeletedOpenUri(fsPath, originalUri);
				// Open deleted recents through Git content when needed. / Mở recent đã xóa qua nội dung Git khi cần.
				await vscode.window.showTextDocument(openUri, { preview: false });
			})
		);
	}

	private updateConfig() {
		const config = vscode.workspace.getConfiguration('focusor.recents');
		this.maxFiles = config.get<number>('maxFiles', 50);
		this.groupByRepo = config.get<boolean>('groupByRepo', false);
		this.pruneList();
		this.refresh();
	}

	private loadState() {
		this.recentFiles = this.context.workspaceState.get<RecentFile[]>('focusor.recentFiles', []);
	}

	private saveState() {
		if (this.saveStateTimer) {
			clearTimeout(this.saveStateTimer);
		}
		
		// Update the UI immediately so it feels snappy
		this.refresh();

		// Debounce the actual disk I/O to avoid performance hits when switching tabs rapidly
		this.saveStateTimer = setTimeout(async () => {
			await this.context.workspaceState.update('focusor.recentFiles', this.recentFiles);
		}, 500);
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getParent(element: vscode.TreeItem): vscode.TreeItem | undefined {
		if (element instanceof RecentGroupItem) {
			return undefined;
		}

		if (element instanceof RecentRepoGroupItem) {
			return new RecentGroupItem(element.isPinnedGroup ? 'Pinned' : 'Recents', element.isPinnedGroup);
		}

		const fsPath = element.id?.replace('recent-', '');
		if (!fsPath) return undefined;

		const file = this.recentFiles.find(f => f.fsPath === fsPath);
		if (!file) return undefined;

		if (this.groupByRepo) {
			const { key, name } = this.getRepoKeyForFile(fsPath);
			return new RecentRepoGroupItem(key, name, file.pinned);
		}

		return new RecentGroupItem(file.pinned ? 'Pinned' : 'Recents', file.pinned);
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	private getRepoKeyForFile(fsPath: string): { key: string, name: string } {
		const repo = this.gitService.getAllRepositories().find(r => fsPath.startsWith(r.rootUri.fsPath));
		if (repo) return { key: repo.rootUri.fsPath, name: path.basename(repo.rootUri.fsPath) };
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
		if (workspaceFolder) return { key: workspaceFolder.uri.fsPath, name: workspaceFolder.name };
		return { key: 'unknown', name: 'Unknown' };
	}

	/**
	 * Resolve a readable URI for deleted recent files, matching the Changes view behavior.
	 * Resolve URI có thể đọc cho recent file đã xóa, đồng bộ với Changes view.
	 */
	private async resolveDeletedOpenUri(fsPath: string, originalUri: vscode.Uri): Promise<vscode.Uri> {
		if (originalUri.scheme !== 'file') {
			return originalUri;
		}

		const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
		if (!gitExtension) {
			return originalUri;
		}

		const gitApi = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
		return gitApi.getAPI(1).toGitUri(vscode.Uri.file(fsPath), 'HEAD');
	}

	private createFileItem(file: RecentFile): vscode.TreeItem {
		const fileName = path.basename(file.fsPath);
		const item = new vscode.TreeItem(fileName, vscode.TreeItemCollapsibleState.None);
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file.fsPath));
		const relativePath = workspaceFolder ? path.relative(workspaceFolder.uri.fsPath, file.fsPath) : file.fsPath;

		const uri = vscode.Uri.file(file.fsPath);
		let resourceUri = uri;
		let openUri = uri;
		let command = 'vscode.open';
		let commandArguments: unknown[] = [openUri];
		const repo = this.gitService.getAllRepositories().find(r => file.fsPath.startsWith(r.rootUri.fsPath));
		
		if (repo) {
			const changes = this.gitService.getAllChanges(repo);
			const change = changes.find(c => c.uri.fsPath === file.fsPath);
			if (change) {
				this.decorationProvider.setDecoration(uri, change.status);
				resourceUri = getFocusorResourceUri(file.fsPath, change.status);
				this.decorationProvider.setDecoration(resourceUri, change.status);
				// Mirror deleted styling from Changes view in Recents. / Đồng bộ style file đã xóa từ Changes sang Recents.
				if (isDeletedStatus(change.status)) {
					item.label = renderStrikethroughLabel(fileName);
					openUri = change.originalUri;
					// Open deleted recents as a tracked snapshot like Source Control. / Mở recent đã xóa như snapshot đã track giống Source Control.
					command = 'focusor.recents.openDeleted';
					commandArguments = [file.fsPath, openUri];
				}
			}
		}

		const dirPath = path.dirname(relativePath) !== '.' ? path.dirname(relativePath) : '';
		const repoName = repo ? path.basename(repo.rootUri.fsPath) : (workspaceFolder ? workspaceFolder.name : '');
		
		item.description = dirPath;
		
		const tooltip = new vscode.MarkdownString();
		if (repoName) {
			tooltip.appendMarkdown(`**${fileName}**\n\n`);
			tooltip.appendMarkdown(`Repository: \`${repoName}\`\n\n`);
			tooltip.appendMarkdown(`Path: \`${relativePath}\``);
		} else {
			tooltip.appendMarkdown(`**${fileName}**\n\n`);
			tooltip.appendMarkdown(`Path: \`${relativePath}\``);
		}
		item.tooltip = tooltip;

		item.resourceUri = resourceUri;
		item.iconPath = vscode.ThemeIcon.File;
		item.contextValue = file.pinned ? 'recentFilePinned' : 'recentFileUnpinned';
		
		// Click to open
		item.command = {
			command,
			title: 'Open File',
			arguments: commandArguments
		};

		// Store the fsPath in id so we can use it in commands
		item.id = `recent-${file.fsPath}`;
		return item;
	}

	getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
		if (!element) {
			const nodes: vscode.TreeItem[] = [];
			const pinned = this.recentFiles.filter(f => f.pinned);
			const unpinned = this.recentFiles.filter(f => !f.pinned);

			if (pinned.length > 0) {
				const group = new RecentGroupItem('Pinned', true);
				group.description = `${pinned.length}`;
				nodes.push(group);
			}
			if (unpinned.length > 0) {
				const group = new RecentGroupItem('Recents', false);
				group.description = `${unpinned.length}`;
				nodes.push(group);
			}
			return nodes;
		}

		if (element instanceof RecentGroupItem) {
			let files = element.isPinnedGroup
				? this.recentFiles.filter(f => f.pinned)
				: this.recentFiles.filter(f => !f.pinned);
			
			// Sort by timestamp descending
			files.sort((a, b) => b.timestamp - a.timestamp);

			if (!this.groupByRepo) {
				return files.map(file => this.createFileItem(file));
			}

			// Group by repo
			const repoGroups = new Map<string, { name: string, files: RecentFile[] }>();
			for (const file of files) {
				const { key, name } = this.getRepoKeyForFile(file.fsPath);
				if (!repoGroups.has(key)) {
					repoGroups.set(key, { name, files: [] });
				}
				repoGroups.get(key)!.files.push(file);
			}

			const groupNodes: vscode.TreeItem[] = [];
			for (const [key, { name, files: repoFiles }] of repoGroups.entries()) {
				const group = new RecentRepoGroupItem(key, name, element.isPinnedGroup);
				group.description = `${repoFiles.length}`;
				groupNodes.push(group);
			}

			// Sort repo groups alphabetically
			groupNodes.sort((a, b) => (a.label as string).localeCompare(b.label as string));
			return groupNodes;
		}

		if (element instanceof RecentRepoGroupItem) {
			const files = element.isPinnedGroup
				? this.recentFiles.filter(f => f.pinned)
				: this.recentFiles.filter(f => !f.pinned);
			
			const repoFiles = files.filter(f => this.getRepoKeyForFile(f.fsPath).key === element.repoPath);
			repoFiles.sort((a, b) => b.timestamp - a.timestamp);

			return repoFiles.map(file => this.createFileItem(file));
		}

		return [];
	}

	addFile(fsPath: string) {
		const existingIndex = this.recentFiles.findIndex(f => f.fsPath === fsPath);
		if (existingIndex !== -1) {
			// Update timestamp, keep pinned status
			this.recentFiles[existingIndex].timestamp = Date.now();
		} else {
			// Add new file
			this.recentFiles.push({
				fsPath,
				pinned: false,
				timestamp: Date.now()
			});
		}
		this.pruneList();
		this.saveState();
	}

	private pruneList() {
		if (this.recentFiles.length <= this.maxFiles) {
			return;
		}
		
		// Separate pinned and unpinned
		const pinned = this.recentFiles.filter(f => f.pinned);
		const unpinned = this.recentFiles.filter(f => !f.pinned);

		// Sort unpinned by timestamp desc
		unpinned.sort((a, b) => b.timestamp - a.timestamp);

		// If pinned alone exceed maxFiles, we keep all pinned anyway, but truncate unpinned
		const allowedUnpinned = Math.max(0, this.maxFiles - pinned.length);
		const keptUnpinned = unpinned.slice(0, allowedUnpinned);

		this.recentFiles = [...pinned, ...keptUnpinned];
	}

	async pinFile(item: vscode.TreeItem) {
		const fsPath = item.id?.replace('recent-', '');
		if (!fsPath) return;

		const file = this.recentFiles.find(f => f.fsPath === fsPath);
		if (file) {
			file.pinned = true;
			await this.saveState();
		}
	}

	async unpinFile(item: vscode.TreeItem) {
		const fsPath = item.id?.replace('recent-', '');
		if (!fsPath) return;

		const file = this.recentFiles.find(f => f.fsPath === fsPath);
		if (file) {
			file.pinned = false;
			await this.saveState();
		}
	}

	async clearAll() {
		// Only clear unpinned files
		this.recentFiles = this.recentFiles.filter(f => f.pinned);
		await this.saveState();
	}

	async revealFile(fsPath: string, ...treeViews: vscode.TreeView<vscode.TreeItem>[]) {
		const file = this.recentFiles.find(f => f.fsPath === fsPath);
		if (!file) return;

		// Create a mock item to reveal
		const item = new vscode.TreeItem(path.basename(fsPath));
		item.id = `recent-${fsPath}`;

		for (const treeView of treeViews) {
			if (treeView.visible) {
				try {
					await treeView.reveal(item, { select: true, focus: false, expand: true });
				} catch (e) {
					// Ignore reveal errors (e.g. tree view not ready or item filtered out)
				}
			}
		}
	}
}
