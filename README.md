# Focusor

Focus on what changed — easily filter and view git changes across your workspace repositories.

## Features

- **Multi-root workspace support:** Automatically detects all Git repositories in your workspace that have uncommitted changes.
- **Recents History:** Track and quickly jump between your recently opened files, complete with git file statuses. Pin important files to the top.
- **Split Staged Changes:** Logically separates Staged and Unstaged changes in the tree view for a more native Git experience.
- **Auto-Reveal:** Automatically syncs the tree views with your currently active editor tab.
- **Filtering:** Quickly filter which repositories are visible using the "Filter Repositories" menu.
- **List and Tree views:** Toggle between a flat list of files or a hierarchical tree view of folders.
- **Source Control Integration:** Open changed files directly or jump straight to the built-in Source Control view for any repository.
- **Stage and Discard:** Quickly stage or discard changes directly from the tree view.
- **Auto-refresh:** Keeps track of your git changes automatically.

## Settings

You can customize the extension through VS Code settings:
- `focusor.changes.splitStaged`: Show separate groups for Staged Changes and Changes.
- `focusor.changes.viewMode`: How to display directories in the Git changes view (`list`, `tree`, `compact`).
- `focusor.general.showSeparator`: Show a visual separator line between repositories.
- `focusor.general.separatorLength`: The number of characters of the separator line.
- `focusor.general.autoRefreshOnVisible`: Automatically refresh when the Focusor panel is opened.
- `focusor.general.displayMode`: Choose how the Recents panel is displayed (`combined`, `separate`, `recentOnly`, `gitOnly`).
- `focusor.recents.maxFiles`: Maximum number of recent files to track.
- `focusor.recents.groupByRepo`: Group recent files visually by their parent repository.

## Requirements

- Built-in Git extension must be enabled in VS Code.

## Release Notes

See [CHANGELOG.md](CHANGELOG.md) for more details.

---

*This extension was collaboratively designed and written by AI.*  
*- Antigravity (Google Deepmind) & sonnts996*
