/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Subset of the VS Code Git extension API types used by Focusor.
// Source: https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts

import { Uri, Event, Disposable, ProviderResult, Command } from 'vscode';

export interface InputBox {
	value: string;
}

export const enum RefType {
	Head,
	RemoteHead,
	Tag,
}

export interface Ref {
	readonly type: RefType;
	readonly name?: string;
	readonly commit?: string;
	readonly remote?: string;
}

export interface UpstreamRef {
	readonly remote: string;
	readonly name: string;
	readonly commit?: string;
}

export interface Branch extends Ref {
	readonly upstream?: UpstreamRef;
	readonly ahead?: number;
	readonly behind?: number;
}

export interface Commit {
	readonly hash: string;
	readonly message: string;
	readonly parents: string[];
	readonly authorDate?: Date;
	readonly authorName?: string;
	readonly authorEmail?: string;
	readonly commitDate?: Date;
}

export interface Submodule {
	readonly name: string;
	readonly path: string;
	readonly url: string;
}

export interface Remote {
	readonly name: string;
	readonly fetchUrl?: string;
	readonly pushUrl?: string;
	readonly isReadOnly: boolean;
}

export const enum Status {
	INDEX_MODIFIED,
	INDEX_ADDED,
	INDEX_DELETED,
	INDEX_RENAMED,
	INDEX_COPIED,

	MODIFIED,
	DELETED,
	UNTRACKED,
	IGNORED,
	INTENT_TO_ADD,
	INTENT_TO_RENAME,
	TYPE_CHANGED,

	ADDED_BY_US,
	ADDED_BY_THEM,
	DELETED_BY_US,
	DELETED_BY_THEM,
	BOTH_ADDED,
	BOTH_DELETED,
	BOTH_MODIFIED,
}

export interface Change {
	readonly uri: Uri;
	readonly originalUri: Uri;
	readonly renameUri: Uri | undefined;
	readonly status: Status;
}

export interface RepositoryState {
	readonly HEAD: Branch | undefined;
	readonly refs: Ref[];
	readonly remotes: Remote[];
	readonly submodules: Submodule[];
	readonly rebaseCommit: Commit | undefined;

	readonly mergeChanges: Change[];
	readonly indexChanges: Change[];
	readonly workingTreeChanges: Change[];
	readonly untrackedChanges: Change[];

	readonly onDidChange: Event<void>;
}

export interface RepositoryUIState {
	readonly selected: boolean;
	readonly onDidChange: Event<void>;
}

export type APIState = 'uninitialized' | 'initialized';

export interface Repository {
	readonly rootUri: Uri;
	readonly inputBox: InputBox;
	readonly state: RepositoryState;
	readonly ui: RepositoryUIState;

	getConfigs(): Promise<{ key: string; value: string }[]>;
	getConfig(key: string): Promise<string>;
	setConfig(key: string, value: string): Promise<string>;

	show(ref: string, path: string): Promise<string>;
	getCommit(ref: string): Promise<Commit>;

	add(paths: string[]): Promise<void>;
	revert(paths: string[]): Promise<void>;
	clean(paths: string[]): Promise<void>;

	diff(cached?: boolean): Promise<string>;
	diffWithHEAD(): Promise<Change[]>;
	diffWithHEAD(path: string): Promise<string>;

	status(): Promise<void>;
	checkout(treeish: string): Promise<void>;

	log(options?: { maxEntries?: number; path?: string }): Promise<Commit[]>;
	commit(message: string, opts?: { all?: boolean | 'tracked' }): Promise<void>;
}

export interface API {
	readonly state: APIState;
	readonly onDidChangeState: Event<APIState>;
	readonly repositories: Repository[];
	readonly onDidOpenRepository: Event<Repository>;
	readonly onDidCloseRepository: Event<Repository>;

	toGitUri(uri: Uri, ref: string): Uri;
	getRepository(uri: Uri): Repository | null;
}

export interface GitExtension {
	readonly enabled: boolean;
	readonly onDidChangeEnablement: Event<boolean>;
	getAPI(version: 1): API;
}
