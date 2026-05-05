import * as vscode from 'vscode';
import * as path from 'path';
import { API, GitExtension, Repository, Change } from './git';
import { RepoInfo } from './models';

/**
 * Service layer wrapping the VS Code Git extension API.
 * Provides change detection and repository listing.
 */
export class GitService {
	private api: API | undefined;
	private disposables: vscode.Disposable[] = [];

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	constructor() {
		this.initGitApi();
	}

	/**
	 * Initialize Git API from the built-in git extension.
	 */
	private initGitApi(): void {
		const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
		if (!gitExtension) {
			console.warn('Focusor: Git extension not found');
			return;
		}

		if (!gitExtension.isActive) {
			gitExtension.activate().then(() => {
				this.setupApi(gitExtension);
			});
		} else {
			this.setupApi(gitExtension);
		}
	}

	private setupApi(gitExtension: vscode.Extension<GitExtension>): void {
		const gitExt = gitExtension.exports;
		if (!gitExt.enabled) {
			// Wait for enablement
			const listener = gitExt.onDidChangeEnablement((enabled) => {
				if (enabled) {
					this.api = gitExt.getAPI(1);
					this.subscribeToRepos();
					listener.dispose();
				}
			});
			this.disposables.push(listener);
			return;
		}

		this.api = gitExt.getAPI(1);

		if (this.api.state === 'initialized') {
			this.subscribeToRepos();
		} else {
			const stateListener = this.api.onDidChangeState((state) => {
				if (state === 'initialized') {
					this.subscribeToRepos();
					stateListener.dispose();
				}
			});
			this.disposables.push(stateListener);
		}
	}

	/**
	 * Subscribe to repo open/close and state change events.
	 */
	private subscribeToRepos(): void {
		if (!this.api) { return; }

		// Listen for new repos opening
		this.disposables.push(
			this.api.onDidOpenRepository((repo) => {
				this.watchRepo(repo);
				this._onDidChange.fire();
			})
		);

		// Listen for repos closing
		this.disposables.push(
			this.api.onDidCloseRepository(() => {
				this._onDidChange.fire();
			})
		);

		// Watch existing repos
		for (const repo of this.api.repositories) {
			this.watchRepo(repo);
		}

		// Initial fire
		this._onDidChange.fire();
	}

	/**
	 * Watch a single repo for state changes.
	 */
	private watchRepo(repo: Repository): void {
		this.disposables.push(
			repo.state.onDidChange(() => {
				this._onDidChange.fire();
			})
		);
	}

	/**
	 * Get all repositories tracked by the Git extension.
	 */
	getAllRepositories(): Repository[] {
		return this.api?.repositories ?? [];
	}

	/**
	 * Get repos that have at least one change (working tree, index, merge, or untracked).
	 */
	getChangedRepositories(): Repository[] {
		return this.getAllRepositories().filter((repo) => this.getChangeCount(repo) > 0);
	}

	/**
	 * Get all changes for a repository (working tree + index + merge + untracked).
	 */
	getAllChanges(repo: Repository): Change[] {
		return [
			...repo.state.indexChanges,
			...repo.state.workingTreeChanges,
			...repo.state.mergeChanges,
			...repo.state.untrackedChanges,
		];
	}

	/**
	 * Total change count for a repo.
	 */
	getChangeCount(repo: Repository): number {
		return (
			repo.state.workingTreeChanges.length +
			repo.state.indexChanges.length +
			repo.state.mergeChanges.length +
			repo.state.untrackedChanges.length
		);
	}

	/**
	 * Build RepoInfo for a repository.
	 */
	getRepoInfo(repo: Repository): RepoInfo {
		const rootPath = repo.rootUri.fsPath;
		return {
			rootPath,
			name: path.basename(rootPath),
			branch: repo.state.HEAD?.name ?? 'HEAD',
			changesCount: this.getChangeCount(repo),
		};
	}

	dispose(): void {
		this.disposables.forEach((d) => d.dispose());
		this._onDidChange.dispose();
	}
}
