import * as vscode from 'vscode';
import { getStatusDisplay } from './models';
import { Status } from './git';

/**
 * Provides file decorations (status badges and colors) for items in the Focusor tree.
 * This mimics the built-in SCM view's file status display.
 */
export class FocusorDecorationProvider implements vscode.FileDecorationProvider {
	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
	readonly onDidChangeFileDecorations = this._onDidChange.event;

	/**
	 * Map of file URI string → Status for current decorations.
	 */
	private decorations = new Map<string, Status>();

	/**
	 * Update the status for a file URI.
	 */
	setDecoration(uri: vscode.Uri, status: Status): void {
		this.decorations.set(uri.toString(), status);
		this._onDidChange.fire(uri);
	}

	/**
	 * Clear all decorations (call before refresh).
	 */
	clearAll(): void {
		const uris = Array.from(this.decorations.keys()).map((s) => vscode.Uri.parse(s));
		this.decorations.clear();
		if (uris.length > 0) {
			this._onDidChange.fire(uris);
		}
	}

	provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
		const status = this.decorations.get(uri.toString());
		if (status === undefined) {
			return undefined;
		}

		const display = getStatusDisplay(status);
		return {
			badge: display.letter,
			color: display.color,
			tooltip: display.tooltip,
		};
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}
