import * as vscode from 'vscode';
import { GitService } from './gitService';
import { FocusorProvider } from './focusorProvider';
import { FocusorDecorationProvider } from './decorationProvider';
import { FocusorItem, FocusorItemType } from './models';
import { GitExtension } from './git';
import { RecentProvider } from './recentProvider';

export function activate(context: vscode.ExtensionContext) {
	console.log('Focusor: Activating...');

	// Initialize services
	const gitService = new GitService();
	const decorationProvider = new FocusorDecorationProvider();
	const focusorProvider = new FocusorProvider(gitService, decorationProvider, context);

	// Track expand/collapse state via context key
	let isExpanded = true;
	vscode.commands.executeCommand('setContext', 'focusor.isExpanded', isExpanded);

	const treeView = vscode.window.createTreeView('focusor-changes', {
		treeDataProvider: focusorProvider,
	});

	const gitOnlyTreeView = vscode.window.createTreeView('focusor-changes-git-only', {
		treeDataProvider: focusorProvider,
	});

	// Initialize Recents Provider
	const recentProvider = new RecentProvider(context, gitService, decorationProvider);
	
	const recentTreeView = vscode.window.createTreeView('focusor-recents', {
		treeDataProvider: recentProvider,
	});
	
	const recentSeparateTreeView = vscode.window.createTreeView('focusor-recents-separate', {
		treeDataProvider: recentProvider,
	});

	// Give the provider a reference to the tree view for expand all
	focusorProvider.setTreeView(treeView);

	// Auto-refresh when the Focusor panel becomes visible, if enabled in settings
	context.subscriptions.push(
		treeView.onDidChangeVisibility((e) => {
			if (e.visible) {
				const config = vscode.workspace.getConfiguration('focusor');
				if (config.get<boolean>('autoRefreshOnVisible', true)) {
					focusorProvider.refresh();
				}
			}
		}),
	);

	// Listen for configuration changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('focusor')) {
				focusorProvider.refresh();
			}
		}),
	);

	// Register decoration provider
	context.subscriptions.push(
		vscode.window.registerFileDecorationProvider(decorationProvider),
	);

	// === Commands ===

	// Refresh
	context.subscriptions.push(
		vscode.commands.registerCommand('focusor.refresh', () => {
			focusorProvider.refresh();
		}),
	);

	// Expand All — expand all repo nodes, then flip icon to collapse
	context.subscriptions.push(
		vscode.commands.registerCommand('focusor.expandAll', async () => {
			await focusorProvider.expandAll();
			isExpanded = true;
			vscode.commands.executeCommand('setContext', 'focusor.isExpanded', true);
		}),
	);

	// Collapse All — collapse all repo nodes, then flip icon to expand
	context.subscriptions.push(
		vscode.commands.registerCommand('focusor.collapseAll', async () => {
			await vscode.commands.executeCommand('workbench.actions.treeView.focusor-changes.collapseAll');
			isExpanded = false;
			vscode.commands.executeCommand('setContext', 'focusor.isExpanded', false);
		}),
	);

	// Toggle View Mode (List / Tree)
	context.subscriptions.push(
		vscode.commands.registerCommand('focusor.toggleViewMode', () => {
			focusorProvider.toggleViewMode();
		}),
	);

	// Filter Repos
	context.subscriptions.push(
		vscode.commands.registerCommand('focusor.filterRepos', () => {
			focusorProvider.filterRepos();
		}),
	);

	// Open File — force open in a regular editor (not diff)
	context.subscriptions.push(
		vscode.commands.registerCommand('focusor.openFile', (item: FocusorItem) => {
			if (item.filePath) {
				const uri = vscode.Uri.file(item.filePath);
				// Use showTextDocument to ensure it opens as a regular file editor,
				// even when a diff view of this file is already active.
				vscode.window.showTextDocument(uri, { preview: false });
			}
		}),
	);

	// Open Diff
	context.subscriptions.push(
		vscode.commands.registerCommand('focusor.openDiff', (item: FocusorItem) => {
			if (item.filePath && item.repoPath) {
				const uri = vscode.Uri.file(item.filePath);

				// Try to get the Git extension to create a proper git diff URI
				const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
				if (gitExtension?.isActive) {
					const api = gitExtension.exports.getAPI(1);
					const repo = api.getRepository(uri);
					if (repo) {
						const headUri = api.toGitUri(uri, 'HEAD');
						const fileName = uri.path.split('/').pop() ?? 'file';
						vscode.commands.executeCommand('vscode.diff', headUri, uri, `${fileName} (Working Tree)`);
						return;
					}
				}

				// Fallback: just open the file
				vscode.commands.executeCommand('vscode.open', uri);
			}
		}),
	);

	// Open in Source Control — works for both repo and file items
	context.subscriptions.push(
		vscode.commands.registerCommand('focusor.openInSCM', async (item: FocusorItem) => {
			if (!item.repoPath) { return; }

			// Switch to the Source Control view
			await vscode.commands.executeCommand('workbench.view.scm');

			// Open a diff in the SCM context to focus on the repo
			const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
			if (gitExtension?.isActive) {
				const api = gitExtension.exports.getAPI(1);
				const repo = api.getRepository(vscode.Uri.file(item.repoPath));
				if (repo) {
					// If it's a file item, open diff for that specific file
					// If it's a repo item, open diff for the first changed file
					let fileUri: vscode.Uri | undefined;

					if (item.itemType === FocusorItemType.File && item.filePath) {
						fileUri = vscode.Uri.file(item.filePath);
					} else {
						const changes = [
							...repo.state.workingTreeChanges,
							...repo.state.indexChanges,
						];
						if (changes.length > 0) {
							fileUri = changes[0].uri;
						}
					}

					if (fileUri) {
						const headUri = api.toGitUri(fileUri, 'HEAD');
						const fileName = fileUri.path.split('/').pop() ?? 'file';
						await vscode.commands.executeCommand('vscode.diff', headUri, fileUri, `${fileName} (Working Tree)`);
					}
				}
			}
		}),
	);

	// Stage File
	context.subscriptions.push(
		vscode.commands.registerCommand('focusor.stageFile', (item: FocusorItem) => {
			focusorProvider.stageFile(item);
		}),
	);

	// Unstage File
	context.subscriptions.push(
		vscode.commands.registerCommand('focusor.unstageFile', (item: FocusorItem) => {
			focusorProvider.unstageFile(item);
		}),
	);

	// Stage All
	context.subscriptions.push(
		vscode.commands.registerCommand('focusor.stageAll', (item: FocusorItem) => {
			focusorProvider.stageAll(item);
		}),
	);

	// Unstage All
	context.subscriptions.push(
		vscode.commands.registerCommand('focusor.unstageAll', (item: FocusorItem) => {
			focusorProvider.unstageAll(item);
		}),
	);

	// Recents: Pin
	context.subscriptions.push(
		vscode.commands.registerCommand('focusor.recents.pin', (item: vscode.TreeItem) => {
			recentProvider.pinFile(item);
		}),
	);

	// Recents: Unpin
	context.subscriptions.push(
		vscode.commands.registerCommand('focusor.recents.unpin', (item: vscode.TreeItem) => {
			recentProvider.unpinFile(item);
		}),
	);

	// Recents: Clear All
	context.subscriptions.push(
		vscode.commands.registerCommand('focusor.recents.clear', () => {
			recentProvider.clearAll();
		}),
	);

	// Highlight current file in trees on editor change
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(editor => {
			if (editor && editor.document.uri.scheme === 'file') {
				const fsPath = editor.document.uri.fsPath;
				focusorProvider.revealFile(fsPath, treeView, gitOnlyTreeView);
				recentProvider.revealFile(fsPath, recentTreeView, recentSeparateTreeView);
			}
		})
	);

	// Highlight current file when tree view becomes visible
	const revealActiveEditor = (tv: vscode.TreeView<any>, provider: any) => {
		return tv.onDidChangeVisibility(e => {
			if (e.visible) {
				const editor = vscode.window.activeTextEditor;
				if (editor && editor.document.uri.scheme === 'file') {
					provider.revealFile(editor.document.uri.fsPath, tv);
				}
			}
		});
	};

	context.subscriptions.push(
		revealActiveEditor(treeView, focusorProvider),
		revealActiveEditor(gitOnlyTreeView, focusorProvider),
		revealActiveEditor(recentTreeView, recentProvider),
		revealActiveEditor(recentSeparateTreeView, recentProvider)
	);

	// Add disposables
	context.subscriptions.push(treeView);
	context.subscriptions.push(gitOnlyTreeView);
	context.subscriptions.push(recentTreeView);
	context.subscriptions.push(recentSeparateTreeView);
	context.subscriptions.push(gitService);
	context.subscriptions.push(decorationProvider);
	context.subscriptions.push(focusorProvider);

	console.log('Focusor: Activated successfully');
}

export function deactivate() {
	console.log('Focusor: Deactivated');
}
