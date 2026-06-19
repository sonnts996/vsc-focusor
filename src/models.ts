import * as vscode from 'vscode';
import { Status } from './git';

export const FOCUSOR_DELETED_EMPTY_SCHEME = 'focusor-deleted-empty';

/**
 * Build a safe resource URI for tree items, avoiding missing file reads for deleted files.
 * Tạo resource URI an toàn cho tree item, tránh đọc file không tồn tại khi file đã xóa.
 */
export function getFocusorResourceUri(filePath: string, status: Status | undefined): vscode.Uri {
	const isDeleted = status !== undefined && isDeletedStatus(status);
	const resourceUri = isDeleted
		? vscode.Uri.from({ scheme: FOCUSOR_DELETED_EMPTY_SCHEME, path: filePath })
		: vscode.Uri.file(filePath);

	return resourceUri;
}

/**
 * Types of nodes in the Focusor tree view.
 */
export enum FocusorItemType {
	Repo = 'repo',
	File = 'file',
	Folder = 'folder',
	Separator = 'separator',
	StagedGroup = 'stagedGroup',
	UnstagedGroup = 'unstagedGroup',
}

/**
 * Status letter and theme color mapping for git change statuses.
 */
export interface StatusDisplay {
	letter: string;
	color: vscode.ThemeColor;
	tooltip: string;
}

/**
 * Map git Status enum to display info.
 */
export function getStatusDisplay(status: Status): StatusDisplay {
	// Since const enums are inlined at compile time, we compare by numeric value.
	// The enum values from git.d.ts:
	// INDEX_MODIFIED=0, INDEX_ADDED=1, INDEX_DELETED=2, INDEX_RENAMED=3, INDEX_COPIED=4,
	// MODIFIED=5, DELETED=6, UNTRACKED=7, IGNORED=8, INTENT_TO_ADD=9, INTENT_TO_RENAME=10, TYPE_CHANGED=11,
	// ADDED_BY_US=12, ADDED_BY_THEM=13, DELETED_BY_US=14, DELETED_BY_THEM=15, BOTH_ADDED=16, BOTH_DELETED=17, BOTH_MODIFIED=18

	const s = status as number;

	// Modified (index or working tree)
	if (s === 0 || s === 5) {
		return { letter: 'M', color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'), tooltip: 'Modified' };
	}
	// Added (index) or Untracked (working tree) or Intent to add
	if (s === 1 || s === 7 || s === 9) {
		return { letter: s === 7 ? 'U' : 'A', color: new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'), tooltip: s === 7 ? 'Untracked' : 'Added' };
	}
	// Deleted
	if (s === 2 || s === 6) {
		return { letter: 'D', color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'), tooltip: 'Deleted' };
	}
	// Renamed
	if (s === 3 || s === 10) {
		return { letter: 'R', color: new vscode.ThemeColor('gitDecoration.renamedResourceForeground'), tooltip: 'Renamed' };
	}
	// Copied
	if (s === 4) {
		return { letter: 'C', color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'), tooltip: 'Copied' };
	}
	// Type changed
	if (s === 11) {
		return { letter: 'T', color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'), tooltip: 'Type Changed' };
	}
	// Conflict statuses
	if (s >= 12 && s <= 18) {
		return { letter: '!', color: new vscode.ThemeColor('gitDecoration.conflictingResourceForeground'), tooltip: 'Conflict' };
	}

	return { letter: '?', color: new vscode.ThemeColor('foreground'), tooltip: 'Unknown' };
}

/**
 * Check whether a git status represents a deleted file.
 * Kiểm tra trạng thái git có phải file đã bị xóa hay không.
 */
export function isDeletedStatus(status: Status): boolean {
	const s = status as number;
	return s === 2 || s === 6;
}

/**
 * Check whether a git status represents a newly added or untracked file.
 * Kiểm tra trạng thái git có phải file mới thêm hoặc chưa track hay không.
 */
export function isNewStatus(status: Status): boolean {
	const s = status as number;
	return s === 1 || s === 7 || s === 9;
}

/**
 * Render text with a combining strikethrough for deleted tree labels.
 * Render chữ với dấu gạch ngang kết hợp cho label file đã xóa trong tree.
 */
export function renderStrikethroughLabel(label: string): string {
	return Array.from(label).map((char) => `${char}\u0336`).join('');
}

/**
 * Represents a node in the Focusor tree view — either a repo header or a changed file.
 */
export class FocusorItem extends vscode.TreeItem {
	constructor(
		public readonly itemType: FocusorItemType,
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly repoPath?: string,
		public readonly filePath?: string,
		public readonly fileStatus?: Status,
		public readonly folderPath?: string,
		public readonly isStaged?: boolean,
	) {
		super(label, collapsibleState);

		// Set contextValue for menu visibility (e.g. stagedFile vs unstagedFile)
		if (itemType === FocusorItemType.File) {
			if (isStaged === undefined) {
				this.contextValue = 'file';
			} else {
				this.contextValue = isStaged ? 'stagedFile' : 'unstagedFile';
			}
		} else if (itemType === FocusorItemType.Folder) {
			if (isStaged === undefined) {
				this.contextValue = 'folder';
			} else {
				this.contextValue = isStaged ? 'stagedFolder' : 'unstagedFolder';
			}
		} else {
			this.contextValue = itemType;
		}

		if (itemType === FocusorItemType.Repo) {
			this.iconPath = new vscode.ThemeIcon('repo', new vscode.ThemeColor('focusor.repoIconForeground'));
		} else if (itemType === FocusorItemType.Folder) {
			this.iconPath = vscode.ThemeIcon.Folder;
		} else if (itemType === FocusorItemType.File && filePath) {
			if (fileStatus !== undefined && isDeletedStatus(fileStatus)) {
				this.label = renderStrikethroughLabel(label);
			}
				this.resourceUri = getFocusorResourceUri(filePath, fileStatus);
			// Use ThemeIcon for file so VS Code resolves the file icon
			this.iconPath = vscode.ThemeIcon.File;

			// Click to open diff
			this.command = {
				command: 'focusor.openDiff',
				title: 'Open Changes',
				arguments: [this],
			};
		}

		// Generate unique ID for tree view selection mapping
		const idParts: string[] = [itemType as string];
		if (repoPath) idParts.push(repoPath);
		if (folderPath) idParts.push(folderPath);
		if (filePath) idParts.push(filePath);
		if (isStaged !== undefined) idParts.push(isStaged ? 'staged' : 'unstaged');
		this.id = idParts.join('::');
	}
}

/**
 * Represents info about a changed repository.
 */
export interface RepoInfo {
	rootPath: string;
	name: string;
	branch: string;
	changesCount: number;
}
